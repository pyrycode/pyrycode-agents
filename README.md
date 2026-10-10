## Product maintenance tools

Documentation and source-comment maintenance lives in `tools/pyrycode`, a separate Go module.
It is excluded from product builds and ordinary dispatcher unit tests.
Run a tool from the product checkout so it reads that checkout:

```sh
../pyrycode-agents/bin/pyrycode-tool docs-guard
../pyrycode-agents/bin/pyrycode-tool cite-guard
../pyrycode-agents/bin/pyrycode-tool spec-reference-inventory
../pyrycode-agents/bin/pyrycode-tool qmd-current --repo "$PWD"
```

`spec-scaffolding-prune` accepts the existing `-evidence`, `-approvals` and `-apply` arguments.
Preview is the default. Applying a cleanup remains an explicit maintenance operation.
Its captured evidence is under `tools/pyrycode/cmd/spec-scaffolding-prune/testdata/`.
Run `bin/pyrycode-tool test` explicitly to test maintenance tools.
Those tests use isolated temporary data.
They never belong in a product gate.

QMD setup remains in `container/qmd-current`, with its own opt-in Node tests.
See [current documentation search](docs/current-docs-search.md).

The verifier runs the two guards before `make check`.
Existing product Make targets delegate here through `AGENTS_REPO_PATH` or a sibling clone.
Deploy this agents change before the matching product change.

`bin/pyry-test` runs ordinary dispatcher tests.
`bin/pyry-test --slow` also runs full-duration subprocess timeout and wait-credit proofs.
Use the latter after changing runner timeouts, process termination or wait-credit accounting.

## Shared machine capacity

Use `bin/pyry-start --managed` after configuring the machine manager. The flag also works with `bin/pyry-restart` and survives Ctrl-R. Missing manager credentials stop startup instead of falling back to independent dispatch.

Set `PYRY_MANAGER_URL`, `PYRY_MANAGER_TOKEN` and the role resource classes in the existing secret environment. Unclassified roles are heavy. Keep `PYRY_AUTOCURATE_MEMORY=0`. The manager applies one heavy limit across this computer's projects. Ticket ownership persists across computers until manually freed.

See the shared [setup and recovery guide](dispatcher/docs/machine-manager.md). Drain old dispatchers and disable independent watcher takeover before sharing a board. The machine limits and project order in the examples need explicit local configuration.
