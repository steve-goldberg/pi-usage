import { parseCodex, parseGrok, parseZai, parseOpenCodeGo, providers, record, type ProviderId, type Snapshot } from "./usage.ts";

// The caller resolves credentials; no credential cache here.
export interface AuthResolver {
  getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>;
}
export const endpoints: Record<ProviderId, string> = {
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
  xai: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
};
const parsers = { zai: parseZai, xai: parseGrok, "openai-codex": parseCodex, "opencode-go": parseOpenCodeGo };

/** HTTP Retry-After is either seconds or an HTTP date, not a quota reset. */
export function retryAfterAt(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return;
  const raw = value.trim();
  const at = /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000
    : /[A-Za-z]/.test(raw) ? Date.parse(raw) : NaN;
  return Number.isFinite(at) && at >= now && at <= 8.64e15 ? at : undefined;
}

/** Retain only 429 metadata across modal instances; never credentials or account data. */
export function createUsageQuery(request: typeof fetchUsage = fetchUsage, now = Date.now) {
  const cooldowns = new Map<ProviderId, Snapshot>();
  return async (id: ProviderId, resolver: AuthResolver, signal: AbortSignal): Promise<Snapshot> => {
    signal.throwIfAborted();
    const blocked = cooldowns.get(id);
    if (blocked?.retryAt !== undefined && blocked.retryAt > now()) return { ...blocked };
    cooldowns.delete(id);
    const result = await request(id, resolver, signal);
    if (result.httpStatus === 429 && result.retryAt !== undefined) cooldowns.set(id, result);
    return result;
  };
}

function accountId(token: string): string | undefined {
  try {
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
    const id = record(claims["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && /^[\w-]+$/.test(id) ? id : undefined;
  } catch { return; }
}

/** A timeout/cancel also bounds auth resolution even on older Pi APIs without a signal parameter. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function fetchUsage(
  id: ProviderId,
  resolver: AuthResolver,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  timeoutMs = 12_000,
): Promise<Snapshot> {
  const base = { id, name: providers.find(p => p.id === id)!.name, meters: [] };
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let stage: "auth" | "network" | "parse" = "auth";
  try {
    combined.throwIfAborted();
    const resolved = await abortable(resolver.getProviderAuth(id), combined);
    combined.throwIfAborted();
    const token = resolved?.auth.apiKey;
    if (!token) return { ...base, status: "missing", note: "No Pi authentication configured" };
    const headers: Record<string, string> = {
      Accept: "application/json", "User-Agent": "pi-plan-usage/0.1",
      Authorization: id === "zai" ? token : `Bearer ${token}`,
    };
    if (id === "xai") headers["x-xai-token-auth"] = "xai-grok-cli";
    if (id === "openai-codex") {
      const account = accountId(token);
      if (account) headers["ChatGPT-Account-Id"] = account;
    }
    stage = "network";
    // Fixed provider endpoints, no redirects: never forward credentials to an arbitrary host.
    const response = await abortable(fetcher(endpoints[id], { headers, signal: combined, redirect: "error" }), combined);
    if (!response.ok) {
      const serverRetryAt = response.status === 429 ? retryAfterAt(response.headers.get("retry-after")) : undefined;
      const note = response.status === 401 || response.status === 403
        ? `HTTP ${response.status} · usage access denied; check Pi login`
        : response.status === 429 ? "HTTP 429 · rate limited; token validity unknown" : `Usage endpoint returned HTTP ${response.status}`;
      await response.body?.cancel();
      return { ...base, status: "error", note, httpStatus: response.status,
        ...(response.status === 429 ? {
          retryAt: serverRetryAt ?? Date.now() + 5 * 60_000,
          retrySource: serverRetryAt === undefined ? "local" as const : "server" as const,
        } : {}),
      };
    }
    stage = "parse";
    const usage = parsers[id](await abortable(response.json(), combined));
    return { ...base, ...usage, status: "ready", fetchedAt: Date.now() };
  } catch {
    // Never expose error bodies, auth errors, JWTs or raw provider payloads.
    const note = signal.aborted ? "Cancelled" : timeout.aborted ? "Timed out · retry later"
      : stage === "auth" ? "Usage authentication failed · check Pi login"
      : stage === "parse" ? "Usage data unavailable · endpoint format not recognized"
      : "Could not reach usage endpoint";
    return { ...base, status: "error", note };
  }
}
