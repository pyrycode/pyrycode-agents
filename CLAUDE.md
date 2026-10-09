# Pyrycode Dispatcher — Working Notes

This is the agent-prompts + dispatcher-launcher repo. The Go source for the binary lives in the parent (`pyrycode/`). As of 2026-05-09 the dispatcher source itself lives in [`pyrycode/agent-dispatcher`](https://github.com/pyrycode/agent-dispatcher) — a separate repo consumed via git submodule at `dispatcher/`. This repo holds the per-agent CLAUDE.md prompts (architect/, developer/, code-review/, documentation/, po/), the `bin/` launcher scripts, and the `.env` config that drives the dispatcher against the pyrycode board.

## Dispatcher source layout

The dispatcher's pure-function helpers are split across five files; `lib.ts` is a thin barrel re-export.

| File | Owns |
|---|---|
| `dispatcher/src/pipeline-decisions.ts` | Auto-advance rules + decision, rework routing, done-cleanup, post-run labels, label predicates, rework-target extraction, rework-loop circuit breaker, advance-rule lookup |
| `dispatcher/src/agent-runtime.ts` | `shouldUseWorktree`, `maxTurnsFor`, salvage gating (`shouldAttemptSafeSalvage`, `findReadyPrNumber`, `extractRateLimitInfo`), `SPAWN_ENV_DENYLIST` + `scrubSpawnEnv` |
| `dispatcher/src/worktree.ts` | `shouldAutoCommit`, `decideCodegraphIndexCopy`, `decideBranchSetup`, `findWorktreesForBranch`, `resolveAgentsRepoRoot`, `resolveTargetRepoRoot` |
| `dispatcher/src/blockers.ts` | `hasOpenBlockers`, `shouldSkipBlockedFor`, `shouldProduceCommits`, `parseCommitsAhead`, `shouldFlagEmptyBranch` |
| `dispatcher/src/dispatch-selection.ts` | `AGENT_COLUMN_MAP`, `selectDispatches` |
| `dispatcher/src/lib.ts` | Barrel re-export only (kept one cycle for `dispatch.ts` + tests) |

Cross-file deps form a clean DAG: pipeline-decisions → blockers; dispatch-selection → pipeline-decisions + blockers; worktree and agent-runtime are leaves.

**New code:** prefer importing from the specific module (`from "./pipeline-decisions.js"`) over the barrel. The barrel's `export * from` lineup will likely shrink once `dispatch.ts` and tests have flipped to direct imports.

## Use codegraph for dispatcher-side reading

`pyrycode/agents/` is indexed for codegraph (`.codegraph/`, gitignored). Default to `mcp__codegraph__codegraph_explore` for symbol-level questions before reaching for grep:

- **Before changing or removing any exported function**, run `codegraph_explore` naming it: its blast radius lists the callers per file and the tests, across `dispatch.ts`, `reconcile.ts`, sibling lib files, and the test files. `codegraph callers <name>` in the shell gives the complete list. The dispatcher's pure-function decomposition means a "small" rename typically fans out to 3 to 5 sites.
- **Before extending `dispatch.ts` with a new post-run handler**, run `codegraph_explore` naming neighbouring handlers (`decidePostRunLabels`, `runAutoAdvance`, `runReworkRouting`) to see their source and what they call, and mirror their shape.
- **For "where is this used / what calls what" across the dispatcher**, `codegraph_explore "<area phrase>"` returns the relevant symbols' source and the call paths between them faster than reading the files end-to-end.

The same grep rule applies as in agent CLAUDE.mds: use grep/Read only for comments, string literals, docs and your own new code.

**Re-index when finished:** the dispatcher gives each spawned agent's worktree its own copy of the canonical `.codegraph/` (`decideCodegraphIndexCopy` in `worktree.ts`), and the agent's codegraph server catches that copy up with the branch at start. After a substantive change to dispatcher source, run `codegraph sync` from the repo root (1.x syncs reliably; it fails with a lock error while a codegraph server is running there, which then keeps the index current itself) so the next dispatcher run sees the new symbols.

**Querying from a different cwd (e.g. the vault):** `codegraph_explore` accepts a `projectPath` argument: pass `/Users/<you>/Workspace/Projects/pyrycode/agents` to query the dispatcher from any session, regardless of where Claude Code was launched. Without `projectPath` the MCP server falls back to CWD, which usually isn't the project root.

## Test-first

Test-first applies to dispatcher edits as much as it does to dispatched developer agents. RED → GREEN → REFACTOR. Failing test in `lib.test.ts` (or `reconcile.test.ts`) first; implementation after. Backfilling tests after the fact ships bugs first — see PROJECT-MEMORY's "Straightforward state mutation is a smell phrase" lesson.

The dispatcher is ~1500 lines of pure functions (split across pipeline-decisions / agent-runtime / worktree / blockers / dispatch-selection) plus a thin orchestrator (`dispatch.ts`). Reading the source is cheap; theorizing without reading produces wrong answers (PROJECT-MEMORY: "Read the actual code before guessing").

## Belt-and-suspenders

Every "agent does X" rule needs a deterministic dispatcher-side safety net for X. Two stochastic rules verifying each other share the same failure mode. Recent examples in the pure-function lib + `dispatch.ts`:

- **Empty-branch guard** (`shouldFlagEmptyBranch`) — backstops architect/developer/documentation prose with a deterministic commit-count check
- **Auto-commit safety net** — backstops the agent's "remember to commit" instruction
- **`hasOpenBlockers` predicate** — backstops architect's blocker-detection prose with a deterministic GitHub query

When adding a new agent rule, ask: "what deterministic check enforces this if the agent forgets?" If there isn't one, the rule is advisory only — fine for low-cost cases, expensive for ones that ship broken work downstream.

## Shared knowledge

Read [shared development practice](docs/working-practice.md). Claude auto memory is disabled for this consumer. Keep workflow lessons in this repository and product lessons in the target repository. Do not use local memory as an additional store.
