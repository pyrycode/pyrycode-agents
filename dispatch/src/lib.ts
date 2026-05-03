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
  /** GitHub-native blocked-by relationships. Optional; defaults to empty
   *  (no blockers). Auto-advance excludes items with any OPEN blocker. */
  blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[];
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
    !item.labels.some(l => l.startsWith("needs-rework:") || l.startsWith("error:")) &&
    !hasOpenBlockers(item.blockedBy ?? []);

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
 *
 * Same-column case (target column == source column) IS routed — earlier
 * versions skipped this as a "self-loop," but that left the rework label
 * on the item permanently. Combined with `shouldSkipDispatch` checking
 * for `needs-rework:<agent>` in `PIPELINE_LABEL_PREFIXES`, the label
 * persistence permanently blocked dispatch on the matching agent. The
 * fix: route same-column cases too — the caller's `updateItemStatus`
 * is a no-op for same-column updates, but the label-strip and
 * rework-count bump still happen, which unblocks dispatch. Surfaced as
 * Pyrycode #59's broader bug 2026-05-02.
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

// --------- Done-column cleanup decision ---------

/** A single ticket's worth of pipeline-state cleanup on entering Done. */
export interface DoneCleanup {
  itemId: string;
  issueNumber: number;
  /** Pipeline-state labels to remove. Always non-empty (clean tickets
   *  produce no entry in the result array). */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runDoneCleanup`. Given the items currently
 * in the Done column, return one cleanup entry per ticket that still
 * carries pipeline-state labels.
 *
 * The bug this fixes: `runAutoAdvance` moves tickets between columns by
 * `updateItemStatus` only — it doesn't strip the `ready:<agent>` labels
 * that drove each advance. So a ticket that flowed through every agent
 * arrives in Done carrying every `ready:*` from the trail. The auto-merge
 * path strips pipeline labels, but only after `gh pr merge` succeeds —
 * doc-only tickets, manually-merged PRs, and closed-as-won't-fix never
 * get cleaned. `runClosedSweep` (which moves closed-but-not-Done tickets
 * to Done) also doesn't strip. This pass closes the gap.
 *
 * Symmetric in spirit with `decideReworkRoutes`: rework routing returns
 * `labelsToStrip` for backward column moves; this returns `labelsToStrip`
 * for the terminal column. The asymmetry between auto-advance (no strip)
 * and rework (strip) was the root cause; cleanup here re-establishes the
 * invariant that no ticket sits in a final-state column with stale
 * pipeline labels.
 *
 * Strips:
 *   - any `ready:`/`wip:`/`error:`/`needs-rework:` label (`isPipelineLabel`)
 *   - any `rework-count:N` label (counter — reset so a re-opened ticket
 *     starts fresh rather than carrying stale rounds toward the loop
 *     threshold)
 *
 * Does NOT touch:
 *   - `size:`, `priority:`, `merged`, or any free-form tag
 *   - the `merged` label specifically — its semantic is "PR was merged,"
 *     set only by the auto-merge path; reaching Done some other way
 *     shouldn't grant it
 *
 * Skips items with `issueNumber <= 0` (epics, virtual items) — same as
 * `decideReworkRoutes`. Idempotent: a clean ticket produces no entry.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (label removals).
 */
export function decideDoneCleanup(
  doneItems: readonly DecisionItem[],
): DoneCleanup[] {
  const cleanups: DoneCleanup[] = [];

  for (const item of doneItems) {
    if (item.issueNumber <= 0) continue;

    const labelsToStrip = item.labels.filter(
      l => isPipelineLabel(l) || l.startsWith("rework-count:"),
    );

    if (labelsToStrip.length === 0) continue;

    cleanups.push({
      itemId: item.id,
      issueNumber: item.issueNumber,
      labelsToStrip,
    });
  }

  return cleanups;
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

/**
 * The `claude --max-turns` budget for this agent's run.
 *
 * Code review gets 100 because it dispatches sub-agents (the parent
 * turn budget covers all child invocations). Everyone else gets the
 * base budget.
 *
 * **Base budget bumped 50 → 60 on 2026-05-02** after #55 hit the 50
 * cap on an S-sized e2e ticket. Distribution analysis over the prior
 * 48h: 7+ tickets clustered exactly AT 50 turns (some shipped, some
 * errored), indicating the cap was binding regularly rather than rare
 * clipping. Pure code-output tickets typically land 30–45 turns; e2e
 * and refactor-shaped work was the long tail crossing 50. Combined
 * with the architect-spec "Files to read first" rule (which removes
 * ~20 turns of redundant exploration), 60 should be enough headroom
 * to ship the long tail while keeping the forcing function intact.
 *
 * Re-evaluate after ~10 dispatched runs at the new budget. If tickets
 * shift down to a comfortable 40-turn median, hold here. If they keep
 * cresting at 60, raise again or differentiate by size class
 * (XS=30, S=60, e2e/refactor=80).
 */
export function maxTurnsFor(agent: AgentConfig): number {
  if (agent.name === "code-review") return 100;
  return 60;
}

// --------- Safer max_turns salvage ---------

/**
 * True when the dispatcher should attempt the safer-salvage path on a
 * `max_turns` failure: auto-commit the agent's uncommitted work, push
 * it, open a draft PR with the agent's last messages in the body, and
 * label the ticket `error:max_turns_salvaged` for human triage.
 *
 * Distinct from the existing PR-already-exists salvage (which treats
 * max_turns + open PR as success). This fires when the agent didn't
 * get to PR creation but did produce buildable code worth preserving.
 *
 * **All four gates must pass:**
 * 1. `terminalReason === "max_turns"` — other failure shapes (api_error,
 *    timeout) don't fit the salvage pattern.
 * 2. No PR already exists — the existing salvage path handles that case.
 * 3. Working tree has changes — nothing to salvage if the worktree is
 *    clean (the agent did no productive work).
 * 4. `go vet` AND `go build` both clean — don't ship broken code as a
 *    draft PR. Failing tests are fine (they're often the signal the
 *    agent was chasing); failing vet/build means the code itself is
 *    indeterminate.
 *
 * **Why a draft PR (not a regular PR + `ready:developer`):**
 * salvaged work is by definition incomplete (the agent stopped in the
 * middle). A regular PR risks silent auto-merge of broken or partial
 * work. A draft PR + `error:max_turns_salvaged` label keeps the work
 * visible while forcing a human triage step before it advances.
 *
 * Earned its slot from four observed independent failure modes:
 * - #55 run 1: comprehension surface (mode A)
 * - #29, #40, #45: edit fan-out (mode B)
 * - #55 run 2: developer found a real production bug, thrashed trying
 *   to fix it instead of bailing (mode C)
 * - #81: OS-service polling time eats budget (mode D)
 * In all four, the developer produced real value the dispatcher
 * silently destroyed via worktree teardown. Salvage preserves it.
 *
 * Pure decision; the caller does the I/O (commit, push, gh pr create,
 * label) so this stays testable.
 */
export function shouldAttemptSafeSalvage(opts: {
  terminalReason: string;
  prAlreadyExists: boolean;
  gitStatusOutput: string;
  vetExitCode: number;
  buildExitCode: number;
}): boolean {
  if (opts.terminalReason !== "max_turns") return false;
  if (opts.prAlreadyExists) return false;
  if (opts.gitStatusOutput.trim().length === 0) return false;
  if (opts.vetExitCode !== 0) return false;
  if (opts.buildExitCode !== 0) return false;
  return true;
}

/**
 * Parse the output of `gh pr list --head <branch> --state open --json
 * number,isDraft` and return the number of the first NON-DRAFT (ready)
 * PR, or null if none exists (no PRs at all, all are drafts, or the
 * input is unparseable).
 *
 * Used by the existing PR-already-exists salvage path. That path treats
 * `max_turns + open PR exists` as success (the agent finished the work
 * and ran out of turns on cleanup). But after the safer-salvage lever
 * shipped, an open PR for a branch is often a DRAFT opened by salvage
 * itself — partial work awaiting human triage. Treating it as success
 * would auto-advance partial work via `ready:<agent>`, defeating the
 * safer-salvage design's safety property.
 *
 * Defaults to "draft" when `isDraft` is missing — the cautious default.
 * False positive (treating ready as draft) wastes a dispatch turn but
 * doesn't auto-advance broken work. False negative (treating draft as
 * ready) silently advances partial work to code-review. Cost asymmetry
 * favors the cautious default.
 */
export function findReadyPrNumber(prListJson: string): number | null {
  let prs: Array<{ number?: number; isDraft?: boolean }>;
  try {
    prs = JSON.parse(prListJson);
  } catch {
    return null;
  }
  if (!Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (typeof pr.number !== "number") continue;
    if (pr.isDraft === false) return pr.number;
  }
  return null;
}

/**
 * Detect whether a thrown error is a GitHub rate-limit failure, and
 * surface the reset deadline so the caller can sleep until reset
 * instead of cascading errors for the rest of the rate-limit window.
 *
 * Returns:
 * - `null` if the error is NOT a rate-limit (caller handles normally)
 * - `{ isRateLimited: true, resetUnixSeconds: <number> | null }` if
 *   it IS a rate-limit; the unix timestamp is from the
 *   `x-ratelimit-reset` header on the failed response if Octokit
 *   surfaced it, or null if not (caller falls back to a default sleep).
 *
 * Detection is by message text — GitHub's GraphQL API returns
 * "API rate limit already exceeded" and the REST API returns "API rate
 * limit exceeded"; we match both. The reset header is informational
 * only — its presence alone doesn't indicate rate-limit state (GitHub
 * returns it on every authenticated request).
 *
 * Last night's incident: dispatcher hit the 5000 points/hour limit and
 * cascaded errors for the next ~50 minutes until reset. With this
 * detection + a sleep loop in pollLoop, the dispatcher pauses cleanly
 * and resumes on the same cycle after reset.
 */
export function extractRateLimitInfo(err: unknown): {
  isRateLimited: true;
  resetUnixSeconds: number | null;
} | null {
  // Extract the message text from Error, string, or {message} shapes.
  let message: string;
  if (err instanceof Error) message = err.message;
  else if (typeof err === "string") message = err;
  else if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    message = (err as any).message;
  } else {
    return null;
  }

  if (!message.includes("API rate limit") || !message.includes("exceeded")) {
    return null;
  }

  let resetUnixSeconds: number | null = null;
  const response = (err as any)?.response;
  const headerValue = response?.headers?.["x-ratelimit-reset"];
  if (typeof headerValue === "string") {
    const parsed = parseInt(headerValue, 10);
    if (!isNaN(parsed)) resetUnixSeconds = parsed;
  } else if (typeof headerValue === "number") {
    resetUnixSeconds = headerValue;
  }

  return { isRateLimited: true, resetUnixSeconds };
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

/**
 * True if this dispatch attempt should be skipped because the ticket
 * has open blockers AND the agent's work depends on the blocker's API.
 *
 * **PO bypasses this check.** Refinement (user story shape, AC, size)
 * is cheap prep work that doesn't depend on the blocker's
 * implementation. Allowing PO to refine in advance means the ticket is
 * ready to flow the moment the blocker resolves — no PO-refinement
 * delay added on top of the blocker wait.
 *
 * All other agents (architect, developer, code-review, documentation)
 * need the blocker's actual code/API to exist on main. They wait.
 *
 * Auto-advance from Backlog → In Architecture also respects the block
 * (see `decideAutoAdvance`); blocked tickets stay in Backlog with their
 * `ready:po` label until the blocker resolves.
 */
export function shouldSkipBlockedFor(
  agentName: string,
  blockers: { number: number; state: "OPEN" | "CLOSED" }[],
): boolean {
  if (agentName === "po") return false;
  return hasOpenBlockers(blockers);
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
 * Pipeline labels that block dispatch for ALL agents (not scoped to a
 * specific agent's name). Currently only `error:max_turns_salvaged`,
 * which marks a ticket whose salvaged work sits in a draft PR awaiting
 * human triage. Until the label is stripped, no agent should re-run on
 * this ticket — otherwise the next dispatch's existing PR-salvage path
 * (which treats max_turns + open PR as success) would auto-advance the
 * partial work via `ready:<agent>`. See `attemptSaferSalvage` and
 * `shouldAttemptSafeSalvage` for the salvage flow.
 */
export const GLOBAL_BLOCK_LABELS: ReadonlySet<string> = new Set([
  "error:max_turns_salvaged",
]);

/**
 * The four-label gate from pollLoop's per-ticket inner loop: a ticket
 * should be skipped from dispatch if any of `ready:<agent>`,
 * `needs-rework:<agent>`, `wip:<agent>`, or `error:<agent>` is present.
 *
 * Returns true to skip (don't dispatch this agent on this ticket).
 * Returns false otherwise (proceed with dispatch).
 *
 * Per-agent labels: OTHER agents' labels do NOT cause a skip — only
 * labels scoped to the agent currently being considered.
 *
 * Global-block labels (`GLOBAL_BLOCK_LABELS`) skip ALL agents until a
 * human strips them. Currently just `error:max_turns_salvaged`.
 */
export function shouldSkipDispatch(labels: string[], agentName: string): boolean {
  if (labels.some((l) => GLOBAL_BLOCK_LABELS.has(l))) return true;
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

// --------- Rework loop circuit-breaker ---------

/**
 * Number of rework rounds a single ticket can absorb before the dispatcher
 * halts dispatch and adds `error:rework-loop`. Adjusting this is a
 * deliberate policy change — see the test in lib.test.ts that locks the
 * default to 3.
 *
 * Why 3: the typical legitimate rework cycle is one round (agent finds
 * issue, routes back, fix lands, advances). A second round means the
 * fix wasn't right. A third round is unusual but defensible. A fourth
 * round is the loop pattern Pyrycode #41 hit (6 dispatches, ~$4
 * burned, dev agent self-halted by intelligence rather than structure).
 * Halting at 3 catches genuine loops well before they accumulate cost.
 */
export const REWORK_LOOP_THRESHOLD = 3;

/**
 * Read the current rework count from a ticket's labels. Looks for any
 * `rework-count:N` label and returns the maximum value found (or 0 if
 * none present). Multiple count labels shouldn't occur in normal
 * operation, but if they do, the maximum is the safest read — biases
 * toward halting rather than under-counting.
 *
 * Tolerates malformed labels (`rework-count:abc`, `rework-count:`) by
 * treating them as 0. Negative values are treated as invalid.
 */
export function extractReworkCount(labels: string[]): number {
  const prefix = "rework-count:";
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const tail = label.slice(prefix.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
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

