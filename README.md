# tnwks-model-bridge

The model bridge of the tnwks agent platform: a small Node service that
takes a call in the form of the Anthropic Messages API and runs it through
the unmodified Claude Agent SDK. It sits behind the model gateway, so an
agent can use the Claude plan of the owner with each model call at the
gateway. The design is effort 0003 of the tnwks Center of Excellence
(section 4.2.4 of its Design Doc).

The image is `ghcr.io/it3e/tnwks-model-bridge`, public. tnwks-ops deploys
it from `kubernetes/apps/ai/model-bridge/`, next to the model gateway in the
namespace `ai`, pinned as `:<version>@sha256:<digest>`.

## Status

This is the start of the repository: the app template, the Node package
with the Claude Agent SDK at a pinned release, the pure parts of the bridge
with their unit tests, and the image build. The service, its contract and
its tests in CI come in the next change.

## Workflow

This repo follows the app-repo standard in
[iT3E/app-repo-template](https://github.com/iT3E/app-repo-template), with
CI from [iT3E/github-workflows](https://github.com/iT3E/github-workflows);
`AGENTS.md` has the short version.

- Changes go through PRs, never straight to `main`. Merge only when every
  check is green (`gh-merge-safe.sh <pr> iT3E/tnwks-model-bridge`).
- `task precommit:init` installs the hooks: betterleaks, the privacy
  denylist (staged files, git identity, commit message) and prettier (after `npm ci`).
- Each PR adds a Changie fragment (`changie new`) or carries the
  `skip-changelog` label. Merging fragments cuts a release (`vX.Y.Z` tag,
  GitHub Release, image `:X.Y.Z`).
- Renovate keeps dependencies current. Patch, digest and non-0.x minor
  updates merge themselves once CI is green; majors wait for review on the
  Renovate Dashboard issue. Template releases arrive as their own
  `renovate/template` PRs. The SDK is at 0.x, so a patch of the SDK merges
  when CI is green, and a minor waits for review.
