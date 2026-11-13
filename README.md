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

## The contract

| What                | Value                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths               | `POST /v1/messages` (JSON, or server-sent events with `"stream": true`) and `GET /health`. Any other path gets 404                                                                                                                                                         |
| Port                | `BRIDGE_PORT`, default `8080`                                                                                                                                                                                                                                              |
| Listen address      | `BRIDGE_HOST`, default `127.0.0.1`. The manifest sets the address of the pod                                                                                                                                                                                               |
| Key                 | The bridge key of a trust domain in the `x-api-key` header. No key or a wrong key gets 401                                                                                                                                                                                 |
| Trust domains       | `main`, `finance` and `workflows`, with their keys in `BRIDGE_KEY_MAIN`, `BRIDGE_KEY_FINANCE` and `BRIDGE_KEY_WORKFLOWS`. A domain with no key is not served. The bridge does not start with no key, with a key of less than 32 characters, or with two domains on one key |
| Sign-in of the plan | `CLAUDE_CODE_OAUTH_TOKEN`, a token that `claude setup-token` makes. Only the engine processes get it                                                                                                                                                                       |
| Limits              | `BRIDGE_MAX_CONVERSATIONS` (default 8) live conversations, `BRIDGE_IDLE_SECONDS` (default 900) with no call before a conversation ends, `BRIDGE_CALL_SECONDS` (default 300) for one model call, `BRIDGE_MAX_BODY_MB` (default 32)                                          |
| Shutdown            | On SIGTERM, a drain of up to `BRIDGE_DRAIN_SECONDS` (default 75). Set the grace period of the pod above it                                                                                                                                                                 |
| Writable paths      | `/tmp` only (`BRIDGE_STATE_DIR`, default `/tmp/tnwks-model-bridge`). The root file system can be read-only. The user is 65532                                                                                                                                              |
| State               | In memory. Nothing is kept on a disk after a conversation ends                                                                                                                                                                                                             |

**Why `x-api-key`.** The model gateway is LiteLLM. For an Anthropic entry
with an `api_base` and an `api_key`, LiteLLM sends the key in `x-api-key`
(`_make_api_key_auth_header` in `litellm/llms/anthropic/common_utils.py`,
and `validate_anthropic_messages_environment` in
`litellm/llms/anthropic/messages/native/transformation.py`, the same at
v1.109.0 and v1.109.1). It sends `Authorization: Bearer` only with
`use_bearer_for_custom_base`, or for a key that starts with `sk-ant-oat`.
So the bridge reads `x-api-key` only, and a bridge key must not start with
`sk-ant-`. With its defaults, LiteLLM does not pass the key of its own
caller on (`forward_llm_provider_auth_headers` is off). The test in CI runs
LiteLLM in front of the bridge.

A gateway entry for a trust domain:

```yaml
- model_name: agents-main
  litellm_params:
    model: anthropic/<the model of the plan>
    api_base: http://model-bridge.ai.svc.cluster.local:8080
    api_key: os.environ/BRIDGE_KEY_MAIN
```

## What it does with a call

- **The trust domain** comes from the key. The bridge keeps the
  conversations of each trust domain apart, and it looks for the
  conversation of a call among those of its trust domain only.
- **The match.** A call goes on with a live conversation when the tool_use
  ids of its last answer are those of that conversation, or else when the
  hash of the model, the system prompt and the history is the same. A call
  with a different model or system prompt starts a new conversation.
- **The engine.** Each live conversation is one engine process of the SDK.
  It gets the system prompt and the tools of the caller, and nothing of its
  own: `tools: []`, `settingSources: []`, `skills: []`, no hooks,
  `strictMcpConfig` with only the in-process `client` server for the tools
  of the caller, `permissionMode: "dontAsk"`, `persistSession: false`, and
  the env `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  `ENABLE_TOOL_SEARCH=false`. Each engine has a home of its own under
  `/tmp`, and an env with no bridge key.
- **Tool calls.** The bridge runs no tool. A tool call goes back to the
  caller as the end of the answer, with the caller's own tool name. The
  engine waits, and the next call brings the result. The match of a result
  uses `_meta["claudecode/toolUseId"]` of the MCP call, a field that the SDK
  does not document. The test in CI has a tool call, so an update of the SDK
  that changes it fails there.
- **No live engine.** A call with a history and no live conversation (after
  the idle time, an eviction or a restart) starts a new engine. The history
  goes in as one text: a JSON list with one part on each line, and each
  part a list of JSON strings (role, kind, content). A line in a tool result
  stays inside its quoted string. The structure of the earlier tool calls,
  thinking blocks and images is lost.
- **What it does not carry.** The engine sets its own cache marks, and the
  API takes four at the most, so the bridge removes the marks of the caller.
  It drops each top-level field but `model`, `messages`, `system`, `tools`,
  `max_tokens`, `stream`, `thinking` and `output_config` (for example
  `temperature`, `tool_choice`, `metadata`), and the log names them.
- **Thinking and effort.** `thinking` goes to the SDK option of the same
  name, with its `display` (`summarized` or `omitted`; another display is
  dropped as `thinking.display`). `output_config.effort` (`low`, `medium`,
  `high`, `xhigh` or `max`) goes to the SDK `effort` option when the engine
  starts. A later call with another effort changes it with
  `applyFlagSettings`, and the engine uses it from its next user turn: a
  change inside a tool round waits for the next turn. Each other key of
  `output_config` (for example `format`) is dropped, and the log names it
  as `output_config.<key>`.
- **The name.** The bridge names itself to the vendor with the documented
  `CLAUDE_AGENT_SDK_CLIENT_APP` (`tnwks-model-bridge/<version>`). It adds no
  header and no prompt text, and removes nothing from a prompt.
- **The limits.** At the limit of live conversations, a new conversation
  ends the one that was idle for the longest time. When each live
  conversation has a call in work, the bridge answers 529. A second call
  for a conversation with a call in work gets 409.
- **Shutdown.** On SIGTERM the bridge drains. `/health` answers 503, the
  server takes no new connection, and a call that still comes on an open
  connection gets 503 with `overloaded_error` and the words "service
  unavailable" and "try again", so a caller tries again on the next pod.
  The calls in work run to their end. At `BRIDGE_DRAIN_SECONDS` the bridge
  cuts each call that is left with the same error (an `error` event in a
  stream that started, else 503), ends each conversation and exits. A call
  that ended with a tool call is not lost: its result goes to the next pod
  as a rebuilt conversation.

**What the engine changes in a call.** Before the system prompt of the
caller it puts a billing line and "You are a Claude agent, built on
Anthropic's Claude Agent SDK." It adds a system message with the
environment, the model and the date, and its own `metadata` and
`output_config`. The user agent names Claude Code, the SDK and the bridge.

## The log

One JSON line on standard output for each call: `domain`, `model`,
`conversation` (a short hash of a random id), `mode` (`new`, `matched` or
`rebuilt`), `effort` (the effort of the call, or null), `status`, `ms`,
`dropped` (field names) and
`cache_marks_removed`. A refused call (401) has `status` and `ms` only.
The other lines: `listening`, `engine_init` (the engine version, the count
of tools, any tool that is not of the caller, the MCP servers, the
permission mode), `conversation_end` with its reason, `engine_error` with
its kind, and `orphan_model_call` (a model call of the engine with no call
of a caller, with its model), `drain_start` and `drain_end` (the count of
calls cut).

A `rebuild` line tells why a call with a history matched no live
conversation. It changes nothing. Among the live conversations of the
trust domain and the model (`live`), it takes the closest one (`closest`):
the same system prompt first (`same_system`), then the longest part in
common. With no conversation of the same system prompt, `system_changed`
tells whether a live one had another system prompt. `diff` is the first
place where the history of the call differs from the history that the
closest conversation expects: `message` and `block` (indexes in the list of
the caller), `kind` and `got` (`text`, `tool_use`, `tool_result`, `role`,
`missing`, `extra` or `none`), and `common` (the count of messages before
it that are the same); null when they are the same. `closed` is the reason
when the match found a conversation and ended it (for example
`tools_changed`). Positions and kinds only.

The log never holds a text of a
conversation, a header or a key: the test in CI checks it with marker
texts.

## Tests

- `npm test`: unit tests of the pure parts (`test/`).
- `tests/test_bridge.py`: the bridge with the engine, against a mock
  upstream (`tests/mock-model/`) that refuses more than four cache marks,
  as the API does. In CI, `bin/image-test` runs it on the image before any
  push: two containers with a read-only root file system, the mock, and
  LiteLLM in front (`tests/model-gateway/`). On a workstation,
  `cd tests && python3 -m unittest -v test_bridge` runs it on the source,
  with processes on the loopback address only. Each value is fake.

The test does not show what the vendor does: a mock does not have each rule
of the API. A turn on the plan after each change is the check for that.

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
