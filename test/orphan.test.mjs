// Unit tests of an orphan model call (node --test): the log line of the
// orphan, the end of its conversation, and the count of tool results that
// no tool call of the engine waited for. No engine: a conversation object
// with the fields that these methods read.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversation } from "../src/conversation.mjs";
import { idKey } from "../src/messages.mjs";

function conversation(calls = {}) {
  const c = Object.create(Conversation.prototype);
  c.domainName = "main";
  c.ref = "c0ffee";
  c.domain = { byToolUse: new Map(), byHistory: new Map() };
  c.calls = new Map(
    Object.entries(calls).map(([id, v]) => [
      idKey(id),
      { name: "t", resolve: null, result: null, handled: false, ...v },
    ]),
  );
  c.lines = [];
  c.log = (event, fields) => c.lines.push({ event, ...fields });
  c.ended = [];
  c.close = (reason) => c.ended.push(reason);
  c.lastAnswer = null;
  c.history = [];
  c.closed = false;
  c.setEffort = () => Promise.resolve();
  c.pushed = [];
  c.push = (content) => c.pushed.push(content);
  return c;
}

test("an orphan model call is logged with counts only, and ends its conversation", () => {
  const c = conversation({
    toolu_a: {},
    toolu_b: { handled: true, resolve: () => {} },
    toolu_c: { result: { content: [] } },
    toolu_own: {},
  });
  c.lastAnswer = { at: Date.now() - 1500, notOffered: 1 };
  c.orphan({
    model: "claude-test",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "a text that must not reach the log" },
      { type: "tool_use", id: "toolu_own", name: "t", input: {} },
    ],
  });
  assert.equal(c.lines.length, 1);
  const line = c.lines[0];
  assert.equal(line.event, "orphan_model_call");
  assert.equal(line.stop_reason, "tool_use");
  assert.equal(line.tool_uses, 1);
  assert.equal(line.answer_tools_not_offered, 1);
  assert.equal(line.tool_calls_not_asked, 1);
  assert.equal(line.tool_calls_waiting, 1);
  assert.ok(line.ms_after_answer >= 1500);
  assert.ok(!JSON.stringify(line).includes("must not reach"));
  assert.deepEqual(c.ended, ["orphan_model_call"]);
});

test("an orphan before any answer has null for the fields of the answer", () => {
  const c = conversation();
  c.orphan({ model: "claude-test", stop_reason: "end_turn", content: [] });
  assert.equal(c.lines[0].ms_after_answer, null);
  assert.equal(c.lines[0].answer_tools_not_offered, null);
  assert.equal(c.lines[0].tool_uses, 0);
});

test("next() counts the tool results that no tool call of the engine waited for", async () => {
  const got = [];
  const c = conversation({ toolu_wait: { handled: true, resolve: (r) => got.push(r) }, toolu_kept: {} });
  const n = await c.next({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_wait", content: "r1" },
          { type: "tool_result", tool_use_id: "toolu_kept", content: "r2" },
          { type: "tool_result", tool_use_id: "toolu_unknown", content: "r3" },
        ],
      },
    ],
  });
  assert.equal(n, 2);
  assert.equal(got.length, 1);
  assert.ok(c.calls.get(idKey("toolu_kept")).result);
  assert.deepEqual(c.pushed, []);
});

test("next() with no tool result pushes the input and counts nothing", async () => {
  const c = conversation();
  const n = await c.next({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: "more" },
    ],
  });
  assert.equal(n, 0);
  assert.equal(c.pushed.length, 1);
});
