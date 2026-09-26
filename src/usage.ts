export type ProviderId = "zai" | "xai" | "openai-codex";
export const providers: ReadonlyArray<{ id: ProviderId; name: string }> = [
  { id: "zai", name: "GLM · Z.ai" },
  { id: "xai", name: "Grok" },
  { id: "openai-codex", name: "OpenAI · Codex" },
];
export interface Meter {
  label: string;
  percent?: number;
  used?: number;
  limit?: number;
  unit?: string;
  resetsAt?: number;
}
export interface Usage {
  plan?: string;
  meters: Meter[];
}
export interface Snapshot extends Usage {
  id: ProviderId;
  name: string;
  status: "loading" | "ready" | "missing" | "unsupported" | "error";
  note?: string;
  fetchedAt?: number;
  httpStatus?: number;
  retryAt?: number;
  retrySource?: "server" | "local";
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function number(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  // Provider-controlled text never becomes terminal control sequences.
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80);
}
export function timestamp(value: unknown): number | undefined {
  const n = number(value);
  const ms = n !== undefined ? (n < 1e12 ? n * 1000 : n) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : undefined;
}
function percentage(used: unknown, limit: unknown, fallback?: unknown): number | undefined {
  const u = number(used), l = number(limit);
  return u !== undefined && l !== undefined && l > 0 ? number(u / l * 100) ?? number(fallback) : number(fallback);
}
function requireMeters(usage: Usage): Usage {
  if (!usage.meters.length) throw new Error("schema");
  return usage;
}
function windowName(seconds: unknown, fallback: string): string {
  const s = number(seconds);
  if (!s) return fallback;
  if (s % 86400 === 0) return `${s / 86400} day`;
  if (s % 3600 === 0) return `${s / 3600} hour`;
  return `${Math.round(s / 60)} minute`;
}

export function parseCodex(payload: unknown): Usage {
  const p = record(payload);
  const meters: Meter[] = [];
  const add = (value: unknown, prefix = "") => {
    const group = record(value);
    for (const [key, fallback] of [["primary_window", "Primary"], ["secondary_window", "Secondary"]]) {
      const w = record(group[key]);
      const percent = number(w.used_percent);
      if (percent === undefined) continue;
      meters.push({ label: prefix + windowName(w.limit_window_seconds, fallback), percent,
        resetsAt: timestamp(w.reset_at) });
    }
  };
  add(p.rate_limit);
  add(p.code_review_rate_limit, "Code review · ");
  if (Array.isArray(p.additional_rate_limits)) {
    for (const extra of p.additional_rate_limits) {
      const e = record(extra);
      add(e.rate_limit, `${safeText(e.limit_name) || safeText(e.metered_feature) || "Additional"} · `);
    }
  }
  return requireMeters({ plan: safeText(p.plan_type), meters });
}

export function parseZai(payload: unknown): Usage {
  const p = record(payload), data = record(p.data);
  if (p.success !== true || !Array.isArray(data.limits)) throw new Error("schema");
  const meters: Meter[] = [];
  for (const value of data.limits) {
    const w = record(value);
    const units: Record<string, string> = { TOKENS_LIMIT: "tokens", TIME_LIMIT: "requests", CREDIT_LIMIT: "credits" };
    const unit = units[String(w.type)];
    if (!unit) continue;
    const count = number(w.number) || 1;
    const periods: Record<string, string> = { "3": `${count} hour`, "4": `${count} day`, "5": `${count} month`, "6": "7 day" };
    const used = number(w.currentValue), limit = number(w.usage);
    const percent = percentage(used, limit, w.percentage);
    const features = Array.isArray(w.usageDetails) && w.usageDetails.some(d => record(d).modelCode === "web-reader");
    meters.push({ label: `${periods[String(w.unit)] || "Quota"} · ${features ? "tools" : unit}`,
      percent, used, limit, unit, resetsAt: timestamp(w.nextResetTime) });
  }
  return requireMeters({ plan: safeText(data.level), meters });
}

export function parseGrok(payload: unknown): Usage {
  const p = record(payload), c = record(p.config), period = record(c.currentPeriod);
  if (!Object.keys(c).length) throw new Error("schema");
  const percent = number(c.creditUsagePercent);
  const resetsAt = timestamp(period.end) ?? timestamp(c.billingPeriodEnd);
  const meters: Meter[] = [];
  if (percent !== undefined || resetsAt !== undefined) {
    meters.push({ label: "Shared plan pool", percent, resetsAt });
  }
  const used = number(record(c.onDemandUsed).val), limit = number(record(c.onDemandCap).val);
  // Paid extra usage is a separate meter, never a substitute for the plan pool.
  if (limit !== undefined && limit > 0 && used !== undefined) {
    meters.push({ label: "On-demand (paid)", percent: percentage(used, limit), used, limit });
  }
  return requireMeters({ plan: safeText(c.subscriptionTier) || safeText(p.subscriptionTier), meters });
}
