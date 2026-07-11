# Releasing

Every release is: version stamp → quality gate → commit → annotated tag → push → GitHub
release. One command runs the whole sequence so no step is ever forgotten:

```sh
just release 2.13.0
```

Requires: a clean working tree, `main` checked out and in sync with `origin/main`, and the
[`gh` CLI](https://cli.github.com/) authenticated.

## What the recipe does (also the manual recovery steps)

1. **Preflight** — refuses to run unless the tree is clean, the branch is `main`, and `HEAD`
   matches `origin/main`.
2. **Version stamp** — sets `X.Y.Z` in `package.json` (+ lockfile) _and_ `src/version.ts`.
   These two must always match; the recipe guarantees it (the drift has happened by hand).
3. **Quality gate** — `npm run check`, `npm run check:types`, `npm test`, `npm run build`.
   Any failure aborts before anything is committed.
4. **Commit** — `release: vX.Y.Z`.
5. **Tag** — annotated `vX.Y.Z` on that commit.
6. **Push** — `git push origin main --follow-tags`.
7. **GitHub release** — `gh release create vX.Y.Z --generate-notes`. Edit the generated notes
   afterwards when a release deserves narrative (breaking changes, migration hints).

## Versioning

Semver by intent: **major** for breaking changes to the MCP tool surface, CLI contracts, or
stored-data formats; **minor** for features; **patch** for fixes. Feature work that lands
between releases keeps bumping the version in its own commits — the release recipe accepts the
next version explicitly and re-stamps, so intermediate bumps are harmless.

## What a release is _not_

Deployment. Operators pull/rebuild from a tag (or `main`) on their own schedule — the Docker
image builds from the checked-out source, and `/seed` content ships inside the image (never
declare it a VOLUME; see the Dockerfile comment).
