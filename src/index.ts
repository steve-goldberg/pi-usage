import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUsageQuery } from "./client.ts";
import { UsageModal } from "./modal.ts";

export default function planUsage(pi: ExtensionAPI): void {
  const active = new Set<UsageModal>();
  const queryUsage = createUsageQuery();
  pi.registerCommand("usage", {
    description: "Show GLM, Grok and Codex plan usage",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/usage requires Pi's interactive terminal UI", "info");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Run /usage without arguments. Authentication comes from Pi.", "warning");
        return;
      }
      let modal: UsageModal | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          modal = new UsageModal(theme, () => tui.requestRender(), () => tui.terminal.rows,
            done, (id, signal) => queryUsage(id, ctx.modelRegistry, signal));
          active.add(modal);
          void modal.refresh();
          return modal;
        }, { overlay: true, overlayOptions: { width: 84, maxHeight: "100%", anchor: "center", margin: 1 } });
      } finally {
        if (modal) { modal.dispose(); active.delete(modal); }
      }
    },
  });
  pi.on("session_shutdown", async () => {
    for (const modal of active) modal.dispose();
    active.clear();
  });
}
