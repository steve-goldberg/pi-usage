import test from "node:test";
import assert from "node:assert/strict";
import { colorToHex, parseColor, styleText, visibleWidth, type TextStyle } from "@earendil-works/pi-tui";
import { UsageModal, bar, resetText } from "../src/modal.ts";
import type { Snapshot, ProviderId } from "../src/usage.ts";
const theme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
};
const coloredTheme = {
  ...theme,
  style: (text: string, options: TextStyle) => styleText(text, options, "truecolor"),
};
const now = 1790434000000;
function ready(id: ProviderId): Snapshot {
  return { id, name: id, status: "ready", plan: "Plan", meters: [
    { label: "5 hour", percent: 79, resetsAt: now + 3600000 },
    { label: "7 day", percent: 0, used: 0, limit: 10000, unit: "tokens" },
  ] };
}

test("Removed credential controls do not open any flow", async () => {
  let closed = 0;
  const modal = new UsageModal(theme, () => {}, () => 40, () => { closed++; }, async id => ready(id));
  await modal.refresh();
  assert.doesNotMatch(modal.render(84).join("\n"), /Claude|token input|remove token/);
  for (const key of ["c", "C", "d", "D"]) modal.handleInput(key);
  assert.equal(closed, 0);
  modal.dispose();
});

test("Rate-limit UI distinguishes local backoff from a provider retry instruction", async () => {
  for (const retrySource of ["local", "server"] as const) {
    let clock = now;
    const modal = new UsageModal(theme, () => {}, () => 80, () => {}, async id => ({
      id, name: id, status: "error", meters: [], httpStatus: 429,
      note: "HTTP 429 · rate limited; token validity unknown", retryAt: now + 300000, retrySource,
    }), () => clock);
    await modal.refresh();
    const screen = modal.render(84).join("\n");
    assert.match(screen, /token validity unknown/);
    assert.match(screen, /Retry after/);
    assert.match(screen, retrySource === "server" ? /provider Retry-After/ : /local backoff/);
    clock += 300000;
    assert.match(modal.render(84).join("\n"), /Cooldown ended/);
    modal.dispose();
  }
});

test("Bars distinguish unknown from zero and clamp graphics only", () => {
  const used = (n: number) => coloredTheme.style("▄".repeat(n), { fg: parseColor("#3975C6") });
  const unused = (n: number) => coloredTheme.style("▄".repeat(n), { fg: parseColor("#B8C9DF") });
  for (const percent of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(bar(percent, 10, coloredTheme), "░".repeat(10));
  }
  assert.equal(bar(0, 10, coloredTheme), unused(10));
  assert.equal(bar(-10, 10, coloredTheme), unused(10));
  assert.equal(bar(100, 10, coloredTheme), used(10));
  assert.equal(bar(150, 10, coloredTheme), used(10));
  assert.equal(bar(50, 10, coloredTheme), used(5) + unused(5));
  assert.equal(bar(1, 24, coloredTheme), used(1) + unused(23));
  assert.equal(bar(0.1, 4, coloredTheme), used(1) + unused(3));
  for (const width of [0, -1, NaN, Infinity]) {
    assert.equal(visibleWidth(bar(50, width, coloredTheme)), 1);
  }
  assert.equal(visibleWidth(bar(50, 10.9, coloredTheme)), 10);
  assert.equal(resetText(now - 1, now), "reset due · refresh");
  assert.equal(resetText(now + 60000, now), "resets in 1m");
});

test("Bar colors stay blue while percentage labels retain severity colors", async () => {
  const styles: string[] = [];
  const labels: Array<[unknown, string]> = [];
  const spyTheme = {
    ...theme,
    fg: (color: unknown, text: string) => { labels.push([color, text]); return text; },
    style: (text: string, options: TextStyle) => {
      styles.push(colorToHex(options.fg!));
      return coloredTheme.style(text, options);
    },
  };
  const modal = new UsageModal(spyTheme, () => {}, () => 80, () => {}, async id => ({
    id, name: id, status: "ready", meters: [1, 70, 90, 150, NaN].map(percent => ({ label: "Usage", percent })),
  }), () => now);
  await modal.refresh();
  const screen = modal.render(84).join("\n");
  assert.deepEqual(new Set(styles), new Set(["#3975c6", "#b8c9df"]));
  for (const [color, text] of [["success", "1% used"], ["warning", "70% used"],
    ["error", "90% used"], ["error", "150% used"], ["dim", "not reported"]]) {
    assert.ok(labels.some(([c, t]) => c === color && t === text));
  }
  assert.ok(!screen.includes("NaN"));
  modal.dispose();
});

test("Modal fits narrow/wide terminals and stays within viewport after resize", async () => {
  let height = 40;
  const modal = new UsageModal(coloredTheme, () => {}, () => height, () => {}, async id => ready(id), () => now);
  await modal.refresh();
  for (const width of [1, 7, 12, 20, 40, 64, 84, 120]) {
    for (const rows of [1, 6, 9, 12, 24, 40]) {
      height = rows;
      const lines = modal.render(width);
      assert.ok(lines.every(l => visibleWidth(l) <= width), `overflow at ${width}x${rows}`);
      assert.ok(lines.length <= rows, `height overflow at ${width}x${rows}`);
    }
  }
  modal.dispose();
});

test("All provider results are visible or reachable by keyboard scrolling", async () => {
  const modal = new UsageModal(theme, () => {}, () => 15, () => {}, async id => ready(id), () => now);
  await modal.refresh();
  const start = modal.render(84).join("\n");
  assert.ok(start.includes("zai"));
  for (let n = 0; n < 50; n++) modal.handleInput("j");
  const end = modal.render(84).join("\n");
  assert.ok(end.includes("opencode-go"));
  assert.notEqual(start, end);
  modal.dispose();
});

test("Each provider updates independently while another is loading", async () => {
  let finish!: (s: Snapshot) => void;
  const pending = new Promise<Snapshot>(resolve => { finish = resolve; });
  const modal = new UsageModal(theme, () => {}, () => 80, () => {}, async id => id === "xai" ? pending : ready(id), () => now);
  const refresh = modal.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const lines = modal.render(84).join("\n");
  assert.ok(lines.includes("79% used"));
  assert.ok(lines.includes("Checking plan usage"));
  finish(ready("xai")); await refresh;
  assert.ok(!modal.render(84).join("\n").includes("Checking plan usage"));
  modal.dispose();
});

test("Escape aborts work and late results cannot render after disposal", async () => {
  let renders = 0, closed = 0;
  const signals: AbortSignal[] = [];
  const finishes: Array<() => void> = [];
  const modal = new UsageModal(theme, () => { renders++; }, () => 40, () => { closed++; },
    (id, signal) => { signals.push(signal); return new Promise(resolve => finishes.push(() => resolve(ready(id)))); }, () => now);
  const refresh = modal.refresh();
  modal.handleInput("\x1b");
  assert.equal(closed, 1); assert.ok(signals.every(s => s.aborted));
  const before = renders;
  finishes.forEach(f => f()); await refresh;
  assert.equal(renders, before);
  modal.dispose();
});

test("Refresh is bounded, failures remain separate and never show fake bars", async () => {
  let clock = now, calls = 0;
  const modal = new UsageModal(theme, () => {}, () => 80, () => {}, async id => {
    calls++; if (id === "zai") throw new Error("secret"); return ready(id);
  }, () => clock);
  await modal.refresh(); await modal.refresh();
  assert.equal(calls, 4);
  assert.match(modal.render(84).join("\n"), /Refresh available in/);
  assert.ok(!modal.render(84).join("\n").includes("secret"));
  clock += 60001; await modal.refresh(); assert.equal(calls, 8);
  modal.dispose();
});
