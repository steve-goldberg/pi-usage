import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
function command() {
  const commands = new Map<string, Handler>();
  extension({
    registerCommand(name: string, def: { handler: Handler }) { commands.set(name, def.handler); },
    on() {},
  } as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["usage"]);
  return commands.get("usage")!;
}
function context() {
  let opened = 0;
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => { opened++; },
      notify: (message: string) => { notices.push(message); },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, opened: () => opened };
}

test("Only /usage is registered; arguments are rejected without echoing", async () => {
  const c = context();
  await command()("sensitive-value", c.ctx);
  assert.equal(c.opened(), 0);
  assert.equal(c.notices.length, 1);
  assert.ok(!c.notices[0].includes("sensitive-value"));
});

test("Command opens just the dashboard", async () => {
  const c = context();
  await command()("", c.ctx);
  assert.equal(c.opened(), 1);
  assert.deepEqual(c.notices, []);
});

test("RPC does not open a custom terminal component", async () => {
  const c = context();
  c.ctx.mode = "rpc";
  await command()("", c.ctx);
  assert.equal(c.opened(), 0);
  assert.match(c.notices[0], /interactive/);
});
