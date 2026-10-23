# Behaviour-sized tickets

Adopted 2026-10-18. Policy identifier: `behaviour-slices-v1`.

Refiners and builders read this before sizing new work or reassessing a repair.
It changes how behavioural scope is chosen. Existing numeric ceilings remain
backstops. Budget headroom alone is no reason to bundle separable behaviours.

## Choose the smallest useful behaviour

Before estimating lines, list the distinct observable behaviours requested.
For each, state the check that proves it and whether it can merge while the
application still works. Split independently useful behaviours before builder
admission, even when their combined estimate fits the table.

A broad feature name such as "history" or "reconnect" is not one deliverable.
Saving history, restoring saved history and updating an open view may be
separate behaviours. Use those seams only when each can ship and be tested
against a working application. Do not invent a split whose only proof is an
unused interface compiling, or a helper's private unit tests passing.

Keep the existing floor: plumbing with one consumer in the same family stays
with that consumer. A bug fix stays with the regression test that proves the
failure and repair. Shared test infrastructure used by several tickets may
ship first with its own meaningful checks. Every child keeps its necessary
security review, integration coverage, live acceptance and documentation.

Do not split on prose length, the word "and", a file boundary alone, or the
number of test cases needed to prove one behaviour. Do not pad children to
the acceptance-criterion ceiling. Each extra ticket repeats planning and
verification, so a proposed split must name the useful result of each child.
Ordinary refiner split-depth limits still apply. A builder that discovers oversized work follows `docs/builder-scope-handoff.md` instead of continuing automatically.

## Resolve uncertainty before implementation

The refiner checks current code and merged prerequisites before choosing
scope. Resolve technical design questions from that evidence and state the
chosen contract in the ticket. When a substantial investigation has a useful
result independent of implementation, it can be a first child: a reproduced
failure or measured decision, with a named check and evidence. Do not create
an empty scaffolding child just to reduce the apparent size of its sibling.
Use the existing missing-input route only for a real unresolved product
decision. This policy adds no human approval stage.

A builder checks these behaviour seams before its initial plan, when
implementation exposes extra work and when it returns for repair. If review keeps finding different, separable behaviours
missing from the original scope, reassess rather than growing the repair.
Use the builder scope handoff with proposed smaller results and links to
retained findings and work. A repeated failure of the same invariant calls
for fixing that invariant, not another ticket. Do not discard existing work
or shrink acceptance to obtain a pass.

## Record the feature family

The refiner adds these hidden lines to each body it refines under this policy,
immediately before the final size-estimate section. They are record fields,
not labels, holds, acceptance criteria or dispatcher configuration.

```markdown
<!-- ticket-scope-policy: behaviour-slices-v1 -->
<!-- feature-root: REPOSITORY#ROOT -->
```

Replace REPOSITORY with the target owner/repository and ROOT with the original
feature request's issue number. For an unsplit request, use that ticket itself.
For a child, preserve its parent's feature-root value through every further
split, including when the parent is closed. If an older family has no marker,
read its actual parent links to the highest ancestor and use that issue.
Do not infer parentage from blockers. Keep the sub-issue links too.

When splitting, put both lines on every child at creation and retain them on
the parent. Each child still gets its own refinement run. Do not mark existing
running tickets retroactively or rewrite the backlog in bulk. A later normal
refinement can add the fields. A split parent's closure records replacement,
not completion of the feature. All required children must finish before the
feature is complete.

The policy date is not a fleet activation time. Record each consumer's merged
revision and observed first admission using it in the rollout evidence.
Compare work from the same feature family across all children, including
repairs, retries and unfinished work. Existing run records supply stage time,
cost and machine identity. Existing gate logs and central reservation records
supply verification and capacity time when retained. Missing lineage or
timing remains unknown. No saving is established by this policy change alone.
