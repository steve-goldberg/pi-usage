import test from "node:test";
import assert from "node:assert/strict";
import { providers, parseCodex, parseGrok, parseZai, parseOpenCodeGo, number, timestamp, safeText } from "../src/usage.ts";

test("Codex parses all reported windows without inventing a missing primary", () => {
  const result = parseCodex({ plan_type: "pro", rate_limit: { primary_window: null,
    secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: 1790727289 } },
    code_review_rate_limit: { primary_window: { used_percent: 0 } },
    additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 10 } } }] });
  assert.equal(result.meters.length, 3);
  assert.deepEqual(result.meters[0], { label: "7 day", percent: 35, resetsAt: 1790727289000 });
  assert.equal(result.meters[1].percent, 0);
  assert.equal(result.plan, "pro");
});

test("Provider list contains GLM, Grok, Codex and OpenCode Go", () => {
  assert.deepEqual(providers.map(p => p.id), ["zai", "xai", "openai-codex", "opencode-go"]);
});

test("GLM handles percentage-only quotas and exact credit ratios", () => {
  const result = parseZai({ success: true, data: { level: "max", limits: [
    { type: "TOKENS_LIMIT", percentage: 1, unit: 3, number: 5, nextResetTime: 1790442273511 },
    { type: "CREDIT_LIMIT", percentage: 11, currentValue: 1438, usage: 12000, unit: 6 },
    { type: "TIME_LIMIT", currentValue: 0, usage: 4000, unit: 5, usageDetails: [{ modelCode: "web-reader" }] },
  ] } });
  assert.equal(result.meters[0].percent, 1);
  assert.equal(result.meters[0].limit, undefined);
  assert.equal(result.meters[1].percent, 1438 / 12000 * 100);
  assert.equal(result.meters[2].percent, 0);
  assert.equal(result.meters[2].label, "1 month · tools");
});

test("Grok uses plan percent and keeps paid on-demand separate", () => {
  const result = parseGrok({ config: { creditUsagePercent: 79, currentPeriod: { end: "2026-10-01T00:00:00Z" },
    onDemandCap: { val: 100 }, onDemandUsed: { val: 25 } } });
  assert.equal(result.meters[0].percent, 79);
  assert.equal(result.meters[1].percent, 25);
  assert.match(result.meters[1].label, /paid/);
});

test("Grok absent percentage is unknown, never zero", () => {
  const result = parseGrok({ config: { currentPeriod: { end: "2026-10-01T00:00:00Z" } } });
  assert.equal(result.meters[0].percent, undefined);
  assert.equal(parseGrok({ config: { creditUsagePercent: 0 } }).meters[0].percent, 0);
});

test("Malformed responses fail safely", () => {
  for (const parse of [parseCodex, parseGrok, parseZai, parseOpenCodeGo]) {
    for (const bad of [null, [], "secret-error", {}, { error: "denied" }]) assert.throws(() => parse(bad));
  }
  assert.throws(() => parseZai({ success: false, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 99 }] } }));
});

test("OpenCode Go parses zero, partial and exhausted windows without inventing limits", () => {
  const resetsAt = "2026-10-01T00:00:00.000Z";
  const result = parseOpenCodeGo({ usage: {
    rolling: { status: "ok", percent: 0, resetsAt },
    weekly: { status: "ok", percent: 2.5, resetsAt },
    monthly: { status: "rate-limited", percent: 100, resetsAt },
  } });
  assert.deepEqual(result.meters, [
    { label: "5 hour", percent: 0, resetsAt: Date.parse(resetsAt) },
    { label: "7 day", percent: 2.5, resetsAt: Date.parse(resetsAt) },
    { label: "Monthly", percent: 100, resetsAt: Date.parse(resetsAt) },
  ]);
  assert.equal(result.plan, undefined);
  assert.equal(parseOpenCodeGo({ usage: { weekly: { status: "ok", percent: 2, resetsAt } } }).meters.length, 1);
});

test("OpenCode Go rejects malformed windows rather than showing zero", () => {
  const valid = { status: "ok", percent: 0, resetsAt: "2026-10-01T00:00:00Z" };
  for (const patch of [
    { percent: undefined }, { percent: null }, { percent: "0" }, { percent: -1 },
    { percent: 101 }, { percent: Infinity }, { percent: NaN },
    { status: "unknown" }, { resetsAt: "invalid" }, { resetsAt: undefined },
  ]) assert.throws(() => parseOpenCodeGo({ usage: { rolling: { ...valid, ...patch } } }));
  for (const usage of [{}, { rolling: null }, { rolling: [] }, { rolling: "secret" }]) {
    assert.throws(() => parseOpenCodeGo({ usage }));
  }
});

test("Numeric parsing rejects null, empty, booleans, non-finite and negative values", () => {
  for (const value of [null, undefined, "", " ", false, true, NaN, Infinity, -1]) assert.equal(number(value), undefined);
  assert.equal(number("0"), 0);
  assert.equal(timestamp(1790000000), 1790000000000);
  assert.equal(timestamp(1790000000000), 1790000000000);
  assert.equal(timestamp("invalid"), undefined);
  assert.equal(timestamp(0), undefined);
  assert.equal(timestamp(1e20), undefined);
});

test("Provider text cannot inject terminal control sequences", () => {
  assert.equal(safeText("Pro\x1b]52;c;secret\x07\n"), "Pro]52;c;secret");
  assert.equal(safeText("x".repeat(500))?.length, 80);
});
