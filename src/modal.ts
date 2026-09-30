import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { providers, type Snapshot, type ProviderId, type Meter, safeText } from "./usage.ts";

type Palette = Pick<Theme, "fg" | "bold" | "style">;
const usedColor = parseColor("#3975C6");
const unusedColor = parseColor("#B8C9DF");
type Loader = (id: ProviderId, signal: AbortSignal) => Promise<Snapshot>;

export function bar(percent: number | undefined, width: number, theme: Palette): string {
  const n = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  if (percent === undefined || !Number.isFinite(percent)) return theme.fg("dim", "░".repeat(n));
  const clamped = Math.max(0, Math.min(100, percent));
  // Keep small nonzero usage visible; the adjacent number remains authoritative.
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped / 100 * n));
  return (filled ? theme.style("▄".repeat(filled), { fg: usedColor }) : "")
    + (filled < n ? theme.style("▄".repeat(n - filled), { fg: unusedColor }) : "");
}
export function resetText(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  if (at <= now) return "reset due · refresh";
  const mins = Math.ceil((at - now) / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `resets in ${hours}h ${mins % 60}m` : `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function meterLines(m: Meter, width: number, theme: Palette, now: number): string[] {
  const percent = Number.isFinite(m.percent) ? m.percent : undefined;
  const color = percent === undefined ? "dim" : percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
  const label = safeText(m.label) || "Usage";
  const percentLabel = percent === undefined ? "not reported" : `${Math.round(percent * 10) / 10}% used`;
  const barWidth = Math.max(4, Math.min(24, width - 18));
  const line = `${bar(percent, barWidth, theme)} ${theme.fg(color, percentLabel)}`;
  const detail = [m.used !== undefined && m.limit !== undefined
    ? `${m.used.toLocaleString()} / ${m.limit.toLocaleString()}${m.unit ? ` ${m.unit}` : ""}` : "",
    resetText(m.resetsAt, now)].filter(Boolean).join(" · ");
  if (width >= 64) {
    const labelWidth = 24;
    const short = truncateToWidth(label, labelWidth);
    return [`${short}${" ".repeat(Math.max(1, labelWidth + 1 - visibleWidth(short)))}${line}`,
      ...(detail ? [theme.fg("dim", `  ${detail}`)] : [])];
  }
  return [theme.fg("muted", label), line, ...(detail ? [theme.fg("dim", detail)] : [])];
}

export class UsageModal {
  private snapshots: Snapshot[] = providers.map(p => ({ ...p, status: "loading", meters: [] }));
  private controller = new AbortController();
  private disposed = false;
  private loading = false;
  private lastFetch = 0;
  private offset = 0;
  private contentLength = 0;
  private pageSize = 1;
  private hint = "";

  private theme: Palette;
  private requestRender: () => void;
  private terminalHeight: () => number;
  private done: () => void;
  private load: Loader;
  private now: () => number;

  constructor(theme: Palette, requestRender: () => void, terminalHeight: () => number,
    done: () => void, load: Loader, now: () => number = Date.now) {
    this.theme = theme;
    this.requestRender = requestRender;
    this.terminalHeight = terminalHeight;
    this.done = done;
    this.load = load;
    this.now = now;
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.loading) return;
    const cooldown = 60_000 - (this.now() - this.lastFetch);
    if (this.lastFetch && cooldown > 0) {
      this.hint = `Refresh available in ${Math.ceil(cooldown / 1000)}s`;
      this.requestRender();
      return;
    }
    this.loading = true;
    this.lastFetch = this.now();
    this.hint = "";
    this.snapshots = providers.map(p => ({ ...p, status: "loading", meters: [] }));
    this.requestRender();
    await Promise.all(providers.map(async (p, index) => {
      let result: Snapshot;
      try { result = await this.load(p.id, this.controller.signal); }
      catch { result = { ...p, meters: [], status: "error", note: "Usage unavailable" }; }
      if (this.disposed) return;
      this.snapshots[index] = result;
      this.requestRender();
    }));
    if (!this.disposed) {
      this.loading = false;
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
      this.dispose();
      this.done();
      return;
    }
    if (data === "r" || data === "R") { void this.refresh(); return; }
    if (matchesKey(data, "down") || data === "j") this.offset++;
    if (matchesKey(data, "up") || data === "k") this.offset--;
    if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
    if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    if (matchesKey(data, "home")) this.offset = 0;
    if (matchesKey(data, "end")) this.offset = this.contentLength;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.contentLength - this.pageSize)));
    this.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    if (w < 8) return [truncateToWidth("/usage", w)];
    if (this.terminalHeight() < 10) {
      return ["PLAN USAGE", "Enlarge terminal", "Esc close"]
        .slice(0, Math.max(1, this.terminalHeight() - 2)).map(line => truncateToWidth(line, w));
    }
    const inner = w - 4;
    const content: string[] = [];
    const now = this.now();
    for (const s of this.snapshots) {
      const plan = safeText(s.plan);
      content.push(this.theme.bold(this.theme.fg("accent", s.name)) + (plan ? this.theme.fg("muted", ` · ${plan}`) : ""));
      if (s.status === "ready") {
        for (const m of s.meters) content.push(...meterLines(m, inner, this.theme, now));
      } else {
        content.push(this.theme.fg(s.status === "error" ? "warning" : "dim",
          s.status === "loading" ? "Checking plan usage…" : safeText(s.note) || "Unavailable"));
        if (s.status === "missing") content.push(this.theme.fg("dim", `Configure ${s.id} in Pi first`));
        if (s.retryAt !== undefined) {
          const remaining = Math.max(0, Math.ceil((s.retryAt - now) / 1000));
          content.push(this.theme.fg("dim", remaining > 0
            ? `Retry after ${new Date(s.retryAt).toLocaleTimeString()} (${Math.ceil(remaining / 60)}m)`
            : "Cooldown ended · press R to retry"));
          content.push(this.theme.fg("dim", s.retrySource === "server"
            ? "Cooldown from provider Retry-After header"
            : "5-minute local backoff; no valid Retry-After received"));
        }
      }
      content.push("");
    }
    const wrapped = content.flatMap(line => wrapTextWithAnsi(line, inner));
    this.contentLength = wrapped.length;
    this.pageSize = Math.max(1, this.terminalHeight() - 8);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, wrapped.length - this.pageSize)));
    const body = wrapped.slice(this.offset, this.offset + this.pageSize);
    const frame = (s: string) => {
      const text = truncateToWidth(s, inner);
      return this.theme.fg("border", "│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + this.theme.fg("border", " │");
    };
    const scrolling = wrapped.length > this.pageSize ? ` · ${this.offset + 1}–${Math.min(wrapped.length, this.offset + this.pageSize)}/${wrapped.length}` : "";
    const footer = this.hint || (this.loading ? "Checking… · Esc close · ↑↓ scroll" : "R refresh · Esc close · ↑↓ scroll");
    const checked = this.snapshots.flatMap(s => s.fetchedAt === undefined ? [] : [s.fetchedAt]);
    const checkedText = checked.length ? ` - checked ${new Date(Math.min(...checked)).toLocaleTimeString()}` : "";
    return [this.theme.fg("border", `╭${"─".repeat(w - 2)}╮`),
      frame(this.theme.bold("PLAN USAGE") + this.theme.fg("dim", checkedText)),
      frame(""), ...body.map(frame), frame(this.theme.fg("dim", footer + scrolling)),
      this.theme.fg("border", `╰${"─".repeat(w - 2)}╯`)];
  }
  invalidate(): void {}
  dispose(): void { this.disposed = true; this.controller.abort(); }
}
