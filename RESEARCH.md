# Historical research and implementation evidence

This records the original investigation. Current scope is GLM, Grok and Codex only. Claude support, token input and dedicated Keychain credential were subsequently removed at the user's request; historical Claude references below do not describe current features.

## Requested temporary repository reviews

Subagents inspected the requested subdirectories read-only, against installed Pi 0.87.1. Neither third-party extension was installed or executed. Static compatibility is not runtime proof.

### Sreetej510/pi-extensions — `extensions/pi-usage`

- Clone: `/tmp/pi-extensions-review.jRThY2`
- Branch/ref: `master`, `bb77b3142d575c8e2661e60d45731a54f433bbf6`
- Source: https://github.com/Sreetej510/pi-extensions/tree/master/extensions/pi-usage
- Implements Claude OAuth and Codex subscription usage, **not GLM or Grok** (`src/models.ts:4–14`, `src/constants.ts:6–12`, `src/query.ts:20–30`).
- Shows notifications and installs a custom footer, **not a plan-usage modal** (`src/format.ts:69–80`, `src/index.ts:60–73`).
- Main auth resolution uses Pi's model registry; declarations are compatible with installed Pi. Codex may fall back to an external CLI/account, which need not match Pi.
- Extra features include raw responses, a provider-keyed shared disk cache, and confirmed consumption of banked Codex resets. These are unnecessary for a read-only four-provider viewer.
- Review concerns: body timeout ends too early, no command cancellation, cache not account-scoped, overly broad raw/error reporting, global footer takeover.
- **Decision:** useful endpoint/auth patterns, but not a drop-in solution. No source code copied.

### tmustier/pi-extensions — `usage-extension`

- Clone: `/tmp/pi-usage-tmustier.JNPCSN`
- Branch/ref: `main`, `4a63a2ebd3683d86597e226c7ff778ea4837dd73`
- Source: https://github.com/tmustier/pi-extensions/tree/main/usage-extension
- Aggregates local Pi session JSONL token counts and stored costs (`data.ts:235–271`, `data.ts:709–728`). All four provider names can appear in history; this does **not** measure their account quotas.
- Has graphs/tables/insights and a custom inline view, not an overlay (`index.ts:931–1003`). No provider auth or quota endpoints.
- Pi 0.87.1 imports/APIs appear compatible statically. Its `hasUI` check should be a TUI-mode check for custom components.
- Writes history metadata caches and optional exports; unrelated to this task's minimal live-plan view.
- **Decision:** appropriate for historical local statistics, not subscription usage/limits. No source code copied.

Both repositories are MIT licensed; copying substantial portions would require retaining their notices. This implementation is new, using the documented Pi component/auth APIs and independently verified endpoint behavior.

## Endpoint research and live verification

| Provider | Read-only GET endpoint | Evidence |
|---|---|---|
| Claude | `https://api.anthropic.com/api/oauth/usage` | Sreetej510 adapter; local oh-my-pi usage adapter; fixture tests only here |
| GLM | `https://api.z.ai/api/monitor/usage/quota/limit` | local oh-my-pi `packages/ai/src/usage/zai.ts`; successful live Pi-auth query |
| Grok | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` | CodexBar `GrokCreditsProxyFetcher.swift`; successful live Pi-auth query |
| Codex | `https://chatgpt.com/backend-api/wham/usage` | Sreetej510 and local oh-my-pi adapters; successful live Pi-auth query |

Grok reference: https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Grok/GrokCreditsProxyFetcher.swift

The Grok reference identifies the CLI JSON billing endpoint as the bearer-token route. The older grok.com gRPC-web endpoint requires browser-held signing material; no browser-token workaround is attempted. The live JSON response here supplies `config.creditUsagePercent` and a billing/reset period.

Pi's installed `ModelRegistry.getProviderAuth()` delegates to `ModelRuntime.getAuth()`. We leave credential resolution and refresh to that runtime rather than independently writing tokens.

Initial live observation on this machine (2026-09-26; values change):
- GLM Max: 1% 5-hour, 1% weekly; monthly tool quota 0 / 4,000.
- Grok shared pool: 79%.
- Codex Pro: 35% weekly; primary window not supplied.
- Claude: no Pi auth configured. No credential was sought from unrelated applications.

## Verification scope

- Unit tests cover all four parsers, malformed/missing data, zero versus unknown, paid extra usage separation, correct auth headers, Codex account matching, timeout/cancellation and sanitized failures.
- Modal tests cover terminal widths/heights, scrolling, independent partial results, refresh cooldown, cleanup and late-result suppression.
- Typechecked against the actual installed Pi 0.87.1 declarations.
- Real Pi pseudo-terminal smoke test passes in regular and fullscreen modes with live usage bars, four provider sections, narrow resize, scrolling and Escape.
- No live Claude usage test is claimed. No tests prove future stability of these provider-owned endpoints.
