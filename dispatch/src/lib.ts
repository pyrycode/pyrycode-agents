// Pure helpers and the data the dispatcher's state machine runs on.
//
// Everything in this file is side-effect free: no I/O, no GraphQL, no
// child processes, no clock. That keeps unit tests fast and stable, and
// keeps the testable surface explicit.
//
// Anything that needs to talk to GitHub, the filesystem, claude, or git
// stays in dispatch.ts.

import { resolve } from "node:path";
import { AGENTS, type AgentConfig } from "./types.js";

// --------- Auto-advance rules ---------

export interface AdvanceRule {
  from: string;
  readyLabel: string;
  to: string;
}

// Auto-advance rules: a ticket moves from `from` → `to` when its labels
// include `readyLabel`. The chain must walk every column from Backlog to
// Done with no gaps; the consistency tests in lib.test.ts enforce this.
export const AUTO_ADVANCE_RULES: AdvanceRule[] = [
  { from: "Backlog",            readyLabel: "ready:po",             to: "In Architecture" },
  { from: "In Architecture",    readyLabel: "ready:architect",      to: "In Development" },
  { from: "In Development",     readyLabel: "ready:developer",      to: "In Code Review" },
  { from: "In Code Review",     readyLabel: "ready:code-review",    to: "In Documentation" },
  { from: "In Documentation",   readyLabel: "ready:documentation",  to: "Done" },
];

/**
 * Columns where the dispatcher does NOT auto-advance even when the
 * matching `ready:<agent>` label is present. A human reviews the work
 * in that column and moves the ticket forward manually via the project
 * board (same gesture as Inbox → Backlog promotion).
 *
 * Today: "In Architecture" — the human reviews the architect's spec
 * and judges size before committing developer tokens. Cheaper to catch
 * an oversized or mis-designed spec here than to discover it mid-dev
 * run with the worktree already created and tokens spent.
 *
 * Tickets sit in the gated column with `ready:<agent>` set; the gate
 * just suppresses the auto-advance step. `shouldSkipDispatch` already
 * prevents re-dispatch of an agent that has already added `ready:` for
 * itself, so the ticket is stable.
 */
export const MANUAL_ADVANCE_GATES: ReadonlySet<string> = new Set([
  "In Architecture",
]);

// Built from AGENTS — single source of truth for the name → column mapping.
export const AGENT_COLUMN_MAP: ReadonlyMap<string, string> = new Map(
  AGENTS.map((a: AgentConfig) => [a.name, a.column]),
);

// --------- Path resolution ---------

/**
 * Resolve the agents repo root from a source-file directory.
 *
 * The dispatch source lives at `agents/dispatch/src/`, so `../..` takes us
 * to `agents/`. Anything more would escape into the parent (the
 * `pyrycode/` Go repo) — which is what the original buggy version did
 * with `"../../.."` (commit `c72adb4` fixed it).
 */
export function resolveAgentsRepoRoot(srcDir: string): string {
  return resolve(srcDir, "../..");
}

/**
 * Resolve the pyrycode Go repo root from the agents repo root.
 *
 * `agents/` lives **inside** `pyrycode/` (gitignored there) rather than
 * as a sibling, so the pyrycode root is just the parent of agents/.
 *
 * The original code had `agentsRepoRoot + "../pyrycode"`, which silently
 * "worked" only because `agentsRepoRoot` was *also* buggy and pointed at
 * the pyrycode root. Once that bug was fixed, this one surfaced — first
 * dispatcher run after the fix tried `pyrycode/pyrycode/` and ENOENT'd.
 */
export function resolvePyrycodeRepoRoot(agentsRepoRoot: string): string {
  return resolve(agentsRepoRoot, "..");
}

// --------- Label predicates ---------

// The four label prefixes the dispatcher uses for per-agent state.
//   ready:<agent>        — agent completed successfully
//   needs-rework:<agent> — agent (or another) flagged the ticket back here
//   wip:<agent>          — agent currently running
//   error:<agent>        — agent crashed
export const PIPELINE_LABEL_PREFIXES = [
  "ready:",
  "needs-rework:",
  "wip:",
  "error:",
] as const;

/**
 * True if the given label is one of the dispatcher's pipeline-state labels.
 * Used for stripping stale labels before re-dispatching an agent.
 */
export function isPipelineLabel(label: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * The four-label gate from pollLoop's per-ticket inner loop: a ticket
 * should be skipped from dispatch if any of `ready:<agent>`,
 * `needs-rework:<agent>`, `wip:<agent>`, or `error:<agent>` is present.
 *
 * Returns true to skip (don't dispatch this agent on this ticket).
 * Returns false otherwise (proceed with dispatch).
 *
 * Critically, OTHER agents' labels do NOT cause a skip — only labels
 * scoped to the agent currently being considered.
 */
export function shouldSkipDispatch(labels: string[], agentName: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => labels.includes(p + agentName));
}

// --------- Rework target extraction ---------

/**
 * Parse a `needs-rework:<agent>` label and return the target agent name.
 * Returns null for labels that don't have the prefix or have an empty
 * target (the latter is an unusual but defensible input — e.g. someone
 * typed `needs-rework:` without a target).
 */
export function extractReworkTarget(label: string): string | null {
  const prefix = "needs-rework:";
  if (!label.startsWith(prefix)) return null;
  const target = label.slice(prefix.length);
  return target.length > 0 ? target : null;
}

// --------- Auto-advance rule lookup ---------

/**
 * Find the auto-advance rule that applies given the ticket's current
 * column and labels. Returns null if no rule matches.
 */
export function findAdvanceRule(
  rules: AdvanceRule[],
  fromColumn: string,
  labels: string[],
): AdvanceRule | null {
  return rules.find((r) => r.from === fromColumn && labels.includes(r.readyLabel)) ?? null;
}
