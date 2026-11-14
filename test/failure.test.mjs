// Unit tests of the answer to a failed turn (node --test): the status, the
// error body and the log status of a call, without an engine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Sink } from "../src/conversation.mjs";
import { engineFailure, MAX_RESET_SECONDS, planLimitOf, resultKind } from "../src/messages.mjs";

const NOW = Date.parse("2026-11-14T02:29:00Z");

// A response of node:http, in memory.
function fakeRes() {
  return {
    headersSent: false,
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk);
      this.ended = true;
    },
    events() {
      return this.chunks
        .join("")
        .split("\n\n")
        .filter(Boolean)
        .map((part) => {
          const [event, data] = part.split("\n");
          return { event: event.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
        });
    },
  };
}

function sink(stream) {
  const res = fakeRes();
  const ends = [];
  const s = new Sink({
    res,
    stream,
    conversation: { ref: "c0ffee", close() {} },
    mode: "new",
    callMs: 60_000,
    onEnd: (status, inStream) => ends.push({ status, inStream }),
  });
  return { s, res, ends };
}

test("a rate limit with no reset time is 429 rate_limit_error, with no retry-after", () => {
  const f = engineFailure("rate_limit", null, NOW);
  assert.equal(f.status, 429);
  assert.equal(f.type, "rate_limit_error");
  assert.equal(f.message, "bridge: rate limit: the usage limit of the Claude plan was reached");
  assert.deepEqual(f.headers, {});
});

test("a rate limit with the plan's reset time has a retry-after and the time", () => {
  const limit = planLimitOf({ status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1000 + 3600 });
  const f = engineFailure("rate_limit", limit, NOW);
  assert.equal(f.status, 429);
  assert.deepEqual(f.headers, { "retry-after": "3600" });
  assert.equal(
    f.message,
    "bridge: rate limit: the usage limit of the Claude plan was reached (five_hour); it resets at 2026-11-14T03:29:00.000Z",
  );
});

test("a reset time in the past, too far away or not a number gives no retry-after", () => {
  for (const resetsAt of [NOW / 1000 - 5, NOW / 1000 + MAX_RESET_SECONDS + 60, NOW, "soon", undefined]) {
    const f = engineFailure("rate_limit", planLimitOf({ status: "rejected", resetsAt }), NOW);
    assert.equal(f.status, 429, String(resetsAt));
    assert.deepEqual(f.headers, {}, String(resetsAt));
    assert.doesNotMatch(f.message, /resets/);
  }
});

test("only a rejected status is a limit of the plan", () => {
  assert.equal(planLimitOf({ status: "allowed", resetsAt: NOW / 1000 + 60 }), null);
  assert.equal(planLimitOf({ status: "allowed_warning", resetsAt: NOW / 1000 + 60 }), null);
  assert.equal(planLimitOf(undefined), null);
  assert.deepEqual(planLimitOf({ status: "rejected", rateLimitType: "Five Hour!", resetsAt: 5 }), {
    type: null,
    resetsAt: 5,
  });
});

test("each other kind is 502 api_error with its kind", () => {
  const f = engineFailure("server_error", null, NOW);
  assert.deepEqual(f, {
    status: 502,
    type: "api_error",
    message: "bridge: the engine ended the turn with an error (server_error)",
    headers: {},
  });
});

test("the kind of a failed result is never success", () => {
  assert.equal(resultKind({ subtype: "success", is_error: true }), "api_error");
  assert.equal(resultKind({ subtype: "success", is_error: true, terminal_reason: "completed" }), "api_error");
  assert.equal(
    resultKind({ subtype: "success", is_error: true, terminal_reason: "prompt_too_long" }),
    "prompt_too_long",
  );
  assert.equal(resultKind({ subtype: "error_during_execution", is_error: true }), "error_during_execution");
});

test("JSON call: a rate limit is HTTP 429 and the call logs 429", () => {
  const { s, res, ends } = sink(false);
  const f = engineFailure("rate_limit", null, NOW);
  s.fail(f.status, f.message, f.type, f.headers);
  assert.equal(res.status, 429);
  assert.deepEqual(JSON.parse(res.chunks.join("")), {
    type: "error",
    error: { type: "rate_limit_error", message: f.message },
  });
  assert.deepEqual(ends, [{ status: 429, inStream: false }]);
});

test("stream, before the first event: a rate limit is HTTP 429, not a stream", () => {
  const { s, res, ends } = sink(true);
  assert.equal(res.headersSent, false);
  const limit = planLimitOf({ status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1000 + 120 });
  const f = engineFailure("rate_limit", limit, NOW);
  s.fail(f.status, f.message, f.type, f.headers);
  assert.equal(res.status, 429);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["retry-after"], "120");
  assert.equal(JSON.parse(res.chunks.join("")).error.type, "rate_limit_error");
  assert.deepEqual(ends, [{ status: 429, inStream: false }]);
});

test("stream, after the first event: an error event, and the call logs 429 in the stream", () => {
  const { s, res, ends } = sink(true);
  s.event({ type: "message_start", message: { id: "msg_1", content: [] } });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(res.headers["x-bridge-conversation"], "c0ffee");
  const f = engineFailure("rate_limit", null, NOW);
  s.fail(f.status, f.message, f.type, f.headers);
  const events = res.events();
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "error"],
  );
  assert.deepEqual(events[1].data, { type: "error", error: { type: "rate_limit_error", message: f.message } });
  assert.equal(res.ended, true);
  assert.deepEqual(ends, [{ status: 429, inStream: true }]);
});

test("a stream that ends well logs 200, and a second end changes nothing", () => {
  const { s, res, ends } = sink(true);
  s.event({ type: "message_start", message: { id: "msg_1", content: [] } });
  s.event({ type: "message_stop" });
  s.finish({});
  s.fail(502, "late");
  assert.equal(res.status, 200);
  assert.deepEqual(ends, [{ status: 200, inStream: false }]);
});

test("the shutdown error keeps its status and type, in a stream and before it", () => {
  const before = sink(true);
  before.s.fail(503, "bridge: service unavailable");
  assert.equal(before.res.status, 503);
  assert.equal(JSON.parse(before.res.chunks.join("")).error.type, "overloaded_error");
  assert.deepEqual(before.ends, [{ status: 503, inStream: false }]);

  const after = sink(true);
  after.s.event({ type: "message_start", message: { id: "msg_1", content: [] } });
  after.s.fail(503, "bridge: service unavailable");
  assert.equal(after.res.events()[1].data.error.type, "overloaded_error");
  assert.deepEqual(after.ends, [{ status: 503, inStream: true }]);
});
