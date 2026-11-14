# Changelog

Notable changes to this repository, newest first. Each PR adds a Changie
fragment under `.changes/unreleased/`; merging to `main` releases them.

## v0.2.3 - 2026-11-14

### Fixed

* The usage limit of the Claude plan is now 429 with rate_limit_error, before a stream starts, with a retry-after only from the plan's own reset time. The call line logs the real status of a failed call (error_in_stream for an error event), and a failed turn logs one engine_error with a clear kind, never success.

## v0.2.2 - 2026-11-13

### Fixed

* The effort of a call now reaches the engine: output_config.effort goes to the SDK effort option, and a later call with another effort changes it from the next user turn. The display of thinking (summarized or omitted) goes through. Other output_config keys are still dropped, and the log names each one as output_config.<key>. The call line of the log has the effort

## v0.2.1 - 2026-11-12

### Fixed

* A stop of the pod no longer cuts a call in work. On SIGTERM the bridge drains for up to BRIDGE_DRAIN_SECONDS (default 75): /health answers 503, a new call gets 503 overloaded_error that tells the caller to try again, and the calls in work run to their end. At the deadline it cuts what is left with the same retryable error. A rebuild line in the log now tells why a call with a history matched no live conversation (positions and kinds only)

## v0.2.0 - 2026-11-12

### Added

* The model bridge: POST /v1/messages and GET /health, a key for each trust domain in x-api-key, the conversations of each trust domain apart, the history as quoted strings when no engine is live, limits of idle time and of live conversations, and a log with no text of a conversation. Its tests run on the image in CI, with a mock upstream and the model gateway in front

## v0.1.0 - 2026-11-12

### Added

* The repository of the model bridge, from the app template: the Node package with the Claude Agent SDK pinned at 0.3.322, the pure parts of the bridge with their unit tests, and the image build
