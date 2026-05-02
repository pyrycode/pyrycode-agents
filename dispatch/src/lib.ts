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
 * matching `ready:<agent>` label is present — a human reviews the work
 * and moves the ticket forward manually (same gesture as Inbox → Backlog).
 *
 * **Currently empty** (as of 2026-05-02). The architect → developer gate
 * was added 2026-05-01 as a safety net for oversized specs, then removed
 * once the size policy was enforced in code (architect either sizes ≤M
 * with a "Why M, not split" justification, or splits via `needs-rework:po`
 * — both produce a deterministic outcome that doesn't need human review).
 * The gate was duplicating safeguards.
 *
 * The mechanism stays. Adding a future gate is a deliberate policy decision:
 * append the column name here, update the corresponding test in lib.test.ts,
 * and the gating behaviour in `decideAutoAdvance` activates automatically.
 *
 * Tickets in a gated column sit with `ready:<agent>` set; the gate
 * just suppresses the auto-advance step. `shouldSkipDispatch` prevents
 * re-dispatch of an agent that has already added `ready:` for itself,
 * so the ticket is stable.
 */
export const MANUAL_ADVANCE_GATES: ReadonlySet<string> = new Set<string>();

/**
 * Columns considered "mid-pipeline" for the strict-WIP=1 rule. A ticket
 * sitting in any of these columns is in flight: actively progressing
 * through agents, awaiting human gate, or transiently in rework.
 *
 * Backlog and Inbox are not mid-pipeline (work hasn't started). Done is
 * not mid-pipeline (work is complete).
 *
 * Used by `runAutoAdvance` to hold Backlog → In Architecture promotions
 * when something is already in flight, so one ticket flows end-to-end
 * before the next starts.
 *
 * Tickets carrying any `error:*` label are excluded from the in-flight
 * check by the caller — they're stuck on exceptional human action and
 * shouldn't block unrelated work. Adding an `error:*` label is the
 * escape hatch for parking a normal-path ticket too (e.g. a long
 * human-gate delay where you want unrelated tickets to flow).
 */
export const MID_PIPELINE_COLUMNS: readonly string[] = [
  "In Architecture",
  "In Development",
  "In Code Review",
  "In Documentation",
];

/**
 * True if any of the given mid-pipeline items is "in flight" — i.e. should
 * count toward the WIP=1 cap and hold new tickets in Backlog.
 *
 * Counts:
 *   - tickets actively running, awaiting human gate, or transiently in rework
 *   - tickets with no labels (just-arrived in column, awaiting dispatch)
 *
 * Excludes:
 *   - non-issue items (issueNumber <= 0, e.g. epics or draft project items)
 *   - tickets carrying any `error:*` label — those are stuck on exceptional
 *     human action and shouldn't block unrelated work. Adding `error:*` is
 *     also the escape hatch for parking a normal-path ticket (e.g. a long
 *     human-gate hold where you want unrelated tickets to flow).
 *
 * Pure function over the items the caller already collected from
 * MID_PIPELINE_COLUMNS — no I/O, no side effects, easy to unit-test.
 */
export function isPipelineInFlight(
  items: { issueNumber: number; labels: string[] }[],
): boolean {
  return items.some(
    item =>
      item.issueNumber > 0 &&
      !item.labels.some(l => l.startsWith("error:")),
  );
}

// --------- Auto-advance decision ---------

/** Minimum item shape the decision functions need. Subset of `ProjectItem`. */
export interface DecisionItem {
  id: string;
  issueNumber: number;
  labels: string[];
}

/** A single column-to-column move the dispatcher will execute. */
export interface AdvanceAction {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
}

/** What `decideAutoAdvance` returns: advances + diagnostics for logging. */
export interface AutoAdvanceDecision {
  advances: AdvanceAction[];
  /** Items currently sitting at a human gate (logged as 🚦 awaiting review). */
  gatedAwaiting: { column: string; itemNumbers: number[] }[];
  /** Items in Backlog held by WIP=1 (logged as 🛑 held). */
  backlogHeld: number[];
}

/**
 * Pure decision function for `runAutoAdvance`. Given the rule table, gate
 * set, current items in each `from` column, and whether the pipeline is
 * already in flight, return the list of advances to perform plus the
 * diagnostic info the caller needs to log gate/hold heartbeats.
 *
 * Semantics:
 *   - **Gated columns** (in MANUAL_ADVANCE_GATES): no advance even when
 *     `ready:<agent>` is set. Eligible items are reported in `gatedAwaiting`
 *     for heartbeat logging.
 *   - **Backlog when in-flight**: held by WIP=1. Eligible items are reported
 *     in `backlogHeld`.
 *   - **Backlog when free**: advance the FIRST eligible item only. The rest
 *     are reported in `backlogHeld` (within-cycle WIP=1 — locked in by
 *     b39f569 after fc1c7fc shipped without it).
 *   - **Mid-pipeline columns**: advance ALL eligible items. Once a ticket
 *     is past Backlog we want it to keep flowing.
 *   - An item is **eligible** when it has the rule's `readyLabel`, has a
 *     positive `issueNumber`, and carries no `needs-rework:*` or `error:*`
 *     label.
 */
export function decideAutoAdvance(
  rules: readonly AdvanceRule[],
  gates: ReadonlySet<string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
  inFlight: boolean,
): AutoAdvanceDecision {
  const advances: AdvanceAction[] = [];
  const gatedAwaiting: { column: string; itemNumbers: number[] }[] = [];
  const backlogHeld: number[] = [];
  let cycleInFlight = inFlight;

  const isEligible = (item: DecisionItem, readyLabel: string): boolean =>
    item.issueNumber > 0 &&
    item.labels.includes(readyLabel) &&
    !item.labels.some(l => l.startsWith("needs-rework:") || l.startsWith("error:"));

  for (const rule of rules) {
    const all = itemsByColumn.get(rule.from) ?? [];
    const eligible = all.filter(item => isEligible(item, rule.readyLabel));

    if (gates.has(rule.from)) {
      if (eligible.length > 0) {
        gatedAwaiting.push({
          column: rule.from,
          itemNumbers: eligible.map(i => i.issueNumber),
        });
      }
      continue;
    }

    if (rule.from === "Backlog") {
      // Trust the caller's input order. `runAutoAdvance` queries GraphQL
      // with `orderBy: { field: POSITION, direction: ASC }`, returning
      // items in board-position order (top of column first). That's the
      // user's manual prioritization signal — we respect it directly.
      //
      // Earlier this file sorted by issueNumber (3abe7a3); that was
      // wrong. issueNumber is creation order, not priority order. With
      // POSITION ordering at the GraphQL boundary, the human can drag
      // tickets up/down the column to set priority and the dispatcher
      // follows.
      if (cycleInFlight) {
        // Already in flight — hold every eligible Backlog item.
        backlogHeld.push(...eligible.map(i => i.issueNumber));
        continue;
      }
      if (eligible.length === 0) continue;
      // Advance the first (top of column); hold the rest in input order.
      const head = eligible[0];
      advances.push({
        itemId: head.id,
        issueNumber: head.issueNumber,
        fromColumn: rule.from,
        toColumn: rule.to,
      });
      cycleInFlight = true;
      if (eligible.length > 1) {
        backlogHeld.push(...eligible.slice(1).map(i => i.issueNumber));
      }
      continue;
    }

    // Mid-pipeline: advance every eligible item.
    for (const item of eligible) {
      advances.push({
        itemId: item.id,
        issueNumber: item.issueNumber,
        fromColumn: rule.from,
        toColumn: rule.to,
      });
    }
  }

  return { advances, gatedAwaiting, backlogHeld };
}

// --------- Rework routing decision ---------

/** A single rework move + the labels the dispatcher will strip on routing. */
export interface ReworkRoute {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
  /** The needs-rework:<target> label that triggered this route. */
  triggerLabel: string;
  /** Labels to remove on routing — includes the trigger plus any
   *  ready:/wip:/error: state labels (so the target column receives a
   *  clean ticket, ready for re-dispatch). Non-state labels (size:,
   *  priority:, custom tags) are preserved. */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runReworkRouting`. Given the agent→column
 * map and current items in each column, return the list of rework routes
 * to apply.
 *
 * Per item with one or more `needs-rework:<target>` labels, the FIRST valid
 * label (by array order) wins:
 *   - Item must have `issueNumber > 0`.
 *   - Target must extract cleanly via `extractReworkTarget` (rejects bare
 *     `needs-rework:` and non-rework labels).
 *   - Target must be a known agent (in `agentColumnMap`).
 *   - Target's column must differ from the item's current column —
 *     self-loops aren't routes; the dispatcher's `shouldSkipDispatch`
 *     handles re-dispatch on `needs-rework:<self>`.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (status updates and label removals).
 */
export function decideReworkRoutes(
  agentColumnMap: ReadonlyMap<string, string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
): ReworkRoute[] {
  const routes: ReworkRoute[] = [];

  for (const [fromColumn, items] of itemsByColumn) {
    for (const item of items) {
      if (item.issueNumber <= 0) continue;

      // First valid rework label wins. Iterate in array order for
      // determinism — same order GitHub returns from the labels query.
      for (const label of item.labels) {
        const target = extractReworkTarget(label);
        if (target === null) continue;
        const targetColumn = agentColumnMap.get(target);
        if (!targetColumn) continue;
        if (targetColumn === fromColumn) continue; // self-loop

        const labelsToStrip = [
          label,
          ...item.labels.filter(l =>
            l !== label &&
            (l.startsWith("ready:") || l.startsWith("wip:") || l.startsWith("error:")),
          ),
        ];

        routes.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn,
          toColumn: targetColumn,
          triggerLabel: label,
          labelsToStrip,
        });
        break; // first valid rework label wins
      }
    }
  }

  return routes;
}

// --------- Per-agent dispatch policy ---------

/**
 * True if the dispatcher should set up a git worktree for this agent and
 * push the resulting feature branch after the run. False for agents that
 * only modify external state (issues, PRs, project board) — currently
 * just PO.
 *
 * Reads `agent.usesWorktree` (declared in types.ts). The predicate exists
 * so callers grep for the policy by name and so future logic (e.g.
 * conditional behaviour by ticket type) has one place to live.
 *
 * Caught the cosmetic "feature/27 push failed: src refspec doesn't
 * match any" bug surfaced on #27: PO's run had no commits, so the
 * dispatcher's unconditional `git push` failed. Gating the push on this
 * predicate removes the spurious failure.
 */
export function shouldUseWorktree(agent: AgentConfig): boolean {
  return agent.usesWorktree;
}

// --------- Issue dependencies ---------

/**
 * True if any of the listed blockers is still OPEN.
 *
 * Uses GitHub's first-class `addBlockedBy` relationship (queryable as
 * `Issue.blockedBy` in GraphQL, visible in the issue UI as a "Blocked by
 * #N" badge). The dispatcher skips dispatch on any ticket where this
 * returns true — a blocked ticket can't make progress until its
 * dependencies close.
 *
 * Avoids the retry-loop class of failures (Pyrycode #41 hit this 6 times,
 * burning ~$4 of dev tokens, before the dev agent self-halted by
 * setting `error:developer`). Native `blockedBy` makes the constraint
 * structural — survives across runs, visible in the GitHub UI, and
 * doesn't require a custom label scheme.
 */
export function hasOpenBlockers(
  blockers: { number: number; state: "OPEN" | "CLOSED" }[],
): boolean {
  return blockers.some(b => b.state === "OPEN");
}

// --------- Auto-commit safety net ---------

/**
 * True if the worktree has uncommitted changes that the dispatcher should
 * auto-commit before pushing. Catches agents that wrote files but forgot
 * to commit (the bug that destroyed #27's spec via `git worktree remove
 * --force`).
 *
 * Input is the raw output of `git status --porcelain`. Whitespace-only
 * output is treated as clean — guards against false positives from
 * trailing newlines or shell padding.
 */
export function shouldAutoCommit(gitStatusOutput: string): boolean {
  return gitStatusOutput.trim().length > 0;
}

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
