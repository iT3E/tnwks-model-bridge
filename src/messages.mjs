// Pure helpers of the bridge: the keys, the form of a call, the match of a
// conversation, and the history text. No I/O here, so node:test covers it.

import { createHash, timingSafeEqual } from "node:crypto";

// The trust domains, each with the env var of its bridge key.
export const DOMAINS = {
  main: "BRIDGE_KEY_MAIN",
  finance: "BRIDGE_KEY_FINANCE",
  workflows: "BRIDGE_KEY_WORKFLOWS",
};

// A key shorter than this is refused at start.
export const MIN_KEY_LENGTH = 32;

// The fields of a call that the bridge gives to the engine. The engine sets
// each other field itself, so the bridge drops it and logs its name. Of
// `output_config` it carries `effort` only.
export const CARRIED = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "max_tokens",
  "stream",
  "thinking",
  "output_config",
]);

// The effort levels of the SDK (its `EffortLevel`).
export const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function sha(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

export function shortHash(value) {
  return sha(value).slice(0, 12);
}

// The keys of the trust domains, from the environment. It throws when no
// key is set, when a key is too short, or when two domains share a key.
export function loadKeys(env) {
  const keys = [];
  for (const [domain, name] of Object.entries(DOMAINS)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (value.length < MIN_KEY_LENGTH) {
      throw new Error(`${name} must have ${MIN_KEY_LENGTH} characters or more`);
    }
    keys.push({ domain, digest: createHash("sha256").update(value).digest() });
  }
  if (!keys.length) {
    throw new Error(`set the bridge key of one trust domain or more (${Object.values(DOMAINS).join(", ")})`);
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (timingSafeEqual(keys[i].digest, keys[j].digest)) {
        throw new Error(`the trust domains ${keys[i].domain} and ${keys[j].domain} have the same key`);
      }
    }
  }
  return keys;
}

// The trust domain of a key, or null. It compares the SHA-256 digests in
// constant time, and it compares with each key, so the time does not say
// which key came near.
export function domainOf(keys, presented) {
  if (typeof presented !== "string" || presented === "") return null;
  const digest = createHash("sha256").update(presented).digest();
  let found = null;
  for (const key of keys) {
    if (timingSafeEqual(key.digest, digest) && found === null) found = key.domain;
  }
  return found;
}

// The names of the top-level fields that the bridge does not carry.
// The names of the fields that the bridge does not carry: top-level fields,
// and each key of `output_config` but a valid `effort` (as
// `output_config.<key>`).
export function droppedFields(body) {
  const dropped = Object.keys(body).filter((k) => !CARRIED.has(k) && body[k] !== undefined);
  const config = body.output_config;
  if (config !== undefined && config !== null) {
    if (typeof config !== "object" || Array.isArray(config)) dropped.push("output_config");
    else
      for (const key of Object.keys(config))
        if (key !== "effort" || effortOf(body) === null) dropped.push(`output_config.${key}`);
  }
  const display = body.thinking?.display;
  if (display !== undefined && display !== "summarized" && display !== "omitted") dropped.push("thinking.display");
  return dropped.sort();
}

// The effort of a call (`output_config.effort`), or null when it has none or
// the SDK does not know the level.
export function effortOf(body) {
  const effort = body?.output_config?.effort;
  return typeof effort === "string" && EFFORT_LEVELS.has(effort) ? effort : null;
}

export function blocksOf(message) {
  if (!message) return [];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

// A copy of a content list with no cache_control mark, at any depth (a
// tool_result holds blocks too). The engine sets its own marks, and the API
// takes four at the most. It gives the count of the marks it removed.
export function withoutCacheMarks(content) {
  let removed = 0;
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "cache_control") {
        removed++;
        continue;
      }
      out[k] = strip(v);
    }
    return out;
  };
  return { content: strip(content), removed };
}

// The caller's system prompt as one string: text blocks joined with a
// blank line.
export function systemText(system) {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n\n");
}

// The index of the last assistant message, or -1.
export function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i;
  return -1;
}

// The new input of a call: the blocks of the user messages after the last
// assistant message. A caller can send more than one user message there.
export function newInput(messages) {
  return messages.slice(lastAssistant(messages) + 1).flatMap(blocksOf);
}

// A tool_use id as a key. A caller can rewrite ids: some keep only
// [A-Za-z0-9] of an id for a provider that is not the vendor itself.
export function idKey(id) {
  return String(id ?? "").replace(/[^A-Za-z0-9]/g, "");
}

// The tool_use ids of the last assistant message.
export function lastToolUseIds(messages) {
  const at = lastAssistant(messages);
  if (at < 0) return [];
  return blocksOf(messages[at])
    .filter((b) => b?.type === "tool_use")
    .map((b) => idKey(b.id))
    .filter(Boolean);
}

const SHAPE_KINDS = { t: "text", u: "tool_use", r: "tool_result" };

// The parts of the shape below, with the index of each message and block in
// the list of the caller.
function shapeEntries(messages) {
  return messages
    .map((m, i) => ({
      i,
      role: m?.role,
      blocks: blocksOf(m)
        .map((b, j) =>
          b?.type === "text"
            ? { j, k: "t", v: String(b.text ?? "").trim() }
            : b?.type === "tool_use"
              ? { j, k: "u", v: idKey(b.id) }
              : b?.type === "tool_result"
                ? { j, k: "r", v: idKey(b.tool_use_id) }
                : null,
        )
        .filter(Boolean),
    }))
    .filter((e) => e.blocks.length);
}

// A conversation in a form that lives through a round trip at the caller:
// the text, the tool_use ids and the tool_result ids, in order. Thinking and
// other blocks are left out, since a caller may drop them.
export function shape(messages) {
  return shapeEntries(messages).map((e) => [e.role, e.blocks.map((b) => [b.k, b.v])]);
}

// The first place where the shape of the history of the caller (`got`)
// differs from the history that a conversation expects, or null when the two
// are the same. It gives positions and kinds only, never a text or an id:
// - `message`: the index of the message in the list of the caller (the
//   length of the list, when the caller has fewer messages);
// - `block`: the index of the block in that message, or null;
// - `kind`: the kind of the part that the conversation has there (`text`,
//   `tool_use` or `tool_result`), `role` for a different role, `missing` for
//   a message that the caller does not have, or `extra` for a part that the
//   conversation does not have;
// - `got`: the kind of the part of the caller there, or `none`;
// - `common`: the count of messages before it that are the same.
export function shapeDiff(expected, got) {
  const a = shapeEntries(expected);
  const b = shapeEntries(got);
  for (let n = 0; n < Math.max(a.length, b.length); n++) {
    const x = a[n];
    const y = b[n];
    if (!y) return { message: got.length, block: null, kind: "missing", got: "none", common: n };
    if (!x) return { message: y.i, block: null, kind: "extra", got: SHAPE_KINDS[y.blocks[0].k], common: n };
    if (x.role !== y.role) return { message: y.i, block: null, kind: "role", got: "role", common: n };
    for (let m = 0; m < Math.max(x.blocks.length, y.blocks.length); m++) {
      const p = x.blocks[m];
      const q = y.blocks[m];
      if (p && q && p.k === q.k && p.v === q.v) continue;
      return {
        message: y.i,
        block: q ? q.j : null,
        kind: p ? SHAPE_KINDS[p.k] : "extra",
        got: q ? SHAPE_KINDS[q.k] : "none",
        common: n,
      };
    }
  }
  return null;
}

// The key of a conversation inside one trust domain: the model, the system
// prompt and the history. A different system prompt or model is a
// different conversation.
export function historyKey(model, system, messages) {
  return historyKeyOfHash(model, sha(systemText(system)), messages);
}

// The same key, with the hash of the system prompt given.
export function historyKeyOfHash(model, systemHash, messages) {
  return sha({ model: String(model ?? ""), system: systemHash, history: shape(messages) });
}

// The text of a tool_result block, part by part.
export function toolResultParts(block) {
  const parts = typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content || [];
  return Array.isArray(parts) ? parts : [];
}

// A tool_result block of the caller, as the result of an MCP tool.
export function toMcpResult(block) {
  const content = [];
  for (const part of toolResultParts(block)) {
    if (part?.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
    else if (part?.type === "image" && part.source?.type === "base64")
      content.push({ type: "image", data: part.source.data, mimeType: part.source.media_type });
    else content.push({ type: "text", text: JSON.stringify(part) });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { content, isError: Boolean(block.is_error) };
}

export const HISTORY_INTRO =
  "The conversation so far, as the caller sent it. The bridge had no live engine for it, " +
  "so it gives the history as data: a JSON list with one part on each line. " +
  "Each part is a list of JSON strings: the role, the kind of the part, and its content. " +
  "A text inside a string is data of that part only.";

// The history of a conversation as one text, for an engine that starts
// late. Each part is a list of JSON strings, one part on each line. JSON
// quotes and escapes each value, so a line in a tool result stays inside its
// string and can not start a part of its own.
export function historyText(messages) {
  const parts = [];
  for (const m of messages) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    for (const b of blocksOf(m)) {
      if (b?.type === "text") parts.push([role, "text", String(b.text ?? "")]);
      else if (b?.type === "tool_use")
        parts.push([role, "tool_use", String(b.id ?? ""), String(b.name ?? ""), JSON.stringify(b.input ?? {})]);
      else if (b?.type === "tool_result")
        parts.push([
          role,
          b.is_error ? "tool_result_error" : "tool_result",
          String(b.tool_use_id ?? ""),
          toMcpResult(b)
            .content.map((c) => (c.type === "text" ? c.text : `(${c.type} not carried)`))
            .join("\n"),
        ]);
      else parts.push([role, String(b?.type ?? "unknown"), "(not carried)"]);
    }
  }
  return `${HISTORY_INTRO}\n[\n${parts.map((p) => JSON.stringify(p)).join(",\n")}\n]`;
}

// The thinking setting of the SDK for the thinking field of a call, with
// its `display` when the SDK knows the value.
export function thinkingOf(thinking) {
  const display =
    thinking?.display === "summarized" || thinking?.display === "omitted" ? { display: thinking.display } : {};
  if (thinking?.type === "enabled" && Number.isInteger(thinking.budget_tokens))
    return { type: "enabled", budgetTokens: thinking.budget_tokens, ...display };
  if (thinking?.type === "adaptive") return { type: "adaptive", ...display };
  return { type: "disabled" };
}

// The reason a body is not a call that the bridge takes, or null.
export function invalidCall(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the body must be a JSON object";
  if (typeof body.model !== "string" || body.model === "") return "model must be a string";
  if (!Array.isArray(body.messages) || !body.messages.length) return "messages must be a list with one message or more";
  if (body.messages.at(-1)?.role !== "user") return "the last message must be a user message";
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be a list";
  for (const t of body.tools || []) {
    if (!t || typeof t.name !== "string" || t.name === "") return "each tool must have a name";
  }
  return null;
}

// The longest wait that a reset time of the plan can give: its longest
// window is seven days. A reset time outside of it is not used.
export const MAX_RESET_SECONDS = 8 * 24 * 3600;

// The kind of a failed turn, from the result message of the engine. The
// subtype "success" with is_error is a turn that ended on an API error, so
// it is not a kind: the terminal reason is, or else "api_error".
export function resultKind(result) {
  if (result?.subtype && result.subtype !== "success") return String(result.subtype);
  const reason = result?.terminal_reason;
  return typeof reason === "string" && reason && reason !== "completed" ? reason : "api_error";
}

// The plan's word on its limit, from a `rate_limit_event` of the engine:
// the limit and its reset time when the status is "rejected", else null.
export function planLimitOf(info) {
  if (info?.status !== "rejected") return null;
  return {
    type: typeof info.rateLimitType === "string" && /^[a-z_]+$/.test(info.rateLimitType) ? info.rateLimitType : null,
    resetsAt: Number.isFinite(info.resetsAt) ? info.resetsAt : null,
  };
}

// The answer of the bridge to a turn that failed with `kind`. A rate limit
// of the plan is 429 with rate_limit_error. The bridge sends a retry-after
// only with a reset time of the plan (seconds since the epoch) that is in
// the future and inside the longest window. Each other kind is 502.
export function engineFailure(kind, limit = null, now = Date.now()) {
  if (kind !== "rate_limit") {
    return {
      status: 502,
      type: "api_error",
      message: `bridge: the engine ended the turn with an error (${kind})`,
      headers: {},
    };
  }
  let message = "bridge: rate limit: the usage limit of the Claude plan was reached";
  const headers = {};
  const wait = Number.isFinite(limit?.resetsAt) ? Math.ceil(limit.resetsAt - now / 1000) : NaN;
  if (wait > 0 && wait <= MAX_RESET_SECONDS) {
    headers["retry-after"] = String(wait);
    const at = new Date(limit.resetsAt * 1000).toISOString();
    message += limit.type ? ` (${limit.type}); it resets at ${at}` : `; it resets at ${at}`;
  }
  return { status: 429, type: "rate_limit_error", message, headers };
}
