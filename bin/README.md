# agents/bin/

Dispatcher operations as standalone scripts. Each is `chmod +x` and uses
`dirname "$0"` to locate the `dispatcher/` submodule relative to itself, so
they work whether invoked from `agents/`, the project root, or anywhere
else via absolute path. `pyry-start` exports `AGENTS_REPO_PATH=$AGENTS_DIR`
so the dispatcher knows where the consumer's per-agent CLAUDE.md files,
`.env`, and runtime artifacts (`logs/`, `.prompt-*.txt`) live.

## Commands

| Script | Purpose |
|---|---|
| `pyry-start` | Start the dispatcher in the foreground. Pass-through args to `pnpm`. |
| `pyry-drain` | Send SIGTERM — dispatcher finishes the current dispatch, then exits cleanly. |
| `pyry-status` | Report whether the dispatcher is running, on which Node binary, and since when. Exit 0 = running, 1 = stopped. |
| `pyry-restart` | Drain → wait for in-flight dispatch to finish (30 min cap) → start fresh. |
| `pyry-logs` | Tail dispatcher logs. `pyry-logs` (latest), `pyry-logs -a` (all), `pyry-logs <ticket>` (filter by issue number). |
| `pyry-typecheck` | Run `pnpm typecheck` in `dispatcher/` (the submodule). |
| `pyry-test` | Run `pnpm test` in `dispatcher/` (the submodule). Pass-through args. |

## Invocation

From `agents/`:
```
./bin/pyry-drain
```

From anywhere via absolute path:
```
~/Workspace/Projects/pyrycode-agents/bin/pyry-drain
```

To run by short name from anywhere, add this dir to your PATH:
```sh
export PATH="$HOME/Workspace/Projects/pyrycode-agents/bin:$PATH"
```
(Personal preference; not required for the scripts to work.)

## Project knowledge

`pyry-start` disables Claude auto memory and local-memory curation for this consumer.
The project and role instructions use the shared documentation workflow instead.
See [shared development practice](../docs/working-practice.md). The host background
curator also skips this fork when its `.env` contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## Agent runner

Claude remains the default. To use the Codex runner, set
`PYRY_AGENT_RUNNER=codex` in this repository's `.env` before starting the dispatcher.
Unset it or use `claude` to switch back. Codex must be installed and authenticated
on this host. It uses its configured default model and effort unless
`PYRY_CODEX_MODEL` or `PYRY_CODEX_EFFORT` is set.

Codex uses workspace sandboxing with automatic approval review. A blocked task
parks without automatic retry and keeps its worktree. It uses the role's wall-clock
budget, not Claude's turn budget, and never enters Claude's continuation path.
The launch still processes the board; it is not a single-ticket mode.
See [the dispatcher runner documentation](../dispatcher/README.md#selectable-agent-runner)
for the result contract, limitations and verification.
