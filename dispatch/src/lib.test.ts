// Unit tests for the pure logic the dispatcher depends on. Run with:
//
//   pnpm test
//
// or directly:
//
//   pnpm exec tsx --test src/lib.test.ts
//
// These tests cover the parts that broke in real life or could break
// silently in the future (path resolution, label parsing, the auto-advance
// chain, agent column consistency). Side-effecting code (GraphQL, gh CLI,
// claude subprocess, worktree management) is not tested here — the
// validation ticket is the integration check for that surface.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENTS } from "./types.js";
import {
  AUTO_ADVANCE_RULES,
  AGENT_COLUMN_MAP,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  PIPELINE_LABEL_PREFIXES,
  resolveAgentsRepoRoot,
  resolvePyrycodeRepoRoot,
  isPipelineLabel,
  shouldSkipDispatch,
  extractReworkTarget,
  isPipelineInFlight,
  decideAutoAdvance,
  decideReworkRoutes,
  decideDoneCleanup,
  shouldAutoCommit,
  shouldUseWorktree,
  hasOpenBlockers,
  shouldSkipBlockedFor,
  extractReworkCount,
  REWORK_LOOP_THRESHOLD,
  findAdvanceRule,
  maxTurnsFor,
} from "./lib.js";

describe("resolveAgentsRepoRoot", () => {
  test("resolves to agents/ from agents/dispatch/src/ (the bug from c72adb4)", () => {
    // The original bug used "../../.." and landed at the parent of agents/
    // (the pyrycode/ Go repo). The fix is "../..". Lock it in.
    const got = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src");
    assert.equal(got, "/work/pyrycode/agents");
  });

  test("normalizes trailing slashes", () => {
    const got = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src/");
    assert.equal(got, "/work/pyrycode/agents");
  });
});

describe("resolvePyrycodeRepoRoot", () => {
  test("resolves to the parent of agents/ — the pyrycode Go repo", () => {
    // agents/ lives INSIDE pyrycode/, so pyrycode root = parent of agents/.
    // The original code had `agentsRepoRoot + "../pyrycode"`, which only
    // "worked" when agentsRepoRoot was buggy and pointed at pyrycode/.
    // Once that bug was fixed, this one surfaced — pyrycode/pyrycode/
    // doesn't exist. Lock the corrected derivation in.
    const got = resolvePyrycodeRepoRoot("/work/pyrycode/agents");
    assert.equal(got, "/work/pyrycode");
  });

  test("composes correctly with resolveAgentsRepoRoot", () => {
    // End-to-end: from a hypothetical src/ directory, the pair of
    // resolvers should land back at the pyrycode root.
    const agentsRoot = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src");
    const pyrycodeRoot = resolvePyrycodeRepoRoot(agentsRoot);
    assert.equal(pyrycodeRoot, "/work/pyrycode");
  });
});

describe("isPipelineLabel", () => {
  test("matches all four pipeline prefixes", () => {
    assert.equal(isPipelineLabel("ready:po"), true);
    assert.equal(isPipelineLabel("needs-rework:developer"), true);
    assert.equal(isPipelineLabel("wip:architect"), true);
    assert.equal(isPipelineLabel("error:code-review"), true);
  });

  test("rejects non-pipeline labels", () => {
    assert.equal(isPipelineLabel("size:s"), false);
    assert.equal(isPipelineLabel("enhancement"), false);
    assert.equal(isPipelineLabel("bug"), false);
    assert.equal(isPipelineLabel(""), false);
  });

  test("rejects legacy labels that look pipeline-ish but aren't", () => {
    // The old labels existed before the per-agent prefix scheme.
    assert.equal(isPipelineLabel("ready-for-review"), false);
    assert.equal(isPipelineLabel("needs-rework"), false);
  });
});

describe("shouldSkipDispatch", () => {
  test("skips when ANY of the four prefixes is set for the same agent", () => {
    for (const prefix of PIPELINE_LABEL_PREFIXES) {
      assert.equal(
        shouldSkipDispatch([`${prefix}developer`], "developer"),
        true,
        `should skip on ${prefix}developer for agent developer`,
      );
    }
  });

  test("does NOT skip when only OTHER agents' labels are present", () => {
    // The bug this guards against: stripping all pipeline labels would
    // skip dispatch even for agents that haven't run yet.
    assert.equal(
      shouldSkipDispatch(["ready:po", "ready:architect", "wip:developer"], "code-review"),
      false,
    );
  });

  test("does NOT skip on empty labels", () => {
    assert.equal(shouldSkipDispatch([], "developer"), false);
  });

  test("does NOT skip on non-pipeline labels", () => {
    assert.equal(shouldSkipDispatch(["enhancement", "size:m"], "developer"), false);
  });

  test("matches every agent in AGENTS without panicking on hyphens", () => {
    // 'code-review' has a hyphen — make sure prefix concatenation works.
    for (const agent of AGENTS) {
      assert.equal(shouldSkipDispatch([`ready:${agent.name}`], agent.name), true);
      assert.equal(shouldSkipDispatch([], agent.name), false);
    }
  });
});

describe("extractReworkTarget", () => {
  test("extracts agent name from valid rework labels", () => {
    assert.equal(extractReworkTarget("needs-rework:po"), "po");
    assert.equal(extractReworkTarget("needs-rework:architect"), "architect");
    assert.equal(extractReworkTarget("needs-rework:code-review"), "code-review");
    assert.equal(extractReworkTarget("needs-rework:documentation"), "documentation");
  });

  test("returns null for non-rework labels", () => {
    assert.equal(extractReworkTarget("ready:po"), null);
    assert.equal(extractReworkTarget("wip:developer"), null);
    assert.equal(extractReworkTarget("size:s"), null);
    assert.equal(extractReworkTarget(""), null);
  });

  test("returns null for the malformed empty-target form", () => {
    // Someone could type just `needs-rework:` without a target. Should
    // not silently succeed with an empty agent name.
    assert.equal(extractReworkTarget("needs-rework:"), null);
  });

  test("does NOT match the legacy 'needs-rework' label (no colon)", () => {
    // The pre-prefix legacy label is stripped separately in pollLoop.
    assert.equal(extractReworkTarget("needs-rework"), null);
  });
});

describe("AUTO_ADVANCE_RULES", () => {
  test("first rule starts at Backlog, last rule ends at Done", () => {
    assert.equal(AUTO_ADVANCE_RULES[0].from, "Backlog");
    assert.equal(AUTO_ADVANCE_RULES[AUTO_ADVANCE_RULES.length - 1].to, "Done");
  });

  test("Inbox is human-gated — no auto-advance rule references it", () => {
    // Inbox is the human's column: anyone can create issues there, but no
    // agent operates on Inbox tickets. Promotion to Backlog is a manual
    // gesture (status edit). This test locks in the invariant.
    for (const rule of AUTO_ADVANCE_RULES) {
      assert.notEqual(
        rule.from,
        "Inbox",
        `rule ${rule.readyLabel}: from must not be "Inbox" (human-gated column)`,
      );
      assert.notEqual(
        rule.to,
        "Inbox",
        `rule ${rule.readyLabel}: to must not be "Inbox" (PO demotes via direct status edit, not auto-advance)`,
      );
    }
  });

  test("chain has no gaps (each rule's `to` matches the next rule's `from`)", () => {
    // If a refactor splits a column or renames it, this catches the drift.
    for (let i = 0; i < AUTO_ADVANCE_RULES.length - 1; i++) {
      assert.equal(
        AUTO_ADVANCE_RULES[i].to,
        AUTO_ADVANCE_RULES[i + 1].from,
        `rule ${i} ends at ${AUTO_ADVANCE_RULES[i].to} but rule ${i + 1} starts at ${AUTO_ADVANCE_RULES[i + 1].from}`,
      );
    }
  });

  test("every readyLabel matches a known agent", () => {
    const knownAgents = new Set(AGENTS.map((a) => a.name));
    for (const rule of AUTO_ADVANCE_RULES) {
      const agentName = rule.readyLabel.replace("ready:", "");
      assert.ok(
        knownAgents.has(agentName),
        `rule readyLabel ${rule.readyLabel} references unknown agent ${agentName}`,
      );
    }
  });

  test("each rule's `from` column is owned by its readyLabel's agent", () => {
    // The `from` column should be the column of the agent whose `ready:`
    // label triggers the advance — i.e. PO's column is Backlog, architect's
    // is In Architecture, etc.
    for (const rule of AUTO_ADVANCE_RULES) {
      const agentName = rule.readyLabel.replace("ready:", "");
      const expectedColumn = AGENT_COLUMN_MAP.get(agentName);
      assert.equal(
        rule.from,
        expectedColumn,
        `rule ${rule.readyLabel} should advance from agent's column (${expectedColumn}), got ${rule.from}`,
      );
    }
  });

  test("five rules — one per agent (no missing or extra stages)", () => {
    assert.equal(AUTO_ADVANCE_RULES.length, AGENTS.length);
  });
});

describe("MANUAL_ADVANCE_GATES", () => {
  test("every gated column is a known `from` in AUTO_ADVANCE_RULES", () => {
    // A gate on a column that doesn't appear in AUTO_ADVANCE_RULES is
    // dead config — the auto-advance loop never iterates over it, so
    // the gate has no effect. Catch that drift here.
    const knownFromColumns = new Set(AUTO_ADVANCE_RULES.map(r => r.from));
    for (const gated of MANUAL_ADVANCE_GATES) {
      assert.ok(
        knownFromColumns.has(gated),
        `MANUAL_ADVANCE_GATES references "${gated}" but no AUTO_ADVANCE_RULES rule has that as a "from" column`,
      );
    }
  });

  test("currently no gates — pipeline runs end-to-end without forced human pauses (2026-05-02)", () => {
    // The architect → developer human gate was added on 2026-05-01 as a
    // safety net for oversized specs, then removed on 2026-05-02 once
    // the size policy was enforced in code (architect either sizes ≤M
    // or splits via needs-rework:po). The gate was duplicating safeguards.
    //
    // Adding a future gate is a deliberate policy decision and should
    // require updating this test. The set is the durable record of
    // "what's gated right now"; emptiness is meaningful.
    assert.equal(MANUAL_ADVANCE_GATES.size, 0);
  });

  test("Done is not gated (terminal column needs no further advance)", () => {
    // Sanity check: even if a future policy adds a gate, Done shouldn't
    // be in the set — gating a terminal column does nothing.
    assert.ok(!MANUAL_ADVANCE_GATES.has("Done"));
  });
});

describe("MID_PIPELINE_COLUMNS", () => {
  test("excludes Inbox, Backlog, Done", () => {
    // Mid-pipeline = "in flight." Inbox and Backlog are pre-flight,
    // Done is post-flight. Locks the WIP=1 pipeline rule's intent.
    for (const off of ["Inbox", "Backlog", "Done"]) {
      assert.ok(
        !MID_PIPELINE_COLUMNS.includes(off),
        `MID_PIPELINE_COLUMNS must not include "${off}"`,
      );
    }
  });

  test("every entry is a known agent column", () => {
    // A column in MID_PIPELINE_COLUMNS that no agent owns is dead config.
    const agentColumns = new Set(AGENT_COLUMN_MAP.values());
    for (const col of MID_PIPELINE_COLUMNS) {
      assert.ok(
        agentColumns.has(col),
        `MID_PIPELINE_COLUMNS references "${col}" but no agent owns it`,
      );
    }
  });

  test("contains every non-PO agent column", () => {
    // The strict WIP=1 rule holds Backlog (PO's column) when any other
    // agent's column has work. So every non-PO agent column must be in
    // MID_PIPELINE_COLUMNS for the rule to bite uniformly.
    for (const [name, col] of AGENT_COLUMN_MAP) {
      if (name === "po") continue; // PO owns Backlog, which is pre-flight
      assert.ok(
        MID_PIPELINE_COLUMNS.includes(col),
        `${name}'s column "${col}" should be in MID_PIPELINE_COLUMNS`,
      );
    }
  });
});

describe("isPipelineInFlight", () => {
  test("empty input → not in flight", () => {
    // Pristine pipeline. Backlog should be free to advance.
    assert.equal(isPipelineInFlight([]), false);
  });

  test("any non-errored ticket counts as in flight", () => {
    // The most common case: a ticket actively progressing.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 28, labels: ["size:s", "ready:architect"] }]),
      true,
    );
  });

  test("ticket with no labels still counts (just-arrived in column)", () => {
    // A ticket that just got promoted to a mid-pipeline column may have
    // had its agent labels stripped by the dispatch loop. It's still in
    // flight — about to be dispatched on.
    assert.equal(isPipelineInFlight([{ issueNumber: 42, labels: [] }]), true);
  });

  test("error-labelled ticket does NOT count", () => {
    // Errored tickets are stuck on exceptional human action. Unrelated
    // work shouldn't be blocked behind them.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 99, labels: ["error:developer"] }]),
      false,
    );
  });

  test("any error: prefix excludes (not just specific agents)", () => {
    // Confirms the prefix-match approach. error:parked, error:human-blocked,
    // and any future variant should all park the ticket.
    for (const variant of ["error:po", "error:parked", "error:human-blocked"]) {
      assert.equal(
        isPipelineInFlight([{ issueNumber: 99, labels: [variant] }]),
        false,
        `${variant} should exclude from in-flight`,
      );
    }
  });

  test("mixed: errored + non-errored → in flight", () => {
    // If even one non-errored ticket is mid-pipeline, hold Backlog.
    // The errored one is parked; the other one is real work.
    assert.equal(
      isPipelineInFlight([
        { issueNumber: 99, labels: ["error:developer"] },
        { issueNumber: 28, labels: ["ready:architect"] },
      ]),
      true,
    );
  });

  test("non-issue items (issueNumber <= 0) are ignored", () => {
    // Project items without an issue (drafts, epics) shouldn't trigger
    // the WIP gate. Locks the issueNumber > 0 guard.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 0, labels: [] }]),
      false,
    );
    assert.equal(
      isPipelineInFlight([{ issueNumber: -1, labels: ["ready:po"] }]),
      false,
    );
  });

  test("all errored → not in flight", () => {
    // Pipeline full of stuck tickets. New work should be allowed in.
    assert.equal(
      isPipelineInFlight([
        { issueNumber: 99, labels: ["error:developer"] },
        { issueNumber: 100, labels: ["error:parked"] },
      ]),
      false,
    );
  });
});

describe("decideAutoAdvance", () => {
  // Helper to build the itemsByColumn map ergonomically.
  type Item = { id: string; issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("empty pipeline → no advances, no holds, no gates", () => {
    const d = decideAutoAdvance(AUTO_ADVANCE_RULES, MANUAL_ADVANCE_GATES, items(), false);
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, []);
    assert.deepEqual(d.gatedAwaiting, []);
  });

  test("single ready:po in Backlog, pipeline empty → advance to In Architecture", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "size:s"] }]]),
      false,
    );
    assert.equal(d.advances.length, 1);
    assert.deepEqual(d.advances[0], {
      itemId: "i1",
      issueNumber: 28,
      fromColumn: "Backlog",
      toColumn: "In Architecture",
    });
    assert.deepEqual(d.backlogHeld, []);
  });

  test("two ready:po in Backlog, pipeline empty → first advances, second held (WIP=1 within-cycle)", () => {
    // This is the bug from b39f569 — without the within-cycle stop,
    // both #28 and #29 would have advanced in the same cycle.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po", "size:s"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po", "size:s"] },
      ]]),
      false,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 28);
    assert.deepEqual(d.backlogHeld, [29]);
  });

  test("Backlog advance picks the first eligible item from input order", () => {
    // The pure function trusts the caller's input order. The caller
    // (`runAutoAdvance`) queries GraphQL with `orderBy: { field: POSITION,
    // direction: ASC }`, which returns items in board-position order
    // (top of column first). Manual board reordering by humans is the
    // priority signal — we respect it.
    //
    // Insert #29 ahead of #28 to prove the function takes input order
    // verbatim, NOT issueNumber. The earlier "sort by issueNumber" rule
    // (3abe7a3) was wrong: it ignored the user's manual board ordering.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
      ]]),
      false,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 29);
    assert.deepEqual(d.backlogHeld, [28]);
  });

  test("backlogHeld preserves input order (board POSITION)", () => {
    // When multiple items are held, the held list is in input order
    // (which is board POSITION from the GraphQL query). Heartbeat output
    // matches what the user sees on the project board top-to-bottom.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i3", issueNumber: 31, labels: ["ready:po"] },
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 30, labels: ["ready:po"] },
      ]]),
      false,
    );
    // First eligible (input order) = #31; held = [#28, #30] in input order
    // (NOT [28, 30, 31] sorted, NOT [31, 30, 28] reversed).
    assert.equal(d.advances[0].issueNumber, 31);
    assert.deepEqual(d.backlogHeld, [28, 30]);
  });

  test("ready:po in Backlog while pipeline already in flight → all held, no advance", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 29, labels: ["ready:po"] }]]),
      true,
    );
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, [29]);
  });

  test("gated column skips advance and reports in gatedAwaiting (mechanism test)", () => {
    // Tests the GATING MECHANISM independent of which columns are
    // currently gated in production. Production MANUAL_ADVANCE_GATES is
    // empty as of 2026-05-02 (the architect→developer gate was removed
    // once the size policy was enforced in code). Pass a custom set so
    // this test still exercises the function's gating behaviour even
    // when production policy doesn't gate anything.
    const customGates: ReadonlySet<string> = new Set(["In Architecture"]);
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      customGates,
      items(["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["ready:architect"] }]]),
      true,
    );
    assert.deepEqual(d.advances, []);
    assert.equal(d.gatedAwaiting.length, 1);
    assert.equal(d.gatedAwaiting[0].column, "In Architecture");
    assert.deepEqual(d.gatedAwaiting[0].itemNumbers, [28]);
  });

  test("needs-rework label blocks advance even with ready:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "needs-rework:po"] }]]),
      false,
    );
    assert.deepEqual(d.advances, []);
  });

  test("error label blocks advance even with ready:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "error:po"] }]]),
      false,
    );
    assert.deepEqual(d.advances, []);
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 0, labels: ["ready:po"] }]]),
      false,
    );
    assert.deepEqual(d.advances, []);
  });

  test("missing readyLabel → no advance", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["size:s"] }]]),
      false,
    );
    assert.deepEqual(d.advances, []);
  });

  test("mid-pipeline advance proceeds even when pipeline in-flight", () => {
    // A ticket sitting in In Development with ready:developer should advance
    // to In Code Review even though another ticket is gated at In Architecture.
    // WIP=1 holds NEW tickets out; in-flight tickets keep flowing forward.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(
        ["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["ready:architect"] }]],
        ["In Development",  [{ id: "i2", issueNumber: 30, labels: ["ready:developer"] }]],
      ),
      true,
    );
    const devAdvance = d.advances.find(a => a.fromColumn === "In Development");
    assert.ok(devAdvance, "expected an advance from In Development");
    assert.equal(devAdvance!.issueNumber, 30);
    assert.equal(devAdvance!.toColumn, "In Code Review");
  });

  test("blocked Backlog item does not auto-advance (stays in Backlog until unblocked)", () => {
    // A blocked ticket can be PO-refined (ready:po set) but should not
    // auto-advance to In Architecture while blockers are open. Keeps
    // the board state honest: blocked tickets stay in the queue, not
    // the architect's column.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{
        id: "i1",
        issueNumber: 45,
        labels: ["ready:po", "size:s"],
        blockedBy: [{ number: 40, state: "OPEN" }],
      }]]),
      false,
    );
    assert.deepEqual(d.advances, []);
  });

  test("CLOSED-only blockers don't prevent advance (dependencies satisfied)", () => {
    // Once the blocker closes, the ticket is free to advance. Locks
    // the "any-OPEN-blocker holds" semantic.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{
        id: "i1",
        issueNumber: 45,
        labels: ["ready:po", "size:s"],
        blockedBy: [{ number: 40, state: "CLOSED" }],
      }]]),
      false,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 45);
  });

  test("multiple mid-pipeline advances in one decision", () => {
    // Unusual but possible: dev finishes ticket X, code-review finishes ticket Y,
    // both ready in same cycle. Both should advance.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(
        ["In Development", [{ id: "i1", issueNumber: 30, labels: ["ready:developer"] }]],
        ["In Code Review", [{ id: "i2", issueNumber: 31, labels: ["ready:code-review"] }]],
      ),
      true,
    );
    assert.equal(d.advances.length, 2);
    assert.ok(d.advances.some(a => a.issueNumber === 30 && a.toColumn === "In Code Review"));
    assert.ok(d.advances.some(a => a.issueNumber === 31 && a.toColumn === "In Documentation"));
  });
});

describe("decideReworkRoutes", () => {
  type Item = { id: string; issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("empty pipeline → no routes", () => {
    const r = decideReworkRoutes(AGENT_COLUMN_MAP, items());
    assert.deepEqual(r, []);
  });

  test("needs-rework:po in In Architecture → route to Backlog", () => {
    // The case from #27 today: architect-detected oversize sent back to PO.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["ready:architect", "size:m", "needs-rework:po"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].issueNumber, 27);
    assert.equal(r[0].fromColumn, "In Architecture");
    assert.equal(r[0].toColumn, "Backlog");
    assert.equal(r[0].triggerLabel, "needs-rework:po");
  });

  test("same-column case (needs-rework:architect in In Architecture) → strip-only route", () => {
    // Earlier versions skipped same-column cases as "self-loops," but that
    // left the rework label permanently on the item — and shouldSkipDispatch
    // permanently blocked agent dispatch as a result. Now we DO emit a
    // route; the caller's updateItemStatus is a no-op for same-column,
    // but the label-strip + rework-count bump still happen, which is what
    // unblocks dispatch. Surfaced as Pyrycode #59 broader bug 2026-05-02.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:architect"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].itemId, "i1");
    assert.equal(r[0].fromColumn, "In Architecture");
    assert.equal(r[0].toColumn, "In Architecture");
    assert.equal(r[0].triggerLabel, "needs-rework:architect");
    assert.deepEqual(r[0].labelsToStrip, ["needs-rework:architect"]);
  });

  test("same-column case for PO in Backlog → strip-only route", () => {
    // The exact scenario from #45 in 2026-05-02: ticket manually moved to
    // Backlog with needs-rework:po set. Without this route, PO dispatch
    // was permanently blocked.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["Backlog", [{
        id: "i45",
        issueNumber: 45,
        labels: ["needs-rework:po", "size:s"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].fromColumn, "Backlog");
    assert.equal(r[0].toColumn, "Backlog");
    assert.equal(r[0].triggerLabel, "needs-rework:po");
    // size:s is not a state-prefix label; should NOT be stripped.
    assert.deepEqual(r[0].labelsToStrip, ["needs-rework:po"]);
  });

  test("rework label strips ready:/error:/wip: along with itself", () => {
    // The dispatcher cleans up stale state-prefix labels on rework so the
    // ticket arrives in the target column with a clean slate. Lock that.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["ready:architect", "wip:architect", "error:architect", "needs-rework:po", "size:m"],
      }]]),
    );
    assert.equal(r.length, 1);
    const stripped = new Set(r[0].labelsToStrip);
    assert.ok(stripped.has("needs-rework:po"));
    assert.ok(stripped.has("ready:architect"));
    assert.ok(stripped.has("wip:architect"));
    assert.ok(stripped.has("error:architect"));
    // Non-state labels survive
    assert.ok(!stripped.has("size:m"));
  });

  test("malformed needs-rework: (no target) → no route", () => {
    // extractReworkTarget returns null for bare "needs-rework:" — guards
    // against typos producing accidental routes.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("unknown rework target → no route", () => {
    // needs-rework:designer when designer isn't an agent → no targetColumn.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:designer"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 0,
        labels: ["needs-rework:po"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("multiple needs-rework labels on one item → first valid route wins", () => {
    // Pathological case: two rework labels. We route on the first valid one
    // (label order in the array). Keeps the function deterministic.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 50,
        labels: ["needs-rework:developer", "needs-rework:po"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].triggerLabel, "needs-rework:developer");
    assert.equal(r[0].toColumn, "In Development");
  });
});

describe("decideDoneCleanup", () => {
  type Item = { id: string; issueNumber: number; labels: string[] };

  test("empty Done column → no cleanups", () => {
    const c = decideDoneCleanup([]);
    assert.deepEqual(c, []);
  });

  test("ticket with ready:documentation → strip it", () => {
    // The reported bug: ready:documentation persists on tickets that flow
    // into Done via runAutoAdvance. The auto-merge path strips pipeline
    // labels, but only when a PR exists. Doc-only tickets, manually-merged
    // PRs, and closed-as-won't-fix never get cleaned without this pass.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.equal(c[0].itemId, "i1");
    assert.equal(c[0].issueNumber, 21);
    assert.deepEqual(c[0].labelsToStrip, ["ready:documentation"]);
  });

  test("accumulated ready:* labels from full pipeline run → strip all", () => {
    // A ticket that flowed through every agent accumulates a ready:<agent>
    // for each. None get stripped between columns. Lock in that all five
    // come off when the ticket reaches Done.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: [
        "ready:po",
        "ready:architect",
        "ready:developer",
        "ready:code-review",
        "ready:documentation",
      ],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("ready:po"));
    assert.ok(stripped.has("ready:architect"));
    assert.ok(stripped.has("ready:developer"));
    assert.ok(stripped.has("ready:code-review"));
    assert.ok(stripped.has("ready:documentation"));
    assert.equal(c[0].labelsToStrip.length, 5);
  });

  test("non-pipeline labels (size:, priority:, custom tags) survive", () => {
    // The cleanup is targeted at pipeline-state labels only. PO sizing,
    // priority, and any free-form tags (release notes, area:, etc.) must
    // not be touched.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation", "size:s", "priority:normal", "area:dispatcher"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].labelsToStrip, ["ready:documentation"]);
  });

  test("wip:/error:/needs-rework: also stripped on Done", () => {
    // A ticket can reach Done via the closed-sweep path (e.g. user
    // closes a won't-fix while it had wip:developer set, or the ticket
    // had needs-rework:po set when it got closed manually). These are
    // pipeline state, same family as ready:*, and need cleanup too.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["wip:developer", "error:architect", "needs-rework:po", "size:s"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("wip:developer"));
    assert.ok(stripped.has("error:architect"));
    assert.ok(stripped.has("needs-rework:po"));
    assert.ok(!stripped.has("size:s"));
  });

  test("rework-count:N is stripped along with pipeline labels", () => {
    // rework-count: isn't in PIPELINE_LABEL_PREFIXES (it's a counter,
    // not a state label), but it IS pipeline state. Cleaning it on Done
    // means the counter resets if the ticket ever re-opens — otherwise a
    // re-opened ticket would carry stale rework-count and could trip
    // REWORK_LOOP_THRESHOLD prematurely.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation", "rework-count:2"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("ready:documentation"));
    assert.ok(stripped.has("rework-count:2"));
  });

  test("idempotent: ticket with no pipeline labels → no cleanup entry", () => {
    // Cleanup runs every poll cycle; the second run on a ticket already
    // cleaned in cycle 1 must be a no-op (no entry in the result), not a
    // wasted GraphQL removeLabel call. Caller iterates over the result;
    // empty result == zero work.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["size:s", "priority:normal"],
    }];
    const c = decideDoneCleanup(items);
    assert.deepEqual(c, []);
  });

  test("multiple Done items handled independently", () => {
    // Done holds many tickets over time. Cleanup must scan each
    // independently and emit one entry per ticket that needs work.
    const items: Item[] = [
      { id: "i1", issueNumber: 21, labels: ["ready:documentation"] },
      { id: "i2", issueNumber: 22, labels: ["size:s"] }, // already clean
      { id: "i3", issueNumber: 23, labels: ["wip:developer", "rework-count:1"] },
    ];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 2);
    const byNumber = new Map(c.map(e => [e.issueNumber, e]));
    assert.deepEqual(byNumber.get(21)!.labelsToStrip, ["ready:documentation"]);
    const stripped3 = new Set(byNumber.get(23)!.labelsToStrip);
    assert.ok(stripped3.has("wip:developer"));
    assert.ok(stripped3.has("rework-count:1"));
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    // Mirrors decideReworkRoutes — epics or virtual items with
    // issueNumber <= 0 don't have a real GitHub issue to label-edit.
    const items: Item[] = [{
      id: "i0",
      issueNumber: 0,
      labels: ["ready:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.deepEqual(c, []);
  });
});

describe("shouldSkipBlockedFor", () => {
  test("PO is allowed on blocked tickets — refinement is cheap prep work", () => {
    // PO refines the body shape (user story, AC, size). It doesn't
    // depend on the blocker's implementation. Allowing PO to refine
    // in advance means the ticket is ready to flow the moment the
    // blocker resolves — no PO delay added on top of blocker wait.
    assert.equal(
      shouldSkipBlockedFor("po", [{ number: 40, state: "OPEN" }]),
      false,
    );
  });

  test("non-PO agents skip blocked tickets — they need the blocker's API", () => {
    // Architect designs against the actual code. Developer implements
    // against types that must exist on main. Code-review reads the PR
    // diff. Documentation reads the merged feature. None can do their
    // job until the blocker lands.
    for (const agent of ["architect", "developer", "code-review", "documentation"]) {
      assert.equal(
        shouldSkipBlockedFor(agent, [{ number: 40, state: "OPEN" }]),
        true,
        `${agent} should skip blocked tickets`,
      );
    }
  });

  test("any agent + no blockers → not skipped", () => {
    for (const agent of ["po", "architect", "developer", "code-review", "documentation"]) {
      assert.equal(shouldSkipBlockedFor(agent, []), false);
    }
  });

  test("non-PO agent + all-CLOSED blockers → not skipped (dependencies satisfied)", () => {
    assert.equal(
      shouldSkipBlockedFor("architect", [{ number: 40, state: "CLOSED" }]),
      false,
    );
  });
});

describe("extractReworkCount", () => {
  test("empty labels → 0", () => {
    assert.equal(extractReworkCount([]), 0);
  });

  test("no rework-count label → 0", () => {
    assert.equal(extractReworkCount(["size:s", "ready:po"]), 0);
  });

  test("single rework-count:2 → 2", () => {
    assert.equal(extractReworkCount(["size:s", "rework-count:2", "ready:po"]), 2);
  });

  test("rework-count:0 → 0 (legitimate zero, not a missing label)", () => {
    // Edge case: a ticket may explicitly carry rework-count:0 if the
    // counter was reset. Don't conflate with "no label present" in tests.
    assert.equal(extractReworkCount(["rework-count:0"]), 0);
  });

  test("malformed rework-count → 0", () => {
    // Defensively tolerate garbage. Don't crash on a typo'd label.
    assert.equal(extractReworkCount(["rework-count:abc"]), 0);
    assert.equal(extractReworkCount(["rework-count:"]), 0);
  });

  test("multiple rework-count labels → max wins", () => {
    // Pathological state — shouldn't happen in normal operation, but
    // if it does, bias toward halting (max is safer than min). The
    // worst-case rework count is the truthful one.
    assert.equal(
      extractReworkCount(["rework-count:1", "rework-count:3", "rework-count:2"]),
      3,
    );
  });

  test("negative rework-count → 0 (treated as invalid)", () => {
    assert.equal(extractReworkCount(["rework-count:-1"]), 0);
  });

  test("REWORK_LOOP_THRESHOLD is 3 (locked default)", () => {
    // Adjusting the threshold is a deliberate policy change. This test
    // makes the default explicit and forces an update to the test if
    // the constant changes — discussion-required, not silent drift.
    assert.equal(REWORK_LOOP_THRESHOLD, 3);
  });
});

describe("hasOpenBlockers", () => {
  test("no blockers → false (ticket is not dependency-blocked)", () => {
    assert.equal(hasOpenBlockers([]), false);
  });

  test("all blockers CLOSED → false (dependencies satisfied)", () => {
    // Once a blocker issue closes, the dependency is satisfied and the
    // ticket can flow. Mirrors GitHub's `issueDependenciesSummary` model:
    // completed dependencies don't gate progression.
    assert.equal(
      hasOpenBlockers([
        { number: 100, state: "CLOSED" },
        { number: 101, state: "CLOSED" },
      ]),
      false,
    );
  });

  test("any OPEN blocker → true (mixed CLOSED + OPEN)", () => {
    // Even one open blocker holds the ticket. Locks the "blocked"
    // semantic: ALL blockers must close before the ticket flows.
    assert.equal(
      hasOpenBlockers([
        { number: 100, state: "CLOSED" },
        { number: 101, state: "OPEN" },
      ]),
      true,
    );
  });

  test("single OPEN blocker → true", () => {
    // The Pyrycode #41 case: blocked by #40, which is OPEN. Skip dispatch.
    assert.equal(
      hasOpenBlockers([{ number: 40, state: "OPEN" }]),
      true,
    );
  });
});

describe("shouldUseWorktree", () => {
  test("PO does not use a worktree (operates on issue body via gh)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(shouldUseWorktree(po), false);
  });

  test("architect uses a worktree (writes spec to docs/specs/architecture/)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldUseWorktree(arch), true);
  });

  test("developer uses a worktree (writes code + tests)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldUseWorktree(dev), true);
  });

  test("code-review uses a worktree (reads code locally to review)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(shouldUseWorktree(cr), true);
  });

  test("documentation uses a worktree (writes to docs/)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(shouldUseWorktree(docs), true);
  });

  test("every AgentConfig declares usesWorktree explicitly", () => {
    // Adding a new agent must force an explicit decision about whether
    // it operates on the working tree. No implicit defaults — the policy
    // is declarative on the agent record. This locks in the rule that
    // bit us on #27 (PO's hardcoded `if (agent.name === "po")` was the
    // only place the policy lived; missing it for a new agent would
    // silently default to "uses worktree" with cosmetic push failures).
    for (const agent of AGENTS) {
      assert.equal(
        typeof agent.usesWorktree,
        "boolean",
        `${agent.name} must declare usesWorktree`,
      );
    }
  });
});

describe("maxTurnsFor", () => {
  // Code review runs sub-agents (each consumes turns from the parent
  // budget) and routinely needs the headroom; everyone else gets the
  // base budget. The base bumped from 50 → 60 on 2026-05-02 after #55
  // (and several earlier tickets) hit the 50 cap. Distribution data:
  // 7+ tickets clustered AT 50 turns over the prior 48h, indicating the
  // cap was binding regularly (not just rare clipping). Combined with
  // the architect-spec "Files to read first" rule, 60 should keep the
  // forcing function while reclaiming the long tail of cap-hitters.
  test("code-review gets 100 (runs sub-agents)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(maxTurnsFor(cr), 100);
  });

  test("developer gets 60 (was 50 — bumped 2026-05-02 after #55)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(maxTurnsFor(dev), 60);
  });

  test("architect gets 60 (base budget — sketch + spec)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(maxTurnsFor(arch), 60);
  });

  test("po gets 60 (base budget — issue body refinement)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(maxTurnsFor(po), 60);
  });

  test("documentation gets 60 (base budget — knowledge base writes)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(maxTurnsFor(docs), 60);
  });

  test("unknown agent name still gets the base budget (no implicit zero)", () => {
    // Defensive: a typo or new agent shouldn't silently dispatch with
    // 0 turns. The policy returns the base budget for any non-code-review
    // name; if a future agent needs more, it must be added explicitly.
    assert.equal(maxTurnsFor({ name: "ghost", column: "", claudeMdPath: "", description: "", usesWorktree: false }), 60);
  });
});

describe("shouldAutoCommit", () => {
  test("empty git status → false", () => {
    assert.equal(shouldAutoCommit(""), false);
  });

  test("whitespace-only git status → false", () => {
    // Stripping whitespace is what guards us against an accidental commit
    // when the git status output is just "\n" or trailing spaces.
    assert.equal(shouldAutoCommit("\n"), false);
    assert.equal(shouldAutoCommit("   "), false);
    assert.equal(shouldAutoCommit("\t\n  "), false);
  });

  test("modified file → true", () => {
    assert.equal(shouldAutoCommit(" M docs/specs/architecture/27-foo.md"), true);
  });

  test("untracked file → true", () => {
    assert.equal(shouldAutoCommit("?? new.go"), true);
  });

  test("multiple changes → true", () => {
    assert.equal(
      shouldAutoCommit(" M file1.go\n?? file2.go\nA  file3.go"),
      true,
    );
  });
});

describe("AGENT_COLUMN_MAP", () => {
  test("contains every agent in AGENTS", () => {
    for (const agent of AGENTS) {
      assert.equal(AGENT_COLUMN_MAP.get(agent.name), agent.column);
    }
  });

  test("size matches AGENTS (no duplicate names)", () => {
    assert.equal(AGENT_COLUMN_MAP.size, AGENTS.length);
  });
});

describe("agent claudeMdPath resolution", () => {
  test("paths are relative to agentsRepoRoot, NOT prefixed with 'agents/'", () => {
    // The original paths were "agents/po/CLAUDE.md" etc., which only
    // worked when agentsRepoRoot was buggy and pointed at the parent of
    // agents/. With c72adb4 fixing that, the prefix was now wrong and
    // resolved to agents/agents/po/CLAUDE.md. This test locks in that
    // claudeMdPath is relative to agents/ (the actual root).
    for (const agent of AGENTS) {
      assert.ok(
        !agent.claudeMdPath.startsWith("agents/"),
        `${agent.name}.claudeMdPath should not start with "agents/" (got ${agent.claudeMdPath})`,
      );
    }
  });

  test("each agent's CLAUDE.md actually exists on disk", () => {
    // Belt-and-suspenders. If someone moves a CLAUDE.md without updating
    // types.ts, dispatch fails at runtime with "agent CLAUDE.md not
    // found" — better to catch it in CI.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const agentsRoot = resolve(__dirname, "..", "..");
    for (const agent of AGENTS) {
      const path = resolve(agentsRoot, agent.claudeMdPath);
      assert.ok(
        existsSync(path),
        `${agent.name}.claudeMdPath does not exist on disk: ${path}`,
      );
    }
  });
});

describe("findAdvanceRule", () => {
  test("returns the matching rule for a (column, ready label) pair", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["ready:architect"],
    );
    assert.ok(rule);
    assert.equal(rule.to, "In Development");
  });

  test("returns null when ready label is missing", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["wip:architect"],
    );
    assert.equal(rule, null);
  });

  test("returns null when ready label belongs to a different column", () => {
    // ready:developer in Architecture column — wrong stage.
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["ready:developer"],
    );
    assert.equal(rule, null);
  });

  test("returns null for an unknown column", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "Some Bogus Column",
      ["ready:po"],
    );
    assert.equal(rule, null);
  });

  test("matches every advance step against its rule", () => {
    // Sanity-check: walking the chain end-to-end resolves cleanly.
    for (const rule of AUTO_ADVANCE_RULES) {
      const found = findAdvanceRule(AUTO_ADVANCE_RULES, rule.from, [rule.readyLabel]);
      assert.equal(found, rule);
    }
  });
});

