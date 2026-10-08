# Current documentation search setup

The setup tool lives in `container/qmd-current/`, beside the container's QMD
configuration code. It configures `pyrycode-current` for feature and decision
questions. Keep `pyrycode-docs` for historical ticket reasoning.

This tool moved from the daemon repository after
[#2930](https://github.com/pyrycode/pyrycode/issues/2930).
Its tests invoke the real QMD CLI, so they belong with pipeline tooling.

## Run setup

Install Node and put `qmd` on `PATH`. Run from any working directory on Linux or
macOS. Set these paths to the agents and daemon checkouts:

```sh
PYRYCODE_AGENTS=/absolute/path/to/pyrycode-agents
PYRYCODE_REPO=/absolute/path/to/pyrycode
node "$PYRYCODE_AGENTS/container/qmd-current/setup.mjs" --repo "$PYRYCODE_REPO"
qmd update
qmd embed
```

Without `--repo`, setup uses a `pyrycode` checkout beside the agents repository.
It resolves that path from the script's location, independent of the working
directory. Use `--repo` for other layouts or a temporary corpus.

Setup writes configuration only. Run `qmd update` to index changed documents and
remove stale membership. Then run `qmd embed` to refresh vectors.
Embedding alone does not discover file changes.
Keep the same configuration and index environment for all commands.
These commands use QMD's default index, without its `--index` option.

For isolated verification, export these variables before running setup and QMD:

| Option | Effect |
| --- | --- |
| `--repo /absolute/temporary-corpus` | Selects a corpus containing `docs/knowledge/features/` and `docs/knowledge/decisions/`. |
| `QMD_CONFIG_DIR=/absolute/scratch/config` | Selects the directory containing `index.yml`. Otherwise setup uses `$XDG_CONFIG_HOME/qmd`, then `~/.config/qmd`. |
| `INDEX_PATH=/absolute/scratch/index.sqlite` | Selects QMD's SQLite index. Setup itself does not open it. |
| `XDG_CACHE_HOME=/absolute/scratch/cache` | Keeps QMD caches separate. |

Set both `QMD_CONFIG_DIR` and `INDEX_PATH` to isolate configuration and indexed data.
The `--repo` option alone changes only the corpus.

## Configuration reconciliation

Setup resolves the collection root to the checkout's `docs/knowledge` directory.
The pattern is `{features,decisions}/**/*.md`.
This includes Markdown directly inside both directories and in nested directories.
It removes the current collection's `ignore` field, even when root and pattern
already match. A retained exclusion could otherwise hide required documents.
An unchanged rerun leaves the configuration bytes untouched.

YAML anchors and aliases can make collections share a mapping.
Setup resolves those values and copies the collection registry and the current
collection before editing. Other collections and settings retain their values.
Global, collection and path contexts remain intact.
YAML formatting, comments and anchor syntax may change during reconciliation.

Configuration replacement is atomic after validation.
Run setup while other configuration writers are idle.
Atomic replacement does not combine concurrent edits.

## Verification

Run from the agents repository with installed QMD and Node:

```sh
node --test container/qmd-current/setup.test.mjs
```

The built-in Node test runner needs no root package file or Go module.
All eight cases run concurrently.
Each case isolates its configuration, SQLite index and caches in a temporary
directory before invoking QMD, even for its version check.
The script runs from an unrelated working directory.

The seven integration scenarios cover fresh setup, wrong root, wrong pattern,
exclusions with wrong and correct scope, and YAML anchors and aliases in both
directions. Each checks a byte-stable rerun, exact indexed membership, complete
resolved configuration preservation, other collections' membership and QMD's
context listing. The four included searches must return the expected files.
The five excluded searches must return nothing in the current collection.
Each excluded document must return from the broad collection as a positive control.
Incorrect collections are indexed before correction to verify stale members vanish.

The default and invalid-config case copies the shipped script into a temporary
sibling layout. It checks default checkout resolution without indexing a real
checkout. It also verifies that malformed configuration fails and remains intact.
Missing QMD skips the cases explicitly.
Check the executed count and skip reasons before claiming verification.
These membership and keyword search checks need no embeddings or live Claude.

## Container follow-up

Automatic provisioning remains a separate decision.
This move does not call the tool from `container/entrypoint.sh` or `write_qmd_config`.
When that wiring is adopted, use the explicit daemon path and the container's
configuration and index environment before refreshing the index:

```sh
node "$AGENTS/container/qmd-current/setup.mjs" --repo "$TARGET"
```

The call must run after the initial QMD configuration is written.
The maintainer must decide how existing containers receive the collection,
because their index stamp can skip first-run setup.
