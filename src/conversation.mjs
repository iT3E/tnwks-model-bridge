// The conversations of the bridge. One engine process of the Claude Agent
// SDK for each live conversation, and a registry for each trust domain, so a
// call can match only a conversation of its own trust domain.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  effortOf,
  engineFailure,
  historyKey,
  historyKeyOfHash,
  historyText,
  idKey,
  lastAssistant,
  lastToolUseIds,
  newInput,
  planLimitOf,
  resultKind,
  sha,
  shapeDiff,
  shortHash,
  systemText,
  thinkingOf,
  toMcpResult,
  withoutCacheMarks,
} from "./messages.mjs";

const SERVER = "client";
const PREFIX = `mcp__${SERVER}__`;

// The environment variables that an engine process gets from the bridge.
// The bridge keys are not in the list, so an engine never holds them.
const ENGINE_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

// A queue that the SDK reads as its stream of input.
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function errorBody(type, message) {
  return { type: "error", error: { type, message } };
}

// The error type of a status of the bridge. 529 and 503 tell the caller to
// try again (the drain at shutdown uses 503); 429 is a rate limit.
function errorType(status) {
  if (status === 529 || status === 503) return "overloaded_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

// Where the events of one model call go: a stream of server-sent events, or
// one JSON body. A stream starts (status 200 and its headers) with its first
// event, so an error before it is an HTTP error. `onEnd(status, inStream)`
// runs one time, when the call ends: the status of the answer, or of the
// error, and whether the error went as an `error` event in a stream.
export class Sink {
  constructor({ res, stream, conversation, mode, callMs, onEnd }) {
    this.res = res;
    this.stream = stream;
    this.done = false;
    this.status = 200;
    this.inStream = false;
    this.onEnd = onEnd;
    this.headers = { "x-bridge-conversation": conversation.ref, "x-bridge-mode": mode };
    this.timer = setTimeout(() => {
      this.fail(504, "bridge: the model call did not end in time");
      conversation.close("call_timeout");
    }, callMs);
  }
  start() {
    if (this.res.headersSent) return;
    this.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...this.headers,
    });
  }
  event(ev) {
    if (this.done || !this.stream) return;
    this.start();
    this.res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  end() {
    this.done = true;
    clearTimeout(this.timer);
    this.onEnd?.(this.status, this.inStream);
  }
  finish(message) {
    if (this.done) return;
    if (this.stream) {
      this.start();
      this.res.end();
    } else {
      this.res.writeHead(200, { "content-type": "application/json", ...this.headers });
      this.res.end(JSON.stringify(message));
    }
    this.end();
  }
  fail(status, text, type = errorType(status), headers = {}) {
    if (this.done) return;
    const body = errorBody(type, text);
    this.status = status;
    if (this.stream && this.res.headersSent) {
      this.inStream = true;
      this.res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      this.res.end();
    } else {
      this.res.writeHead(status, { "content-type": "application/json", ...headers });
      this.res.end(JSON.stringify(body));
    }
    this.end();
  }
  // The caller closed the connection before the end.
  gone() {
    if (this.done) return;
    this.status = 499;
    this.end();
  }
}

// The live conversations of all trust domains, with the limits.
export class Registry {
  constructor({ maxConversations, idleMs, callMs, stateDir, clientApp, log }) {
    this.maxConversations = maxConversations;
    this.idleMs = idleMs;
    this.callMs = callMs;
    this.stateDir = stateDir;
    this.workDir = join(stateDir, "work");
    this.clientApp = clientApp;
    this.log = log;
    this.all = new Set();
    this.domains = new Map();
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
  }

  domain(name) {
    if (!this.domains.has(name)) this.domains.set(name, { byToolUse: new Map(), byHistory: new Map() });
    return this.domains.get(name);
  }

  // The live conversation of a call in its trust domain, or null. First by
  // the tool_use ids of the last answer, then by the hash of the model, the
  // system prompt and the history. A match needs the same model and system
  // prompt as the conversation has.
  //
  // For a call with a history and no match, it puts the reason of the miss
  // in `miss` (see `explainMiss`), before it closes a conversation.
  find(domainName, body, miss = {}) {
    const domain = this.domain(domainName);
    const at = lastAssistant(body.messages);
    if (at < 0) return null;
    let conversation = null;
    for (const id of lastToolUseIds(body.messages)) {
      conversation = domain.byToolUse.get(id) || null;
      if (conversation) break;
    }
    const key = historyKey(body.model, body.system, body.messages.slice(0, at + 1));
    if (!conversation) conversation = domain.byHistory.get(key) || null;
    const missed = (closed) => {
      Object.assign(miss, this.explainMiss(domainName, body), { closed });
      if (closed) conversation.close(closed);
      return null;
    };
    if (!conversation || conversation.closed) return missed(null);
    if (conversation.model !== body.model || conversation.systemHash !== sha(systemText(body.system)))
      return missed("system_or_model_changed");
    const answered = newInput(body.messages).some((b) => b?.type === "tool_result");
    if (conversation.unanswered() && !answered) return missed("tool_results_missing");
    const names = new Set((body.tools || []).map((t) => t.name));
    const own = conversation.toolNames;
    if (names.size !== own.size || [...names].some((n) => !own.has(n))) return missed("tools_changed");
    domain.byHistory.delete(key);
    return conversation;
  }

  // Why the history of a call matched no live conversation. It compares the
  // history with each live conversation of the same trust domain and model,
  // and takes the closest one: one with the same system prompt first, then
  // the one with the longest part in common. Counts, positions and kinds
  // only: no text, no id and no hash of a content.
  // - `live`: the count of live conversations of the domain and the model;
  // - `same_system`: one of them has the system prompt of the call;
  // - `system_changed`: with no such one, a live one has another system
  //   prompt (so the system prompt of the caller changed);
  // - `diff`: the first difference of the history against the closest one
  //   (`shapeDiff`), or null when the histories are the same;
  // - `closest`: the reference of the closest one, as in the log already.
  explainMiss(domainName, body) {
    const systemHash = sha(systemText(body.system));
    const history = body.messages.slice(0, lastAssistant(body.messages) + 1);
    const live = [...this.all].filter((c) => !c.closed && c.domainName === domainName && c.model === body.model);
    const out = { live: live.length, same_system: live.some((c) => c.systemHash === systemHash) };
    if (!out.same_system) out.system_changed = live.length > 0;
    // The rank of a conversation: the same system prompt, then the count of
    // messages in common, then the block of the difference.
    const later = (a, b) => {
      const i = a.findIndex((v, n) => v !== b[n]);
      return i >= 0 && a[i] > b[i];
    };
    let best = null;
    for (const c of live) {
      const diff = shapeDiff(c.expected(), history);
      const rank = [c.systemHash === systemHash ? 1 : 0, diff ? diff.common : Infinity, diff?.block ?? -1];
      if (!best || later(rank, best.rank)) best = { c, diff, rank };
    }
    if (best) Object.assign(out, { closest: best.c.ref, diff: best.diff });
    return out;
  }

  // Room for one more conversation: true, or false when each live
  // conversation has a call in work. At the limit it ends the conversation
  // that was idle for the longest time.
  makeRoom() {
    if (this.all.size < this.maxConversations) return true;
    const idle = [...this.all].filter((c) => !c.sink).sort((a, b) => a.touched - b.touched);
    if (!idle.length) return false;
    idle[0].close("evicted");
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const c of [...this.all]) if (!c.sink && now - c.touched > this.idleMs) c.close("idle");
  }

  closeAll(reason) {
    for (const c of [...this.all]) c.close(reason);
  }

  waitingToolCalls() {
    let n = 0;
    for (const c of this.all) n += c.unanswered();
    return n;
  }
}

export class Conversation {
  constructor(registry, domainName, body) {
    this.registry = registry;
    this.domainName = domainName;
    this.domain = registry.domain(domainName);
    this.log = registry.log;
    this.id = randomUUID();
    this.ref = shortHash(this.id);
    this.model = body.model;
    this.systemHash = sha(systemText(body.system));
    // The tools of the caller that an engine can carry: those with a schema.
    this.tools = (body.tools || []).filter((t) => t.type === undefined || t.type === "custom");
    this.toolNames = new Set((body.tools || []).map((t) => t.name));
    // The effort of the caller (output_config.effort), or null for the
    // default effort of the model.
    this.effort = effortOf(body);
    this.inbox = new Inbox();
    this.sink = null;
    this.calls = new Map(); // tool_use id key -> { name, resolve, result, handled }
    this.current = null;
    this.parts = new Map();
    this.history = [];
    // The history that the caller has after the last model call.
    this.answered = null;
    this.touched = Date.now();
    this.closed = false;
    this.stderrBytes = 0;
    // The error of the API in the turn in work, and the last word of the
    // plan on its limit (planLimitOf).
    this.turnError = null;
    this.planLimit = null;
    // A home of its own for each engine: its config and its temporary files.
    this.home = mkdtempSync(join(registry.stateDir, "conv-"));
    registry.all.add(this);

    const mcp = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.input_schema || { type: "object" },
        // Each tool up front, not behind the tool search of the engine.
        _meta: { "anthropic/alwaysLoad": true },
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.toolCall(request.params.name, request.params._meta),
    );

    const env = {};
    for (const name of ENGINE_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, {
      HOME: this.home,
      CLAUDE_CONFIG_DIR: join(this.home, ".claude"),
      TMPDIR: this.home,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // All tools up front, so the engine adds no placeholder tool of its
      // own for the tool search, and the vendor gets the caller's tools only.
      ENABLE_TOOL_SEARCH: "false",
      // The name of the bridge in the user agent, by the documented setting.
      CLAUDE_AGENT_SDK_CLIENT_APP: registry.clientApp,
    });
    if (Number.isInteger(body.max_tokens) && body.max_tokens > 0)
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(body.max_tokens);

    this.query = query({
      prompt: this.inbox,
      options: {
        model: body.model,
        systemPrompt: systemText(body.system),
        tools: [],
        mcpServers: {
          [SERVER]: { type: "sdk", name: SERVER, instance: mcp, timeout: registry.idleMs + 60_000 },
        },
        strictMcpConfig: true,
        allowedTools: [`mcp__${SERVER}`],
        permissionMode: "dontAsk",
        settingSources: [],
        skills: [],
        hooks: {},
        persistSession: false,
        includePartialMessages: true,
        verbatimPrompts: true,
        thinking: thinkingOf(body.thinking),
        ...(this.effort ? { effort: this.effort } : {}),
        cwd: registry.workDir,
        env,
        stderr: (data) => {
          this.stderrBytes += String(data).length;
        },
      },
    });
    this.pump();
  }

  async pump() {
    try {
      for await (const msg of this.query) {
        this.touched = Date.now();
        if (msg.type === "stream_event") {
          if (!msg.parent_tool_use_id) this.onEvent(msg.event);
        } else if (msg.type === "system" && msg.subtype === "init") {
          const tools = msg.tools || [];
          this.log("engine_init", {
            domain: this.domainName,
            conversation: this.ref,
            engine_version: msg.claude_code_version,
            tools: tools.length,
            tools_not_of_caller: tools.filter((t) => !t.startsWith(PREFIX)),
            mcp_servers: (msg.mcp_servers || []).map((s) => `${s.name}:${s.status}`),
            permission_mode: msg.permissionMode,
            api_key_source: msg.apiKeySource,
          });
        } else if (msg.type === "rate_limit_event") {
          // The plan's word on its limit, for the answer to a rate limit.
          this.planLimit = planLimitOf(msg.rate_limit_info);
        } else if (msg.type === "assistant" && msg.error) {
          // The error of the API in this turn, such as "rate_limit". The
          // result of the turn comes after it.
          this.turnError = String(msg.error);
          this.logError(this.turnError);
        } else if (msg.type === "result") {
          const kind = this.turnError;
          this.turnError = null;
          if (!msg.is_error) continue;
          // A failed turn ends the conversation, so that it does not hold a
          // place. Its kind is in the log one time: the error of the API, or
          // else the kind of the result.
          if (!kind) this.logError(resultKind(msg));
          const failure = engineFailure(kind ?? resultKind(msg), this.planLimit);
          this.sink?.fail(failure.status, failure.message, failure.type, failure.headers);
          this.close("turn_error");
          break;
        }
      }
    } catch (error) {
      this.log("engine_error", { domain: this.domainName, conversation: this.ref, kind: error?.name || "Error" });
      this.sink?.fail(502, "bridge: the engine stopped");
    } finally {
      this.close("engine_ended");
    }
  }

  logError(kind) {
    const fields = { domain: this.domainName, conversation: this.ref, kind };
    if (kind === "rate_limit" && this.planLimit) {
      fields.limit = this.planLimit.type;
      fields.resets_at = this.planLimit.resetsAt;
    }
    this.log("engine_error", fields);
  }

  // One event of a model call of the engine: to the caller, with the names
  // of its own tools, and into the copy of the message.
  onEvent(ev) {
    const out = structuredClone(ev);
    if (ev.type === "message_start") {
      this.current = structuredClone(ev.message);
      this.current.content = [];
      this.parts = new Map();
    } else if (!this.current) {
      return;
    } else if (ev.type === "content_block_start") {
      const block = out.content_block;
      if (block.type === "tool_use" && block.name.startsWith(PREFIX)) block.name = block.name.slice(PREFIX.length);
      this.current.content[ev.index] = structuredClone(block);
      if (block.type === "tool_use") {
        this.parts.set(ev.index, "");
        this.call(block.id, block.name);
        this.domain.byToolUse.set(idKey(block.id), this);
      }
    } else if (ev.type === "content_block_delta") {
      const block = this.current.content[ev.index];
      const d = ev.delta;
      if (!block) return;
      if (d.type === "text_delta") block.text = (block.text || "") + d.text;
      else if (d.type === "thinking_delta") block.thinking = (block.thinking || "") + d.thinking;
      else if (d.type === "signature_delta") block.signature = (block.signature || "") + d.signature;
      else if (d.type === "input_json_delta") this.parts.set(ev.index, this.parts.get(ev.index) + d.partial_json);
      else if (d.type === "citations_delta") (block.citations ||= []).push(d.citation);
    } else if (ev.type === "content_block_stop") {
      const block = this.current.content[ev.index];
      if (block?.type === "tool_use") {
        const raw = this.parts.get(ev.index);
        try {
          block.input = raw ? JSON.parse(raw) : block.input || {};
        } catch {
          block.input = {};
        }
      }
    } else if (ev.type === "message_delta") {
      Object.assign(this.current, ev.delta);
      this.current.usage = { ...this.current.usage, ...ev.usage };
    }
    this.sink?.event(out);
    if (ev.type === "message_stop") this.endModelCall();
  }

  // The model call is over: answer the caller, and keep the key of the
  // history that the caller now has.
  endModelCall() {
    const message = this.current;
    this.current = null;
    message.content = message.content.filter(Boolean);
    const history = [...this.history, { role: "assistant", content: message.content }];
    this.answered = history;
    this.domain.byHistory.set(historyKeyOfHash(this.model, this.systemHash, history), this);
    if (!this.sink) {
      this.log("orphan_model_call", { domain: this.domainName, conversation: this.ref, model: message.model });
      return;
    }
    const sink = this.sink;
    this.sink = null;
    sink.finish(message);
  }

  call(id, name) {
    const key = idKey(id);
    if (!this.calls.has(key)) this.calls.set(key, { name, resolve: null, result: null, handled: false });
    return this.calls.get(key);
  }

  // The engine calls a tool of the caller: wait for the result of the
  // caller. The engine names the tool_use id in `_meta` (not documented).
  toolCall(name, meta) {
    const bare = String(name).startsWith(PREFIX) ? String(name).slice(PREFIX.length) : String(name);
    let id = meta?.["claudecode/toolUseId"];
    if (!id) id = [...this.calls].find(([, c]) => c.name === bare && !c.handled)?.[0];
    if (!id)
      return Promise.resolve({ content: [{ type: "text", text: "bridge: no matching tool_use" }], isError: true });
    const call = this.call(id, bare);
    call.handled = true;
    if (call.result) {
      this.forget(id);
      return Promise.resolve(call.result);
    }
    return new Promise((resolve) => {
      call.resolve = resolve;
    });
  }

  forget(id) {
    this.calls.delete(idKey(id));
    this.domain.byToolUse.delete(idKey(id));
  }

  // A tool_result of the caller: to its handler that waits, or kept for it.
  deliver(block) {
    const call = this.calls.get(idKey(block.tool_use_id));
    if (!call) return;
    const result = toMcpResult(block);
    if (call.resolve) {
      this.forget(block.tool_use_id);
      call.resolve(result);
    } else call.result = result;
  }

  // The history that the next call of the caller should start with.
  expected() {
    return this.answered ?? this.history;
  }

  unanswered() {
    let n = 0;
    for (const c of this.calls.values()) if (!c.result) n++;
    return n;
  }

  attach(sink) {
    this.sink = sink;
    this.touched = Date.now();
  }

  push(content) {
    const { content: clean } = withoutCacheMarks(content);
    this.inbox.push({ type: "user", message: { role: "user", content: clean }, parent_tool_use_id: null });
  }

  // The first call of a conversation: its new input, or, for a history with
  // no live engine, the history as one text and then the new input.
  start(body, rebuilt) {
    this.history = body.messages;
    const input = newInput(body.messages);
    if (!rebuilt) return this.push(input);
    const cut = lastAssistant(body.messages) + 1;
    const results = input.filter((b) => b?.type === "tool_result");
    const carried = input.filter((b) => b?.type === "text" || b?.type === "image" || b?.type === "document");
    const past = [...body.messages.slice(0, cut), ...(results.length ? [{ role: "user", content: results }] : [])];
    this.push([{ type: "text", text: historyText(past) }, ...carried]);
  }

  // A later call with another effort: the engine takes it for the next
  // model call. Null goes back to the default effort of the model.
  setEffort(effort) {
    if (effort === this.effort) return Promise.resolve();
    this.effort = effort;
    return this.query.applyFlagSettings({ effortLevel: effort }).catch((error) => {
      this.log("engine_error", {
        domain: this.domainName,
        conversation: this.ref,
        kind: `effort:${error?.name || "Error"}`,
      });
    });
  }

  // A later call of the conversation. A new effort is set before the input
  // goes in, so the next model call has it.
  async next(body) {
    this.history = body.messages;
    await this.setEffort(effortOf(body));
    if (this.closed) return;
    const input = newInput(body.messages);
    const results = input.filter((b) => b?.type === "tool_result");
    const other = input.filter((b) => b?.type !== "tool_result");
    if (!results.length) return this.push(input);
    for (const block of results) this.deliver(block);
    // A text next to the results goes in as the next user message.
    if (other.length) this.push(other);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.registry.all.delete(this);
    for (const [id, c] of this.domain.byToolUse) if (c === this) this.domain.byToolUse.delete(id);
    for (const [key, c] of this.domain.byHistory) if (c === this) this.domain.byHistory.delete(key);
    this.inbox.close();
    try {
      this.query.close?.();
    } catch {
      // The engine is gone already.
    }
    for (const call of this.calls.values())
      call.resolve?.({ content: [{ type: "text", text: "bridge: the conversation ended" }], isError: true });
    const sink = this.sink;
    this.sink = null;
    sink?.fail(502, `bridge: the conversation ended (${reason})`);
    rmSync(this.home, { recursive: true, force: true });
    this.log("conversation_end", {
      domain: this.domainName,
      conversation: this.ref,
      reason,
      engine_stderr_bytes: this.stderrBytes,
    });
  }
}
