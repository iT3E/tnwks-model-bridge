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
  historyKey,
  historyKeyOfHash,
  historyText,
  idKey,
  lastAssistant,
  lastToolUseIds,
  newInput,
  sha,
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

// Where the events of one model call go: a stream of server-sent events, or
// one JSON body. `onEnd(status)` runs one time, when the call ends.
export class Sink {
  constructor({ res, stream, conversation, mode, callMs, onEnd }) {
    this.res = res;
    this.stream = stream;
    this.done = false;
    this.status = 200;
    this.onEnd = onEnd;
    this.headers = { "x-bridge-conversation": conversation.ref, "x-bridge-mode": mode };
    this.timer = setTimeout(() => {
      this.fail(504, "bridge: the model call did not end in time");
      conversation.close("call_timeout");
    }, callMs);
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...this.headers,
      });
    }
  }
  event(ev) {
    if (this.done || !this.stream) return;
    this.res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  end() {
    this.done = true;
    clearTimeout(this.timer);
    this.onEnd?.(this.status);
  }
  finish(message) {
    if (this.done) return;
    if (this.stream) this.res.end();
    else {
      this.res.writeHead(200, { "content-type": "application/json", ...this.headers });
      this.res.end(JSON.stringify(message));
    }
    this.end();
  }
  fail(status, text) {
    if (this.done) return;
    const body = errorBody(status === 529 ? "overloaded_error" : "api_error", text);
    if (this.stream && this.res.headersSent) {
      this.res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      this.res.end();
    } else {
      this.status = status;
      this.res.writeHead(status, { "content-type": "application/json" });
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
  find(domainName, body) {
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
    if (!conversation || conversation.closed) return null;
    if (conversation.model !== body.model || conversation.systemHash !== sha(systemText(body.system))) {
      conversation.close("system_or_model_changed");
      return null;
    }
    const answered = newInput(body.messages).some((b) => b?.type === "tool_result");
    if (conversation.unanswered() && !answered) {
      conversation.close("tool_results_missing");
      return null;
    }
    const names = new Set((body.tools || []).map((t) => t.name));
    const own = conversation.toolNames;
    if (names.size !== own.size || [...names].some((n) => !own.has(n))) {
      conversation.close("tools_changed");
      return null;
    }
    domain.byHistory.delete(key);
    return conversation;
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
    this.inbox = new Inbox();
    this.sink = null;
    this.calls = new Map(); // tool_use id key -> { name, resolve, result, handled }
    this.current = null;
    this.parts = new Map();
    this.history = [];
    this.touched = Date.now();
    this.closed = false;
    this.stderrBytes = 0;
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
        } else if (msg.type === "assistant" && msg.error) {
          this.log("engine_error", { domain: this.domainName, conversation: this.ref, kind: String(msg.error) });
        } else if (msg.type === "result" && msg.is_error) {
          // A failed turn ends the conversation, so that it does not hold a place.
          this.log("engine_error", { domain: this.domainName, conversation: this.ref, kind: String(msg.subtype) });
          this.sink?.fail(502, `bridge: the engine ended the turn with an error (${msg.subtype})`);
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

  // A later call of the conversation.
  next(body) {
    this.history = body.messages;
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
