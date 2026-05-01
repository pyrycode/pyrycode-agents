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
  shouldAutoCommit,
  shouldUseWorktree,
  findAdvanceRule,
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

  test("In Architecture is gated (architect → developer requires human review)", () => {
    // Locks in the policy decided 2026-05-01 late: the architect's spec
    // and proposed size must be human-reviewed before committing
    // developer tokens. Removing this entry should be a deliberate
    // policy change, not an accident.
    assert.ok(
      MANUAL_ADVANCE_GATES.has("In Architecture"),
      "In Architecture must be in MANUAL_ADVANCE_GATES — architect-to-dev needs human review",
    );
  });

  test("Done is not gated (terminal column needs no further advance)", () => {
    // Done is the last column; gating it does nothing useful. Sanity check.
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
  type Item = { id: string; issueNumber: number; labels: string[] };
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

  test("oldest issueNumber advances first regardless of input order", () => {
    // GitHub's GraphQL `items(first: N)` does not document a stable order.
    // The PO-split-with-sibling-dependency case (child B's architect needs
    // child A's shipped code on main) requires deterministic "oldest first"
    // selection. Insert #29 before #28 to prove the function sorts by
    // issueNumber, not by insertion order.
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
    assert.equal(d.advances[0].issueNumber, 28);
    assert.deepEqual(d.backlogHeld, [29]);
  });

  test("backlogHeld is also sorted (oldest-first reporting)", () => {
    // For consistency with the advance order: when multiple items are
    // held, list them oldest first so heartbeat output is stable.
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
    assert.equal(d.advances[0].issueNumber, 28);
    // Held list: 30, 31 (in ascending order, NOT in input order [31, 30]).
    assert.deepEqual(d.backlogHeld, [30, 31]);
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

  test("In Architecture is gated → no advance, gatedAwaiting populated", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
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
  type Item = { id: string; issueNumber: number; labels: string[] };
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

  test("self-loop (needs-rework:architect in In Architecture) → no route", () => {
    // Routing to the same column is a no-op; the agent's already there.
    // The dispatcher handles re-dispatch via shouldSkipDispatch.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:architect"],
      }]]),
    );
    assert.deepEqual(r, []);
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
