import test from "node:test";
import assert from "node:assert/strict";
import { fetchUsage, endpoints, retryAfterAt, createUsageQuery, type AuthResolver } from "../src/client.ts";
import type { ProviderId } from "../src/usage.ts";

const signal = () => new AbortController().signal;
const auth: AuthResolver = { getProviderAuth: async () => ({ auth: { apiKey: "test-secret" } }) };
const response = (payload: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(payload), { status });

test("Retry-After accepts seconds/date and rejects invalid or expired values", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(retryAfterAt("120", now), now + 120000);
  assert.equal(retryAfterAt("0", now), now);
  assert.equal(retryAfterAt("Sat, 26 Sep 2026 12:05:00 GMT", now), now + 300000);
  for (const invalid of [null, "", "nonsense", "-1", "999999999999999999999999", "Fri, 25 Sep 2026 12:00:00 GMT"]) {
    assert.equal(retryAfterAt(invalid, now), undefined);
  }
});

test("429 reports unknown token validity and honors provider Retry-After", async () => {
  const before = Date.now();
  const r = await fetchUsage("xai", auth, signal(), async () => new Response("sensitive body", {
    status: 429, headers: { "retry-after": "120" },
  }));
  assert.equal(r.httpStatus, 429);
  assert.match(r.note!, /token validity unknown/);
  assert.equal(r.retrySource, "server");
  assert.ok(r.retryAt! >= before + 120000 && r.retryAt! <= Date.now() + 120000);
  assert.ok(!JSON.stringify(r).includes("sensitive body"));
});

test("429 without Retry-After uses an explicitly local five-minute backoff", async () => {
  const before = Date.now();
  const r = await fetchUsage("xai", auth, signal(), response({}, 429));
  assert.equal(r.retrySource, "local");
  assert.ok(r.retryAt! >= before + 300000 && r.retryAt! <= Date.now() + 300000);
  const denied = await fetchUsage("xai", auth, signal(), response({}, 401));
  assert.equal(denied.retryAt, undefined);
});

test("Per-provider backoff survives dashboard requests without auth/network retry", async () => {
  let clock = 1000000;
  const calls: string[] = [];
  const request: typeof fetchUsage = async id => {
    calls.push(id);
    return id === "zai" ? { id, name: "GLM", status: "error", meters: [], httpStatus: 429,
      retryAt: clock + 120000, retrySource: "server", note: "HTTP 429" }
      : { id, name: id, status: "ready", meters: [{ label: "Week", percent: 1 }] };
  };
  const query = createUsageQuery(request, () => clock);
  await query("zai", auth, signal());
  clock += 60000;
  const blocked = await query("zai", auth, signal());
  assert.equal(blocked.retryAt, 1120000);
  await query("xai", auth, signal());
  assert.deepEqual(calls, ["zai", "xai"]);
  clock += 60000;
  await query("zai", auth, signal());
  assert.deepEqual(calls, ["zai", "xai", "zai"]);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(query("zai", auth, cancelled.signal));
  assert.equal(calls.length, 3);
});

test("Missing auth makes no network requests", async () => {
  let called = false;
  const r = await fetchUsage("zai", { getProviderAuth: async () => undefined }, signal(), async () => {
    called = true; throw new Error();
  });
  assert.equal(r.status, "missing"); assert.equal(called, false);
});

test("Provider-specific credentials are resolved on each request and use fixed endpoints", async () => {
  const fixtures: Record<ProviderId, unknown> = {
    zai: { success: true, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 5 }] } },
    xai: { config: { creditUsagePercent: 5 } },
    "openai-codex": { rate_limit: { primary_window: { used_percent: 5 } } },
    "opencode-go": { usage: { rolling: { status: "ok", percent: 5, resetsAt: "2026-10-01T00:00:00Z" } } },
  };
  const resolved: string[] = [];
  for (const id of Object.keys(fixtures) as ProviderId[]) {
    const resolver = { getProviderAuth: async (provider: string) => {
      resolved.push(provider); return { auth: { apiKey: "secret" } };
    } };
    const r = await fetchUsage(id, resolver, signal(), async (url, init) => {
      assert.equal(url, endpoints[id]); assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), id === "zai" ? "secret" : "Bearer secret");
      if (id === "xai") assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
      assert.ok(init?.signal);
      return response(fixtures[id])(url, init);
    });
    assert.equal(r.status, "ready");
    assert.equal(r.meters[0].percent, 5);
    assert.ok(r.fetchedAt);
  }
  assert.deepEqual(resolved, Object.keys(fixtures));
});

test("OpenCode Go uses only its own Pi auth and the verified usage endpoint", async () => {
  assert.equal(endpoints["opencode-go"], "https://opencode.ai/zen/go/v1/usage");
  const missing = await fetchUsage("opencode-go", { getProviderAuth: async id => {
    assert.equal(id, "opencode-go"); return undefined;
  } }, signal(), async () => { assert.fail("No request without Go auth"); });
  assert.equal(missing.status, "missing");
  for (const status of [401, 403, 429, 500]) {
    const result = await fetchUsage("opencode-go", auth, signal(), response({ error: "test-secret" }, status));
    assert.equal(result.status, "error");
    assert.equal(result.httpStatus, status);
    assert.deepEqual(result.meters, []);
    assert.ok(!JSON.stringify(result).includes("test-secret"));
  }
  const malformed = await fetchUsage("opencode-go", auth, signal(), response({ usage: {} }));
  assert.equal(malformed.status, "error");
  assert.match(malformed.note!, /format not recognized/);
});

test("Codex gets account id from the same resolved token", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url");
  const resolver = { getProviderAuth: async () => ({ auth: { apiKey: `test.${claims}.signature` } }) };
  await fetchUsage("openai-codex", resolver, signal(), async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "account-123");
    return new Response("{}", { status: 401 });
  });
});

test("HTTP failures do not expose response body or credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    const r = await fetchUsage("xai", auth, signal(), response({ token: "test-secret" }, status));
    assert.equal(r.status, "error");
    assert.ok(!JSON.stringify(r).includes("test-secret"));
    assert.equal(r.meters.length, 0);
  }
});

test("Auth/network/schema errors are sanitized", async () => {
  const authError = await fetchUsage("xai", { getProviderAuth: async () => { throw new Error("test-secret"); } }, signal());
  assert.match(authError.note!, /authentication failed/);
  const network = await fetchUsage("xai", auth, signal(), async () => { throw new Error("test-secret"); });
  assert.match(network.note!, /Could not reach/);
  const schema = await fetchUsage("xai", auth, signal(), response({ unexpected: "test-secret" }));
  assert.match(schema.note!, /format not recognized/);
  assert.ok(!JSON.stringify([authError, network, schema]).includes("test-secret"));
});

test("Cancelling while auth resolves prevents network calls", async () => {
  const controller = new AbortController();
  let resolve!: (value: { auth: { apiKey: string } }) => void;
  const pending = new Promise<{ auth: { apiKey: string } }>(r => { resolve = r; });
  let fetched = false;
  const result = fetchUsage("xai", { getProviderAuth: () => pending }, controller.signal, async () => {
    fetched = true; throw new Error();
  });
  controller.abort();
  assert.equal((await result).note, "Cancelled");
  resolve({ auth: { apiKey: "secret" } });
  await Promise.resolve();
  assert.equal(fetched, false);
});

test("Already-cancelled requests do not resolve auth", async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  const r = await fetchUsage("xai", { getProviderAuth: async () => { called = true; return undefined; } }, controller.signal);
  assert.equal(r.note, "Cancelled"); assert.equal(called, false);
});

test("Timeout covers both response headers and body consumption", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const headers = await fetchUsage("xai", auth, signal(), () => new Promise(() => {}), 10);
    assert.match(headers.note!, /Timed out/);
    const body = await fetchUsage("xai", auth, signal(), async () => ({
      ok: true, json: () => new Promise(() => {}),
    } as unknown as Response), 10);
    assert.match(body.note!, /Timed out/);
  } finally { clearTimeout(keepAlive); }
});

test("Auth resolution is bounded by a timeout", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const r = await fetchUsage("xai", { getProviderAuth: () => new Promise(() => {}) }, signal(), response({}), 10);
    assert.match(r.note!, /Timed out/);
  } finally { clearTimeout(keepAlive); }
});
