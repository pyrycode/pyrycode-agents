# Security review pass — adversarial audit of your own plan

You only run this pass when the ticket carries the `security-sensitive` label. The refiner applies that label during refinement. When it's present, the plan you just wrote needs an adversarial re-read before you commit it and start implementing. This file is the checklist and the framing; it lives in the agents repo, so read it as `$AGENTS_REPO_PATH/builder/security-review.md` — it is not inside your worktree.

## Mindset shift

You are no longer the designer. You are an adversary reviewing the plan for exploitability, with the explicit assumption that **the plan has holes**. The default verdict is FAIL until you've walked every applicable category below and found nothing.

Two failure modes to actively resist:

1. **Self-bias.** You wrote this plan ten minutes ago, and in this pipeline you are also the one about to implement it. You believe in it twice over. The whole point of this pass is to find what you missed. If your gut says "this looks fine," that's the smell — go deeper, not shallower.
2. **Coverage theatre.** Walking the checklist and writing "✓ N/A" for each category is worth nothing. For each category, either name a concrete finding — naming the symbol it lives in, or a specific scenario the plan doesn't address — or explicitly state the design decision that makes the category not applicable.

**Cite by symbol, never by line.** Findings outlive the ticket, so a `file.go:NNN` in one is stale by the time anybody reads it, and `make cite-guard` bans the same shape in code comments at any depth with no range exemption. Write ``the check in `validateRequest` `` — resolve the name with `codegraph_search` if you need to.

## Categories — walk each one

For each category, the question to answer is: *given this plan, what's the worst thing a hostile actor (or a buggy caller, or a confused developer) could trigger?*

### 1. Trust boundaries

- Where in the design does data cross from "untrusted" to "trusted"? (Network → process, file → memory, subprocess stdout → parent state.)
- Is the boundary explicit (single function, named type) or scattered (parsed in three places)?
- Who decides what "trusted" means for each boundary, and does the plan document it?
- Do downstream callers know they're now holding trusted vs untrusted data? (Type system signal? Comment? Convention?)

### 2. Tokens, secrets, credentials

- How are tokens generated (`crypto/rand` vs `math/rand`; sufficient entropy)?
- How are tokens stored (plaintext on disk? hashed? encrypted? what's the threat model that justifies the storage choice)?
- Where do tokens appear in logs, error messages, or stack traces?
- Token lifecycle — creation, storage, rotation, revocation, expiry. Are all four addressed?
- For revocation: is it possible? Granular (per-device) or all-or-nothing? How is revocation propagated?

### 3. File operations

- Path traversal — does any code path concatenate user input into a filesystem path without canonicalisation + boundary check?
- TOCTOU — does the plan do `os.Stat` then `os.Open` (or similar check-then-use) on a path the caller controls? If so, how does the design prevent the swap-during-the-gap attack?
- Permissions — what mode are created files? `0600` for secrets? `0700` for cert dirs? Does the plan say it explicitly?
- Symlink handling — does the design follow symlinks blindly, or does it use `O_NOFOLLOW` / equivalent for security-sensitive paths?
- Atomic writes — does the design use temp-file-plus-rename for files that could leave partial state on disk if interrupted (devices.json, sessions.json, autocert keys)?

### 4. Subprocess / external command execution

- Are user-controlled values passed as arguments to `exec.Command`? If so, are they validated against an allowlist or shape constraint?
- Is `sh -c` ever used (almost always wrong — it shell-interprets)?
- What environment variables are inherited vs explicitly scrubbed?
- Signal handling on the subprocess — how does the parent kill it cleanly? What about double-fork escapes?

### 5. Cryptographic primitives

- RNG: `crypto/rand` everywhere randomness is security-relevant; `math/rand` is acceptable only for non-security uses (jitter, test fixtures).
- Primitives: pick standards (TLS via `crypto/tls`, hashing via `crypto/sha256`, key derivation via `golang.org/x/crypto/argon2` or similar). Reject hand-rolled crypto on sight.
- Key reuse — does the design accidentally use the same key/nonce for two purposes?
- Constant-time comparison — is `crypto/subtle.ConstantTimeCompare` used wherever attacker-controlled values are compared to secrets?

### 6. Network & I/O

- Input size limits — every Read from a socket needs a max-size cap. What's the cap, and is it documented in the plan?
- Header validation — for HTTP/WS upgrades, are required headers checked for presence, length, and shape before the upgrade?
- Timeout discipline — `http.Server` with explicit `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout`. Bare `http.ListenAndServe` is a `gosec G114` violation and a real DoS vector.
- Slow-loris resistance — does the design have a per-connection read deadline?
- Resource exhaustion — does the design cap connections per server-id? Per IP? Total?
- TLS configuration — `MinVersion: tls.VersionTLS12` at minimum; cipher suite policy (Go's secure defaults are fine, but if the plan sets it explicitly, audit the choice).

### 7. Error messages, logs, telemetry

- What goes in error messages — generic for external callers, specific for internal logs?
- Do error messages leak: tokens, full headers, file paths, internal state, stack traces?
- Logs — what fields are MUST-NOT-log (payloads, full headers, tokens), what fields are MUST-log (event type, server-id, conn-id, remote host)?
- Telemetry/metrics — do they aggregate user-identifiable data the user didn't consent to?

### 8. Concurrency

- Lock ordering — if the design takes multiple locks, is the order documented and consistent across call sites?
- TOCTOU on shared state — does the design check-then-mutate without holding a lock across both?
- Shutdown safety — what happens if the process is signalled mid-write? Mid-network-Send? Are partial states recoverable on next start?
- Goroutine lifecycle — for every goroutine the plan spawns, what causes it to exit? Is leakage possible?

### 9. Threat model alignment

- For relay tickets: does the design address each relevant threat in `pyrycode/pyrycode/docs/protocol-mobile.md` § Security model?
- For CLI tickets: does the design address each relevant threat in `docs/threat-model.md` (when present) or the protocol spec's CLI-relevant threats?
- If a threat is out of scope for this ticket, the plan should NAME it as out of scope and note who picks it up.

## Decision

After walking the categories, classify each finding:

- **MUST FIX** — exploitable as designed; the plan must change before you commit it.
- **SHOULD FIX** — concerning but recoverable downstream (you add the check in Phase B; the verifier checks it landed). Note in the plan; don't gate on it.
- **OUT OF SCOPE** — explicitly deferred to a future ticket. Name the future ticket.

Verdict:
- **Any MUST FIX** → FAIL. Revise the plan to address each, then re-run this checklist from the top. Do not commit the plan yet.
- **No MUST FIX** → PASS. Append the security-review section to the plan (format below), then commit it and proceed to Phase B.

## Output format — append to the plan

Add a new section at the end of `docs/specs/architecture/{ticket}-{slug}.md`:

```markdown
## Security review

**Verdict:** PASS

**Findings:**

- [Trust boundaries] No findings — design has a single explicit boundary at `internal/control/handler.go`'s `validateRequest` function; downstream code holds parsed types only.
- [Tokens] SHOULD FIX — plan doesn't specify the file mode for `devices.json`. Write at `0600` in Phase B; the verifier must check.
- [Network & I/O] No findings — plan inherits `http.Server` with timeouts from `cmd/pyry/main.go`'s pattern.
- [Concurrency] OUT OF SCOPE — connection-count limits deferred to ticket #N.
- [...]

**Reviewer:** builder (self-review per the security-review checklist)
**Date:** <YYYY-MM-DD>
```

If verdict is FAIL, do NOT commit the plan yet. Revise inline, then re-run.
