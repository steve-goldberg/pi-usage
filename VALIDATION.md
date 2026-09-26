# Current validation

Scope: `/usage` for **GLM/Z.ai, Grok, and OpenAI Codex**, using existing Pi authentication.

- **32 tests passed** after removing the discontinued provider and its credential handling.
- `npm run typecheck` passes against installed Pi 0.87.1.
- `python3 scripts/smoke-tui.py` passes real Pi regular/fullscreen sessions: three provider sections, live bars, no discontinued-provider UI, narrow resize, scrolling and Escape dismissal.
- Provider-list regression test permits only `zai`, `xai`, `openai-codex`.
- Command tests verify only `/usage` is registered and no credential input commands exist. Former C/D credential controls are inert.
- HTTP tests cover fixed endpoints and auth headers, account matching, sanitized errors, cancellation, whole-request deadlines, Retry-After parsing and per-provider cooldowns across dashboard opens.
- No remaining Claude/Anthropic integration, Keychain access or secret-prompt imports in runtime source or the live-check script.

## Credential cleanup

The extension-owned Keychain entry with service `pi-plan-usage.claude-oauth` and account `usage-only` was deleted successfully using `security delete-generic-password`. Its value was not read or printed. Claude Code credentials and Pi's auth store were not changed. No Claude network requests were made during this removal.

## Remaining limitations

Only provider-reported windows and percentages are shown. No inferred subscription limits or local-token approximations. Upstream endpoint formats/availability can change. Rate-limit backoff is scoped to the extension runtime and resets on `/reload` or process restart. Live tests cover the configured accounts, not every subscription tier.

Project-local installation remains `.pi/settings.json` → `packages: [".."]`. Run `/reload` to replace the already-loaded extension with the simplified version.
