# Pyrycode review criteria

These criteria are shared by the preliminary source reviewer and the final verifier. The preliminary reviewer can only read files. Anything below that needs another tool, such as codegraph, QMD, GitHub or a label change, belongs to the final verifier.

Report every finding you are confident about, with its severity. The severity scale at the end decides the verdict, so there is no need to hold back minor findings.

The review is complete when every changed hunk has been judged with enough surrounding context to say whether it is right. A file you could not read completely, or a check that needs a tool you do not have, goes in your list of remaining checks. It is not a reason to stop.

## Understanding the change

- **The plan** at `docs/specs/architecture/<ticket>-*.md` is the record of what this PR was meant to build. Its `## Revisions` section is part of the plan, where the builder records design changes made during the build or rework.
- **The repository's `CLAUDE.md` and `CODING-STYLE.md`** cover the layout, the conventions and the test tiers. The package overview at `docs/knowledge/features/<package>.md` for each package the diff touches holds what earlier tickets learned in that area. `docs/knowledge/architecture/system-overview.md` has the whole-system picture.
- **Judge each change in the context of the code it touches.** The diff alone hides most of what matters. A goroutine's shutdown path, a deferred cleanup's order or a lock's scope usually sits outside the changed lines. A changed signature or behaviour matters at every caller. Read as much surrounding code as each change needs. Large files can be read in ranges, and a read that came back cut should be read again in smaller pieces.
- **Look past the diff for what it can break.** For each changed or removed symbol, find its callers against the symbol's pre-change shape and check the diff updates every one. A missed call site is the costliest finding, because it surfaces late and burns a rework cycle. For each new export, check whether a similar symbol already exists. For a new file, check that its package is the right home. Codegraph answers these quickly when it is available: `codegraph_explore` naming a symbol gives its callers per file and the tests that cover it, `codegraph callers <symbol>` in the shell gives the complete list, and `codegraph files --filter <dir>` the files in a package. Use grep only for comments, string literals such as log messages and `t.Run` names, docs, and a name the branch renamed or removed, which the index no longer holds. A plan's list of call sites is a starting point, not the full set.
- **When the area is unfamiliar,** search QMD in `pyrycode-docs`. `docs/lessons.md` is frozen since 2026-05-11, so read it only when chasing something specific and old.
- **Finish the review before deciding.** Keep checking every changed file and every applicable criterion after the first MUST FIX. When a finding reveals a repeated pattern, search the full diff for its siblings and report every instance at once. On a rework pass, check the previous findings and review the whole current diff again, not only the latest repair. Mobile #1300 took two avoidable rework laps because the first review passed two fixed corner shapes in one file and the next two reviews reported them one at a time.

## Criteria

### Go

- **Error handling.** Errors are wrapped with context, as in `fmt.Errorf("doing x: %w", err)`, matched with `errors.Is` or `errors.As`, and never swallowed. Return errors rather than panic.
- **Goroutine lifecycle.** Every goroutine has a shutdown path through a context, a done channel or a defer. None leak.
- **Context propagation.** Long-running operations take a `context.Context` and respect its cancellation.
- **Defer ordering.** Deferred calls run last in, first out. Check the cleanup order is right, for example restoring the terminal before closing the PTY.
- **Races.** Shared state is protected by a mutex or a channel. The race detector only sees the interleavings the tests happen to reach.
- **Naming and logging.** Standard library naming as `CODING-STYLE.md` describes. `log/slog` with structured fields and a fitting level.

### Pyrycode

- **Claude terminal screen text stays in tui-driver.** Screen strings, escape sequences and glyphs belong in `github.com/pyrycode/tui-driver`. `substrate-guard` catches the literals. Your part is the intent behind them.
- **Codex wire shapes come from the committed schema.** `internal/codexsup/codex_app_server_protocol.schemas.json` is the app-server schema at the pinned Codex version, and `internal/codexsup/SCHEMA.md` says it is regenerated whenever the pin moves. Check a field name, enum value or required field there, for example `definitions.v2.TurnStartParams` for `turn/start`, and name the definition in your finding. Do not run a `codex` binary to confirm a shape. Pyrycode #2586 stalled on a denied schema-generation command when the committed schema already held the answer. A committed schema older than the version the ticket targets is a MUST FIX for the builder.
- **The standard gate cannot see the live suite.** `internal/e2e/realclaude` sits behind the `e2e_realclaude` build tag, so `make check` never compiles it. A diff that touches that package, or deletes or moves test files whose helpers it uses, is unproven by a green gate. On 2026-08-16 a deletion took thirty shared helpers with it and the package did not compile for a day while every `make check` stayed green. Check the remaining callers still resolve, and make sure the ticket is routed to the live gate.
- **Live probes are sound.** When the ticket depends on the live gate, the probe is reachable under plain `make e2e-realclaude`, arms when its fixture is absent, and keeps trustworthy durable records. A test that writes a capture does not commit it, so a ticket that asks for a captured artifact needs the builder to commit what the run wrote. An unreachable or unsound probe is a MUST FIX. A sound probe awaiting its first live run is not a finding.

### General

- **Tests exist for new logic.** Table-driven where it fits, standard library `testing` only, with interfaces and simple test doubles rather than testify or a mocking framework.
- **Plan compliance.** The implementation matches the plan including its Revisions, and the plan's open questions were resolved rather than ignored. A departure with no Revisions entry needs the builder either way: the code is wrong or the plan was silently abandoned. A short plan, with Files read, Change and Testing strategy, is fine for a small change. Judge it by whether the diff matches its Change paragraph and stays inside its Files read. A short plan under a diff that grew past it is a finding.
- **Plan before code.** The plan commit precedes the implementation commits. A plan committed after the code, or amended alongside unrelated code outside a Revisions entry, has been bent to fit and is not evidence of design.
- **Scope and simplicity.** The diff touches only production code and tests under `cmd/` and `internal/`, plus the plan file. A doc file outside that set is a scope violation, because the builder is told not to write one. The diff does what the ticket asks and does not refactor neighbouring code along the way. No unnecessary dependencies in `go.mod`, no commented-out code, no debug prints left behind, and commit messages are clear and imperative.
- **Comments state the contract, and files stay small.** A comment the branch wrote or edited states what is true now, per "Comments: Contract, Not History" in the target repository's `CODING-STYLE.md`. One that records earlier wording, earlier values or ticket chronology, or grows an `AMENDED` paragraph or a "used to" sentence instead of being rewritten, is a SHOULD FIX. So is a file the branch pushed past about 1500 lines; name the family to split out. Comments and file sizes the branch did not change are not findings.
- **A gate-shaped concern the suite did not reach,** such as a race the tests never exercise, is a MUST FIX finding. The rework cycle sends it back through the gates.

## Security-sensitive tickets

This applies when the issue carries the `security-sensitive` label.

- **The plan must contain a `## Security review` section** with a verdict and a findings list. If it is missing, the design was never audited: FAIL with `needs-rework:builder`, name the missing section, and stop there.
- **Read the diff for these risks** on top of the normal criteria. Tokens or secrets reaching log lines, error messages or hex dumps. `os.OpenFile` without an explicit mode, `os.Stat` followed by `os.Open` on the same path, or path joins without canonicalising. `exec.Command` with caller-controlled arguments, `sh -c`, or an environment passed on unscrubbed. `math/rand` where `crypto/rand` belongs, hand-rolled crypto, or a comparison against a secret that is not constant-time. A bare `http.ListenAndServe`, missing input-size limits or missing header validation. A `// #nosec` annotation without a justification in the PR description.
- **The diff implements the plan's security findings.** If the plan said to validate `cwd` against an allowlist, check that it does.
- **A security issue the plan's review never addressed** is a FAIL with `needs-rework:builder`. Say the gap is in the plan's security review, so the builder revises that section with a Revisions entry instead of patching code under an unaudited design.

## Severity and verdict

- **MUST FIX** blocks merge. Examples: a race, a goroutine leak, a swallowed or unwrapped error at a boundary, missing or misordered cleanup, a missed call site, missing tests for new logic, an undocumented departure from the plan, a stale Codex schema, an unsound live probe.
- **SHOULD FIX.** Examples: naming violations, missing test cases for an edge the logic handles, unclear error messages, logging at the wrong level, a new symbol duplicating one that already exists.
- **NIT.** Style, comment clarity, anything `gofmt` or a linter would catch.

**FAIL** on any MUST FIX, on three or more SHOULD FIX, or on a live-suite failure surfaced in the injected context. A PASS can carry up to two SHOULD FIX findings and any number of NITs. List them so the builder and the human see them.

A line-number citation in a comment that went stale only because this branch inserted lines above it is not a finding. At most it is a NIT, and only when the fix is a couple of digits in a file the PR already touches. Citations the branch wrote itself are already blocked by `cite-guard`, which was scoped on 2026-08-11 to check only the lines a branch writes. Pyrycode #1458 spent three rework cycles fixing displaced digits in code that was correct all along, ending in `error:rework-loop`. Some old citations will drift and point at the wrong line. That costs less than a pipeline lap per displacement, and each one gets corrected when someone next edits that comment for a real reason. If a stale citation misleads a reader about something load-bearing, raise a NIT naming the symbol to use instead.
