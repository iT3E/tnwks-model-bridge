# AGENTS.md

How to work in this repo. It follows the app-repo standard in
[iT3E/app-repo-template](https://github.com/iT3E/app-repo-template), which
manages most of the repo setup (`.copier-answers.yml` lists the release);
tnwks-ops is the reference for anything not covered there.

## What this is

The model bridge of the tnwks agent platform, in Node: `POST /v1/messages`
in, the unmodified Claude Agent SDK out, behind the model gateway. CI builds
the image `ghcr.io/it3e/tnwks-model-bridge`, which is public. tnwks-ops
deploys it from `kubernetes/apps/ai/model-bridge/`. `README.md` has the
contract. The design is effort 0003 in tnwks-coe (Design Doc 4.2.4,
ADR-018).

- `src/bridge.mjs` is the HTTP service, `src/conversation.mjs` the engine
  processes and their registry, `src/messages.mjs` the pure parts (unit
  tests in `test/`).
- The SDK and its peers are pinned exactly in `package.json` and the lock
  file. Check each engine option against the type file (`sdk.d.ts`) of the
  pinned release before you change it.
- Nothing that disguises the client: no header or prompt text that
  imitates Claude Code, nothing removed from a prompt. The bridge names
  itself only with `CLAUDE_AGENT_SDK_CLIENT_APP`.
- The log never holds a text of a conversation, a header or a key.
- The image test (`bin/image-test`, `tests/`) runs in CI only. Do not run
  `task test` or a container on a workstation that runs a live cluster in
  Docker; run `cd tests && python3 -m unittest -v test_bridge` instead,
  which uses processes on the loopback address and a mock upstream.
- No real credential in a test, a file or a log. The tests use fake values.

## Change workflow

- Every change goes through a PR, squash-merged. Never push to `main`.
  GitHub Free has no rulesets on private repos, so nothing enforces this
  except you: merge with `gh-merge-safe.sh <pr> iT3E/<this repo>`, which
  refuses unless every check passed. Renovate merges its own PRs only when
  every check is green (`ignoreTests: false`).
- Install the hooks once per clone: `task precommit:init`.
- Add a Changie fragment (`changie new`, under `.changes/unreleased/`) or
  label the PR `skip-changelog` (docs, CI-only, chores). Merging fragments
  cuts a release: `release.yaml` tags `vX.Y.Z` and builds `:X.Y.Z`. Kinds:
  Fixed/Security are a patch, Added/Changed/Deprecated/Removed a minor,
  Breaking a major.
- Renovate PRs carry no fragment. A merged one that changed what goes into
  the image (dependencies, the Dockerfile) releases a patch by itself
  (`auto-fragment`, "Dependency updates"); template and CI-only updates
  release nothing. A PR by a person always brings its own fragment.
- Image tags: only a release tag pushes, as `:<version>` and
  `:sha-<short>`; `main` builds without pushing. tnwks-ops pins
  `:<version>@sha256`, so a release reaches the cluster only when a
  tnwks-ops PR moves that pin.
- Checks: `build.yaml` (npm ci, lint, prettier --check, `npm test`, `npm run build`, the Docker build and its tests), `privacy`, `betterleaks`, `changelog`,
  `actionlint` (workflow changes only), and the labeler. Locally: `task test`,
  `task lint` (run `npm ci` first; the hooks use the
  repo's own prettier).
- The workflows are thin callers of the reusable workflows in
  iT3E/github-workflows, pinned by the template, and the files listed in
  app-repo-template's README are managed by Copier. Change them there; a
  template release reaches this repo as a
  `copier update` PR (Renovate, label `renovate/template`, merged by
  Renovate when green, or `task template:update`). A local edit to a managed file survives
  updates, but keep those rare.

## Privacy

The image is public, and the same rules as tnwks-ops apply here: no family
names (first names, nicknames, surname), personal email addresses, schools,
ages, addresses or anything else that says who is who. That covers files,
paths, commit messages, your git identity, PR and issue titles and bodies,
comments and reviews.

- `bin/privacy-check` checks the tnwks-ops denylist. CI reads it from the
  `PRIVACY_TERMS` secret (`task privacy:sync` refreshes it); locally it
  reads `$PRIVACY_TERMS` or a tnwks-ops checkout at `../tnwks-ops`.
- Before posting a PR body, comment or review, write it to a file, run
  `bin/privacy-check --text < file`, and post with `--body-file`.
- Exceptions (`.github/privacy-allow`, `privacy:allow` on a line) are the
  owner's call. Don't add one to get a PR through.
- Never put a credential in a file or doc. Secrets are SOPS Secrets in
  tnwks-ops and reach the service as env vars.

## Writing

Plain prose, short sentences. No emdashes in new prose (use a comma, colon
or parentheses). No AI-attribution trailers in commits.
