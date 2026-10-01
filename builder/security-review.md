# Security review of your own plan

Run this pass when the issue carries the `security-sensitive` label, after the plan is written and before you commit it. The refiner applies the label, and the verifier fails a labelled ticket whose plan has no `## Security review` section.

## How to read your plan

Switch from designer to adversary, and assume the plan has holes. You wrote it minutes ago and you are about to build it, so you believe in it twice over. The pass exists to find what that belief hides. If the plan looks fine at first glance, look harder.

A checklist answered "not applicable" line by line is worth nothing. For each category below, either name a concrete finding, with the symbol it lives in or a scenario the plan does not handle, or state the design decision that makes the category not apply. "Nothing user-controlled flows here" is a finding under trust boundaries: name the symbol that enforces it. Each plan is reviewed on its own, so do not lean on an earlier ticket's review.

Cite by symbol, as everywhere else: ``the check in `validateRequest` ``, not a file and line.

## Categories

For each one, ask: given this plan, what is the worst a hostile actor, a buggy caller or a confused developer could trigger?

### 1. Trust boundaries

- Where does data cross from untrusted to trusted: network to process, file to memory, subprocess output to parent state?
- Is each boundary in one place, such as a single function or a named type, or scattered across several parsers?
- Does the plan say what "trusted" means at each boundary, and can downstream code tell which kind of data it holds?

### 2. Tokens, secrets, credentials

- Generation: `crypto/rand` with enough entropy?
- Storage: plaintext, hashed or encrypted, and what threat model justifies the choice?
- Exposure: can a token reach a log line, an error message or a stack trace?
- Lifecycle: creation, storage, rotation, revocation and expiry. Is revocation possible, per device or all at once, and how does it propagate?

### 3. File operations

- Path traversal: is caller input joined into a path without canonicalising and a boundary check?
- Check-then-use: an `os.Stat` followed by `os.Open` on a path the caller controls leaves a gap to swap the file. How does the design close it?
- Permissions: does the plan state the mode, such as `0600` for secrets and `0700` for key directories?
- Symlinks: does the design follow them blindly, or use `O_NOFOLLOW` or an equivalent on sensitive paths?
- Atomic writes: do files that could be left half-written, such as `devices.json`, `sessions.json` or key files, use a temporary file and a rename?

### 4. Subprocesses

- Are caller-controlled values passed to `exec.Command`, and are they checked against an allowlist or a shape?
- Is `sh -c` used? It shell-interprets its input and is almost always wrong.
- Which environment variables does the child inherit, and which are scrubbed?
- How does the parent stop the child cleanly, including a child that forks again?

### 5. Cryptography

- `crypto/rand` wherever randomness matters for security. `math/rand` only for jitter and test fixtures.
- Standard primitives only: `crypto/tls`, `crypto/sha256`, `golang.org/x/crypto` key derivation. No hand-rolled crypto.
- Is any key or nonce used for two purposes?
- Is every comparison of attacker-controlled input against a secret done with `crypto/subtle.ConstantTimeCompare`?

### 6. Network and I/O

- Every read from a socket needs a size cap. What is it, and does the plan state it?
- For HTTP and WebSocket upgrades, are the required headers checked for presence, length and shape before the upgrade?
- `http.Server` needs explicit `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout` and `IdleTimeout`. A bare `http.ListenAndServe` is a `gosec G114` finding and a real denial-of-service risk.
- Is there a per-connection read deadline against slow clients, and a cap on connections per server ID, per address or in total?
- TLS: `MinVersion: tls.VersionTLS12` at least. Go's default cipher suites are fine, so audit any explicit choice.

### 7. Errors, logs, telemetry

- External callers get generic errors and internal logs get specific ones. Can an error leak a token, a full header, a file path, internal state or a stack trace?
- Which fields must never be logged, such as payloads, full headers and tokens, and which must be, such as event type, server ID, connection ID and remote host?
- Do metrics aggregate anything that identifies a user who did not agree to it?

### 8. Concurrency

- If the design takes several locks, is the order stated and the same at every call site?
- Does it check shared state and then change it without holding a lock across both?
- What happens if the process is signalled mid-write or mid-send, and is a partial state recoverable on the next start?
- For every goroutine the plan starts, what makes it exit?

### 9. The threat model

- Relay and mobile work: does the design address each relevant threat in `docs/protocol-mobile.md` § Security model?
- CLI work: does it address the relevant threats in that same section, or in `docs/threat-model.md` if one has been added?
- A threat this ticket leaves out should be named in the plan as out of scope, with who picks it up.

## Decision

Classify each finding:

- **MUST FIX:** exploitable as designed. The plan changes before you commit it.
- **SHOULD FIX:** concerning but fixable during the build. Note it in the plan, add the check while building, and the verifier confirms it landed.
- **OUT OF SCOPE:** deliberately deferred. Name the ticket that picks it up.

Any MUST FIX means FAIL: revise the plan, then walk the categories again from the top before committing. With no MUST FIX the verdict is PASS. Append the section below and commit the plan.

## The section to append

Add this at the end of `docs/specs/architecture/<ticket>-<slug>.md`. The verifier looks for the `## Security review` heading, a verdict and a findings list.

```markdown
## Security review

**Verdict:** PASS

**Findings:**

- [Trust boundaries] No findings. The design has one explicit boundary at `validateRequest` in `internal/control`; downstream code holds parsed types only.
- [Tokens] SHOULD FIX: the plan does not give the file mode for `devices.json`. Write it at `0600`; the verifier checks it.
- [Network and I/O] No findings. The plan reuses the `http.Server` timeouts already set in `cmd/pyry`.
- [Concurrency] OUT OF SCOPE: connection-count limits are deferred to #N.
- [...]

**Reviewer:** builder (self-review per the security-review checklist)
**Date:** <YYYY-MM-DD>
```
