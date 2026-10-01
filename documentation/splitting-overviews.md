# Splitting an oversized package overview: Pyrycode documentation

Read this when your prompt carries the dispatcher's `## Oversized package overviews` note and this ticket's lessons belong in one of the documents it lists, or when `make docs-guard` reports an overview over the cap.

## Why it cannot wait

Search cuts a document into chunks of roughly 900 tokens and prefers to cut at a heading, but it only looks for one near each cut. When a document's sections are far larger than a chunk, the cut lands on a paragraph break and the chunk carries no heading. On 2026-08-31 three different searches aimed at a topic whose home was a section of a 315 KB overview did not return that file at all. A lesson folded into a document that size is a lesson lost. `make docs-guard` fails the build on any overview over 50000 bytes, so leaving one behind also turns the gate red for every open PR.

So split the document before you write to it.

## How

- Cut at `##` headings. Where a `##` section is itself over the cap, cut it at its `###` headings. A section under 3000 bytes stays in the parent.
- Aim for about 20000 bytes per child. Name each child `<parent-stem>-<section-slug>.md`, in the same directory as the parent.
- Keep the parent at its own path. It keeps its title and intro prose, and its body becomes a table linking to the children with a one-line topic per row. Every agent prompt names the parent path and hundreds of documents link to it, so that path must keep resolving.
- Retarget every inbound `#anchor` link that pointed at a section you moved.
- Add each child to `docs/knowledge/CATALOG.md`. The dispatcher's note also asks for a row in `docs/knowledge/INDEX.md` for each child. INDEX is the short startup map, so add a child there only when it is a startup topic, as the role file says.
- Then fold this ticket's lesson into the child that owns the section, and run `make docs-guard`.
