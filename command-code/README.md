# pi-command-code

A self-contained Pi extension that adds **Command Code** (`https://api.commandcode.ai`)
as a native provider — no `models.json` edits, no changes to your `usage-widget.ts`.

## What it does

1. **Native provider registration** via `pi.registerProvider()` (complete `Provider` from
   `@earendil-works/pi-ai`, built with `createProvider`):
   - Model list is discovered live from `GET https://api.commandcode.ai/provider/v1/models`.
   - Capability metadata (context window, max tokens, reasoning, tool/image compat flags,
     `thinkingLevelMap`) is reused from **Pi's built-in model catalog** by matching the
     Command Code model ID (with vendor prefixes stripped) or display name. Unknown vendors
     get a conservative synthesized model built from server-declared metadata.
   - The endpoint decides the protocol:
     - `/messages` → Pi's `anthropic-messages` implementation (Claude models)
     - `/chat/completions` → Pi's `openai-completions` implementation (GLM-5.3 Flash,
       MiMo-V2.6 Flash, Muse, GPT, etc.)
     - `/responses` → Pi's `openai-responses` implementation
   - **Cost is zeroed on every model.** Command Code bills a plan-wide **credit pool** on the
     server, not vendor per-token USD prices, so copying e.g. Anthropic's prices would show
     fictitious spend. Real consumption is shown via `/command-code.usage` instead.
   - Discovery failures (endpoint down, offline, no key) never clear registered models: the
     last-known-good catalog is restored from Pi's models store, and a fallback directory
     (GLM-5.3 Flash, MiMo-V2.6 Flash, Muse Spark 1.3, Claude Sonnet 4.6) covers first runs.

2. **Native login** — `/login command-code` prompts for the Command Code API key and Pi
   stores it in its normal credential store (`~/.pi/agent/auth.json`, `api_key` type).
   `/logout command-code` works natively. `COMMAND_CODE_API_KEY` env var is also honored.
   No fake OAuth, no private credential files, and the key is never logged.

3. **Usage** — `GET https://api.commandcode.ai/alpha/billing/credits` (undocumented alpha
   endpoint, community-verified shape from
   [CommandCode-Usagebar](https://github.com/berkeduruu/CommandCode-Usagebar)):
   - `/command-code.usage` prints 5-hour and weekly windows (credits used, cap, reset
     countdown) and remaining monthly credits.
   - While a Command Code model is selected, a below-editor widget shows the same data
     (refreshed around `agent_end`, min 3 min apart).
   - **No guessed numbers.** The server does not expose a monthly total pool, so nothing is
     hard-coded (the community extension's GOAT = 70 is deliberately not reproduced);
     remaining credits are shown without a percentage. Failed refreshes show an error and a
     stale-data marker instead of blocking Pi.

## Install / run

This directory is already in Pi's global discovery path (`~/.pi/agent/extensions/command-code/`),
so it loads on the next `pi` start (or `/reload` in an active session).

```
/login command-code   # paste the Command Code API key
/model                # pick e.g. GLM-5.3 Flash, MiMo V2.6 Flash or Claude
/command-code.usage   # plan usage
/command-code.models  # list models; `/command-code.models refresh` forces discovery
```

## Requirements / caveats (to verify with a real account)

- Command Code's **$1 Go plan does not support the Provider API**; GOAT and above do.
  Whether Free plans can list models/usage is unconfirmed.
- `/alpha/billing/credits` is an alpha endpoint and its response shape may drift; the
  parser is lenient (camel/snake, seconds vs ms timestamps) and fails loudly.
- Before the first `/login`, only the fallback quartet is registered (Pi skips catalog
  refresh for unconfigured providers); after login the full live list is published and
  persisted (checkedAt freshness window: 4 h, override with `COMMAND_CODE_CATALOG_REFRESH_MS`).

## Real-account validation checklist

Not yet performed (no API key in this environment). Once logged in:

1. `/command-code.usage` — confirm 5h/weekly/credits fields match the Command Code console.
2. Streaming text via a GLM-5.3 Flash or Claude model.
3. Tool calls (e.g. ask it to read a file) via both protocol families.
4. `/logout command-code` cleans the credential; `/login` re-prompts.

## Tests

```
npm test   # same as:
node scripts/run-ts.mjs tests/test-model-matching.ts   # matching, endpoint routing, fallback
node scripts/run-ts.mjs tests/test-usage.ts            # usage parsing/failure/format/stale
node scripts/run-ts.mjs tests/test-credentials.ts      # native api_key auth + provider wiring
```

Tests run with `node --experimental-strip-types`; the resolve hook (`scripts/register-hooks.mjs`)
maps `@earendil-works/pi-*` imports to the machine's Pi installation (`~/.pi/agent/install/releases/1.5.0`).
