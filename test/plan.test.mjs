// Unit tests of the plan's use in the log (node --test): the windows of a
// rate_limit_event, the token counts of an answer, and how often a
// plan_limit line goes out. No engine.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "../src/conversation.mjs";
import { planWindowsOf, tokensOf } from "../src/messages.mjs";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const IN_AN_HOUR = NOW / 1000 + 3600;
const IN_FIVE_DAYS = NOW / 1000 + 5 * 86400;

test("each window of unifiedWindows is one entry, and the limiting one is marked", () => {
  const out = planWindowsOf(
    {
      status: "allowed",
      resetsAt: IN_AN_HOUR,
      rateLimitType: "five_hour",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: IN_AN_HOUR, status: "allowed" },
        seven_day: { utilization: 0.1, resetsAt: IN_FIVE_DAYS, status: "allowed" },
      },
    },
    NOW,
  );
  assert.deepEqual(out, [
    {
      window: "five_hour",
      limiting: true,
      status: "allowed",
      utilization: 0.42,
      resets_at: IN_AN_HOUR,
      threshold: null,
    },
    {
      window: "seven_day",
      limiting: false,
      status: "allowed",
      utilization: 0.1,
      resets_at: IN_FIVE_DAYS,
      threshold: null,
    },
  ]);
});

test("with no unifiedWindows the top level is one entry; its utilization comes with a warning only", () => {
  assert.deepEqual(planWindowsOf({ status: "allowed", resetsAt: IN_AN_HOUR, rateLimitType: "five_hour" }, NOW), [
    {
      window: "five_hour",
      limiting: true,
      status: "allowed",
      utilization: null,
      resets_at: IN_AN_HOUR,
      threshold: null,
    },
  ]);
  assert.deepEqual(
    planWindowsOf(
      {
        status: "allowed_warning",
        resetsAt: IN_AN_HOUR,
        rateLimitType: "five_hour",
        utilization: 0.95,
        surpassedThreshold: 0.9,
      },
      NOW,
    ),
    [
      {
        window: "five_hour",
        limiting: true,
        status: "allowed_warning",
        utilization: 0.95,
        resets_at: IN_AN_HOUR,
        threshold: 0.9,
      },
    ],
  );
});

test("a value outside the known sets or ranges becomes other or null, and nothing else of the event passes", () => {
  const out = planWindowsOf(
    {
      status: "MARKER status",
      rateLimitType: "MARKER type",
      resetsAt: NOW / 1000 + 400 * 86400,
      overageDisabledReason: "MARKER reason",
      unifiedWindows: {
        "MARKER window": { utilization: 0.5, resetsAt: IN_AN_HOUR, status: "MARKER" },
        seven_day: { utilization: -1, resetsAt: "soon", surpassedThreshold: 7 },
        five_hour: "MARKER",
      },
    },
    NOW,
  );
  assert.deepEqual(out, [
    { window: "other", limiting: false, status: "other", utilization: 0.5, resets_at: IN_AN_HOUR, threshold: null },
    { window: "seven_day", limiting: false, status: "other", utilization: null, resets_at: null, threshold: null },
  ]);
  assert.ok(!JSON.stringify(out).includes("MARKER"));
  assert.deepEqual(planWindowsOf(null, NOW), []);
  assert.deepEqual(planWindowsOf({}, NOW), [
    { window: "other", limiting: true, status: "other", utilization: null, resets_at: null, threshold: null },
  ]);
});

test("the token counts of an answer are whole numbers only", () => {
  assert.deepEqual(
    tokensOf({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
      service_tier: "x",
    }),
    { input_tokens: 11, output_tokens: 22, cache_read_tokens: 5, cache_write_tokens: 0 },
  );
  assert.deepEqual(tokensOf({ input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: "3" }), {});
  assert.deepEqual(tokensOf(undefined), {});
});

test("a plan_limit line goes out on a change, or again after the repeat time, for each domain and window", () => {
  const lines = [];
  const registry = new Registry({
    maxConversations: 2,
    idleMs: 60_000,
    callMs: 60_000,
    stateDir: mkdtempSync(join(tmpdir(), "plan-test-")),
    clientApp: "test",
    log: (event, fields) => lines.push({ event, ...fields }),
  });
  const info = (use, status = "allowed") => ({
    status,
    rateLimitType: "five_hour",
    resetsAt: IN_AN_HOUR,
    unifiedWindows: { five_hour: { utilization: use, resetsAt: IN_AN_HOUR, status } },
  });
  registry.notePlan("main", info(0.42), NOW);
  registry.notePlan("main", info(0.424), NOW + 1000); // the same whole percent
  registry.notePlan("finance", info(0.42), NOW + 2000); // another domain
  registry.notePlan("main", info(0.43), NOW + 3000);
  registry.notePlan("main", info(0.43, "allowed_warning"), NOW + 4000);
  registry.notePlan("main", info(0.43, "allowed_warning"), NOW + 5000);
  registry.notePlan("main", info(0.43, "allowed_warning"), NOW + 4000 + registry.planRepeatMs);
  assert.deepEqual(
    lines.map((l) => [l.event, l.domain, l.utilization, l.status]),
    [
      ["plan_limit", "main", 0.42, "allowed"],
      ["plan_limit", "finance", 0.42, "allowed"],
      ["plan_limit", "main", 0.43, "allowed"],
      ["plan_limit", "main", 0.43, "allowed_warning"],
      ["plan_limit", "main", 0.43, "allowed_warning"],
    ],
  );
});
