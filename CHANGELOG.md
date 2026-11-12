# Changelog

Notable changes to this repository, newest first. Each PR adds a Changie
fragment under `.changes/unreleased/`; merging to `main` releases them.

## v0.2.0 - 2026-11-12

### Added

* The model bridge: POST /v1/messages and GET /health, a key for each trust domain in x-api-key, the conversations of each trust domain apart, the history as quoted strings when no engine is live, limits of idle time and of live conversations, and a log with no text of a conversation. Its tests run on the image in CI, with a mock upstream and the model gateway in front

## v0.1.0 - 2026-11-12

### Added

* The repository of the model bridge, from the app template: the Node package with the Claude Agent SDK pinned at 0.3.322, the pure parts of the bridge with their unit tests, and the image build
