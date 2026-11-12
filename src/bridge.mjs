// The model bridge: the Messages API in, the Claude Agent SDK out.
//
// It serves `POST /v1/messages` (JSON and server-sent events) and
// `GET /health`. Each call needs the bridge key of a trust domain in the
// `x-api-key` header, the header that the model gateway sends for an
// Anthropic entry with an `api_key`. The bridge runs each conversation
// through the unmodified Claude Agent SDK, with no tool of its own: a tool
// call goes back to the caller, and the next call brings its result. The
// README has the contract.
//
// The log has one JSON line for each call, and never a text of a
// conversation.

import { mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation, Registry, Sink } from "./conversation.mjs";
import { domainOf, droppedFields, invalidCall, lastAssistant, loadKeys, withoutCacheMarks } from "./messages.mjs";

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a number above 0`);
  return value;
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

const config = {
  host: process.env.BRIDGE_HOST || "127.0.0.1",
  port: number("BRIDGE_PORT", 8080),
  idleMs: number("BRIDGE_IDLE_SECONDS", 900) * 1000,
  callMs: number("BRIDGE_CALL_SECONDS", 300) * 1000,
  maxConversations: number("BRIDGE_MAX_CONVERSATIONS", 8),
  maxBodyBytes: number("BRIDGE_MAX_BODY_MB", 32) * 1024 * 1024,
  stateDir: process.env.BRIDGE_STATE_DIR || join(tmpdir(), "tnwks-model-bridge"),
  version: process.env.BRIDGE_VERSION || "dev",
};
const clientApp = `tnwks-model-bridge/${config.version}`;

let keys;
try {
  keys = loadKeys(process.env);
} catch (error) {
  log("config_error", { error: error.message });
  process.exit(2);
}

mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const registry = new Registry({
  maxConversations: config.maxConversations,
  idleMs: config.idleMs,
  callMs: config.callMs,
  stateDir: config.stateDir,
  clientApp,
  log,
});

function reply(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMessages(req, res, started) {
  const domain = domainOf(keys, req.headers["x-api-key"]);
  if (!domain) {
    // Nothing of the call goes to the log: not its body, not its headers.
    log("call", { status: 401, ms: Date.now() - started });
    res.setHeader("connection", "close");
    reply(res, 401, "authentication_error", "bridge: no valid key in x-api-key");
    req.resume();
    return;
  }

  const line = { domain, model: null, conversation: null, mode: null };
  const done = (status, extra = {}) => log("call", { ...line, status, ms: Date.now() - started, ...extra });

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (error) {
    const status = error?.status || 400;
    done(status);
    return reply(
      res,
      status,
      "invalid_request_error",
      status === 413 ? "bridge: the body is too large" : "bridge: the body is not JSON",
    );
  }
  const invalid = invalidCall(body);
  if (invalid) {
    done(400);
    return reply(res, 400, "invalid_request_error", `bridge: ${invalid}`);
  }
  line.model = body.model;
  const dropped = droppedFields(body);
  const marks = withoutCacheMarks(body.messages).removed + withoutCacheMarks(body.system ?? null).removed;
  const extra = { dropped, cache_marks_removed: marks };
  const stream = body.stream === true;

  let conversation = registry.find(domain, body);
  let mode = "matched";
  if (conversation?.sink) {
    line.conversation = conversation.ref;
    done(409, extra);
    return reply(res, 409, "invalid_request_error", "bridge: a call of this conversation is in work");
  }
  if (!conversation) {
    if (!registry.makeRoom()) {
      done(529, extra);
      return reply(res, 529, "overloaded_error", "bridge: each live conversation has a call in work");
    }
    mode = lastAssistant(body.messages) >= 0 ? "rebuilt" : "new";
    conversation = new Conversation(registry, domain, body);
  }
  line.conversation = conversation.ref;
  line.mode = mode;

  const sink = new Sink({
    res,
    stream,
    conversation,
    mode,
    callMs: config.callMs,
    onEnd: (status) => done(status, extra),
  });
  conversation.attach(sink);
  res.on("close", () => {
    if (!sink.done) {
      sink.gone();
      if (conversation.sink === sink) conversation.sink = null;
    }
  });
  if (mode === "matched") conversation.next(body);
  else conversation.start(body, mode === "rebuilt");
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        conversations: registry.all.size,
        max_conversations: config.maxConversations,
        waiting_tool_calls: registry.waitingToolCalls(),
      }),
    );
  }
  if (req.method === "POST" && path === "/v1/messages") {
    handleMessages(req, res, started).catch((error) => {
      log("handler_error", { kind: error?.name || "Error" });
      if (!res.headersSent) reply(res, 500, "api_error", "bridge: internal error");
      else res.end();
    });
    return;
  }
  req.resume();
  reply(res, 404, "not_found_error", "bridge: it serves POST /v1/messages and GET /health only");
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

setInterval(() => registry.sweep(), 15_000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    registry.closeAll("shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(config.port, config.host, () =>
  log("listening", {
    host: config.host,
    port: config.port,
    domains: keys.map((k) => k.domain),
    max_conversations: config.maxConversations,
    idle_seconds: config.idleMs / 1000,
    client_app: clientApp,
  }),
);
