# Current validation

Scope: `/usage` for **GLM/Z.ai, Grok, OpenAI Codex, and OpenCode Go**, using existing Pi authentication.

- **37 tests passed** for v0.4, including reported zero/partial/exhausted windows, malformed schemas, provider-specific auth, sanitized HTTP errors, modal scrolling, separate bar colors, small nonzero usage, ANSI-aware layout and the compact inline checked-time header.
- The v0.4 dashboard was visually approved by the user; [the screenshot](docs/images/usage-dashboard.png) shows all four providers with the updated bars and header.
- `npm run typecheck` passes against installed Pi 0.87.1.
- At v0.2, `python3 scripts/smoke-tui.py` passed real Pi regular/fullscreen sessions (not rerun for the v0.3/v0.4 visual changes): four provider sections, live bars, no discontinued-provider UI, narrow resize, scrolling and Escape dismissal.
- Provider-list regression test permits only `zai`, `xai`, `openai-codex`, `opencode-go`.
- `npm run check:live` returns ready snapshots for all four providers. OpenCode Go reports 0% rolling, 2% weekly and 1% monthly at verification (2026-09-30), with reset timestamps.
- Command tests verify only `/usage` is registered and no credential input commands exist. Former C/D credential controls are inert.
- HTTP tests cover fixed endpoints and auth headers, account matching, sanitized errors, cancellation, whole-request deadlines, Retry-After parsing and per-provider cooldowns across dashboard opens.
- No remaining Claude/Anthropic integration, Keychain access or secret-prompt imports in runtime source or the live-check script.

## Credential cleanup

The extension-owned Keychain entry with service `pi-plan-usage.claude-oauth` and account `usage-only` was deleted successfully using `security delete-generic-password`. Its value was not read or printed. Claude Code credentials and Pi's auth store were not changed. No Claude network requests were made during this removal.

## Remaining limitations

Only provider-reported windows and percentages are shown. No inferred subscription limits or local-token approximations. Upstream endpoint formats/availability can change. Rate-limit backoff is scoped to the extension runtime and resets on `/reload` or process restart. Live tests cover the configured accounts, not every subscription tier.

Installation can use the GitHub package globally or a local checkout for development; see [README.md](README.md). Avoid loading both sources together. Run `/reload` after installation or updates.
