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
  PIPELINE_LABEL_PREFIXES,
  resolveAgentsRepoRoot,
  resolvePyrycodeRepoRoot,
  isPipelineLabel,
  shouldSkipDispatch,
  extractReworkTarget,
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
