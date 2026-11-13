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
//
// On SIGTERM it drains: /health answers 503, the server takes no new
// connection, a call that still comes gets a 503 that tells the caller to try
// again, and the calls in work run to their end for up to
// BRIDGE_DRAIN_SECONDS. At that time it cuts what is left with the same
// error, which a caller can retry, and it exits.

import { mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation, Registry, Sink } from "./conversation.mjs";
import {
  domainOf,
  droppedFields,
  effortOf,
  invalidCall,
  lastAssistant,
  loadKeys,
  withoutCacheMarks,
} from "./messages.mjs";

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
  drainMs: number("BRIDGE_DRAIN_SECONDS", 75) * 1000,
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

function reply(res, status, type, message, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

// The error of a call at shutdown. Its type and its words tell a caller to
// try again, on the next pod.
const SHUTDOWN_STATUS = 503;
const SHUTDOWN_MESSAGE = "bridge: service unavailable, the bridge is shutting down; try again";

// The responses in work, each from its request to its last byte.
const inWork = new Set();
let draining = false;

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

async function handleMessages(req, res, started, work) {
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
  line.effort = effortOf(body);
  const dropped = droppedFields(body);
  const marks = withoutCacheMarks(body.messages).removed + withoutCacheMarks(body.system ?? null).removed;
  const extra = { dropped, cache_marks_removed: marks };
  const stream = body.stream === true;

  const miss = {};
  let conversation = registry.find(domain, body, miss);
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
  // Why a call with a history did not match a live conversation (positions
  // and kinds only). It changes nothing.
  if (mode === "rebuilt") log("rebuild", { domain, model: body.model, conversation: conversation.ref, ...miss });

  const sink = new Sink({
    res,
    stream,
    conversation,
    mode,
    callMs: config.callMs,
    onEnd: (status) => done(status, extra),
  });
  work.sink = sink;
  conversation.attach(sink);
  res.on("close", () => {
    if (!sink.done) {
      sink.gone();
      if (conversation.sink === sink) conversation.sink = null;
    }
  });
  if (mode === "matched")
    conversation.next(body).catch((error) => {
      log("handler_error", { kind: error?.name || "Error" });
      sink.fail(502, "bridge: the engine did not take the call");
    });
  else conversation.start(body, mode === "rebuilt");
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const path = (req.url || "/").split("?")[0];
  // Each response is in work until its last byte is out: the drain waits for
  // it, the answers on the same connection too.
  const work = { res, sink: null };
  inWork.add(work);
  const over = () => {
    inWork.delete(work);
    if (draining) drained();
  };
  res.on("finish", over);
  res.on("close", over);
  if (req.method === "GET" && path === "/health") {
    res.writeHead(draining ? 503 : 200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: !draining,
        draining,
        conversations: registry.all.size,
        max_conversations: config.maxConversations,
        waiting_tool_calls: registry.waitingToolCalls(),
      }),
    );
  }
  if (req.method === "POST" && path === "/v1/messages") {
    if (draining) {
      log("call", { status: SHUTDOWN_STATUS, ms: Date.now() - started, draining: true });
      req.resume();
      return reply(res, SHUTDOWN_STATUS, "overloaded_error", SHUTDOWN_MESSAGE, { connection: "close" });
    }
    handleMessages(req, res, started, work).catch((error) => {
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

let drainTimer = null;
let drainStarted = 0;
let cut = 0;
let exiting = false;

// The end of the drain: no call is in work, or the time is up.
function drained() {
  if (exiting || inWork.size) return;
  exiting = true;
  clearTimeout(drainTimer);
  registry.closeAll("shutdown");
  log("drain_end", { ms: Date.now() - drainStarted, cut });
  process.exit(0);
}

// The time of the drain is up: each call still in work gets the shutdown
// error. A stream that started gets it as an error event.
function cutCalls() {
  const left = [...inWork];
  for (const work of left) {
    if (work.sink && !work.sink.done) work.sink.fail(SHUTDOWN_STATUS, SHUTDOWN_MESSAGE);
    else if (!work.res.headersSent)
      reply(work.res, SHUTDOWN_STATUS, "overloaded_error", SHUTDOWN_MESSAGE, { connection: "close" });
    else work.res.end();
  }
  cut = left.length;
  // Each response leaves the set when its last byte is out. Exit at the
  // latest after two seconds.
  setTimeout(() => {
    inWork.clear();
    drained();
  }, 2000);
}

function drain(signal) {
  if (draining) return;
  draining = true;
  drainStarted = Date.now();
  log("drain_start", { signal, in_work: inWork.size, drain_seconds: config.drainMs / 1000 });
  // No new connection. An idle connection closes now; a call that comes on
  // an open one gets the shutdown error.
  server.close();
  drainTimer = setTimeout(cutCalls, config.drainMs);
  drained();
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => drain(signal));

server.listen(config.port, config.host, () =>
  log("listening", {
    host: config.host,
    port: config.port,
    domains: keys.map((k) => k.domain),
    max_conversations: config.maxConversations,
    idle_seconds: config.idleMs / 1000,
    drain_seconds: config.drainMs / 1000,
    client_app: clientApp,
  }),
);
