// Explicit, read-only endpoint check. Pi may refresh its own OAuth credentials.
// No model calls. Print only normalized quota values, never auth or response bodies.
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fetchUsage } from "../src/client.ts";
import { providers } from "../src/usage.ts";
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
const results = await Promise.all(providers.map(p => fetchUsage(p.id, registry, new AbortController().signal)));
for (const result of results) console.log(JSON.stringify(result));
