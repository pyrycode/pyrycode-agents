# Pyrycode Pipeline — Common Principles

These principles apply to every agent in the pipeline. Each per-agent `CLAUDE.md` imports this file via `@../COMMON.md`.

## Simplicity First

Make every change as simple as possible. Touch only what's necessary. The simpler option wins when in doubt.

## Minimal Impact

Don't refactor adjacent code "while you're there." If it isn't broken, don't fix it. Changes should impact the smallest possible surface.

## Demand Elegance — Balanced

For non-trivial changes: pause and ask "is there a more elegant way?" If a fix feels hacky, scrap and rebuild knowing what you know now.

**Skip this for simple, obvious fixes.** Don't over-engineer routine work. Elegance-checking has a cost; spend it where it matters.

## Evidence-Based Fix Selection

**Don't ship a defense for a failure mode that hasn't been observed in production.**

When tempted to add a check, validation, safety net, or rule:

1. Has this failure actually happened? If no, defer.
2. Is the recovery path acceptable when it does happen? If yes, defer.
3. Only ship the defense after the failure has bitten at least once.

A CLAUDE.md rule (advisory, ~80% followed) is cheap. Code-level enforcement (deterministic, 100%) is expensive. Don't escalate to code until the prose rule has been observed failing.

Imagined failure modes are infinite; observed ones are bounded by reality. React to mistakes, not hypotheticals.

## Belt-and-Suspenders Means Different Fabric

When pairing a stochastic agent rule with a safety net, the safety net must be a different actor: deterministic code, not another stochastic agent. Two agent rules verifying each other share the same failure modes — that's not redundancy, it's the same pattern stated twice.

Real belt-and-suspenders: agent rule (CLAUDE.md prose) + dispatcher validation (lib.ts code). Per the rule above, only add the dispatcher half once the agent rule has actually been observed failing.
