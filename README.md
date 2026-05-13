# pi extensions

A small collection of extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Included extensions

| File | What it does | How to use | Requirements |
|---|---|---|---|
| `auth-backup.ts` | Manages backups of `~/.pi/agent/auth.json` through a single interactive command | Run `/auth-backup` | Interactive UI |
| `branch-pr-widget.ts` | Shows the GitHub PR for the current branch | Auto-runs on session start and after agent turns | `gh` installed, current repo branch associated with a PR |
| `docs-changes.ts` | Shows changed files under `docs/` as a widget | Auto-runs on session start and after agent turns | Git repo with a `docs/` directory |
| `replace-pi-with-claude-code.ts` | Rewrites `pi` to `claude code` in the system prompt | Auto-runs before each agent start | None |
| `read-url.ts` | Adds a `read_url` tool that reads public URLs as Markdown through Jina Reader | Agent calls `read_url` when it needs external docs | Optional `JINA_API_KEY` for authenticated Jina quota |
| `usage-widget.ts` | Shows Anthropic or Codex usage bars for the active provider | Auto-runs on session start, model change, and after agent turns | Valid Anthropic OAuth or OpenAI Codex auth |

## Installation

Copy any extension file into your pi extensions directory:

```bash
cp auth-backup.ts ~/.pi/agent/extensions/
cp branch-pr-widget.ts ~/.pi/agent/extensions/
cp docs-changes.ts ~/.pi/agent/extensions/
cp replace-pi-with-claude-code.ts ~/.pi/agent/extensions/
cp read-url.ts ~/.pi/agent/extensions/
cp usage-widget.ts ~/.pi/agent/extensions/
```

Then reload pi:

```text
/reload
```

You can also load a file directly for testing:

```bash
pi -e ./auth-backup.ts
```

## Extensions

### `auth-backup.ts`

Interactive auth backup manager for `~/.pi/agent/auth.json`.

Behavior:

- Stores backups under `~/.pi/agent/auth-backups/`
- Uses one command: `/auth-backup`
- Shows an interactive list with:
  - `+ New auth backup`
  - existing backups with creation time and provider summary
- For an existing backup, opens an action menu:
  - `Backup current auth here`
  - `Restore this backup`
  - `Delete this backup`

Restore overwrites the full `~/.pi/agent/auth.json` and reloads pi.

Use it when:

- you switch between multiple auth setups
- you want to save the current login state before replacing it
- you want to restore a previous full auth state quickly

#### Screenshots

Backup list:

![auth-backup list screenshot](assets/auth-backup-list.png)

Action menu:

![auth-backup actions screenshot](assets/auth-backup-actions.png)

### `branch-pr-widget.ts`

Shows the GitHub PR number and URL for the current branch.

Behavior:

- Runs `gh pr view --json number,url`
- Displays a widget when a PR is found
- Refreshes on:
  - `session_start`
  - `session_switch`
  - `agent_end`

Use it when:

- you work in a GitHub repo with branch-to-PR mapping
- you want the active PR visible in the UI

### `docs-changes.ts`

Shows changed files in `docs/` as a widget.

Behavior:

- Reads tracked changes from `git diff --name-status HEAD -- docs/`
- Reads untracked files from `git ls-files --others --exclude-standard -- docs/`
- Ignores `docs/index.md` and nested `index.md`
- Refreshes on:
  - `session_start`
  - `session_switch`
  - `agent_end`

Use it when:

- you are editing documentation alongside code
- you want a compact docs change summary visible at all times

### `replace-pi-with-claude-code.ts`

Rewrites occurrences of `pi` in the system prompt to `claude code` before each run.

Behavior:

- Hooks `before_agent_start`
- Replaces ` pi` case-insensitively with ` claude code`
- Only changes the system prompt when a replacement is needed

Use it when:

- you want the agent framed as Claude Code instead of pi

### `read-url.ts`

Adds a `read_url` tool for reading public HTTPS URLs as LLM-friendly Markdown using [Jina Reader](https://jina.ai/reader/).

Behavior:

- Registers a `read_url` tool callable by the agent
- Uses anonymous Jina Reader requests first
- Falls back to `JINA_API_KEY` when anonymous quota is exhausted and the environment variable is set
- Caches successful fetches for 30 days under `~/.pi/agent/caches/read-url/`
- Stores each cached document as:
  - `content.md`
  - `meta.json`
- Uses readable cache directory names, with a short URL hash suffix to avoid collisions
- Canonicalizes document URLs by default:
  - removes fragments
  - strips query parameters
  - removes non-root trailing slashes
- Supports line-based pagination with `offset` and `limit`
- Provides compact TUI rendering, with expandable results
- Returns actionable error messages for Jina rate limits, missing API keys, invalid API keys, insufficient balance, and stale-cache fallback

Tool parameters:

| Parameter | Default | Description |
|---|---:|---|
| `url` | required | HTTPS URL to read. Non-HTTPS URLs are refused |
| `offset` | `1` | 1-based line offset for pagination |
| `limit` | `300` | Number of lines to return, max `1000` |
| `refresh` | `false` | Force re-fetch and overwrite cache. Do not use by default |
| `preserveQuery` | `false` | Preserve query parameters when they are required for page content |

Cache example:

```text
~/.pi/agent/caches/read-url/
  openai.com--index-introducing-trusted-contact-in-chatgpt--178cf0649d10/
    content.md
    meta.json
```

Optional authenticated quota:

```bash
export JINA_API_KEY="..."
```

Use it when:

- you want the agent to inspect public documentation, blog posts, changelogs, or API references
- you want cached URL reading with pagination instead of manually pasting Markdown into the prompt
- you want anonymous Jina usage by default, with API-key fallback only when needed

**Security note**:

`read_url` puts external webpage content into the agent context. Treat every fetched page as untrusted input. Do not read random links, suspicious pages, or user-generated content you do not trust. A page can contain prompt injection text that tells the agent to ignore previous instructions, reveal secrets, call tools, run commands, or follow links.

The extension reduces this risk in a few ways:

- Tool output labels fetched content as untrusted external content
- Fetched content is wrapped inside a `<document>` boundary
- The tool guidelines tell the agent not to follow instructions inside fetched pages
- The tool does not use browser cookies or your logged-in Chrome session
- The tool refuses non-HTTPS URLs, so fetched content is not retrieved over unauthenticated HTTP transport

These are prompt-level mitigations, not a security boundary. They do not guarantee that the agent will never be influenced by malicious content. Only read URLs from sources you trust, such as official documentation, vendor docs, repository docs, and known technical blogs.

Limitations:

- Does not use browser cookies or your logged-in Chrome session
- Does not read non-HTTPS URLs
- Does not read private documents unless Jina Reader can access them publicly
- Query parameters are stripped by default; pass `preserveQuery: true` for search, pagination, filters, or pages where query parameters define the content
- Prompt injection remains possible if the fetched page contains malicious instructions

### `usage-widget.ts`

Shows usage information for the active provider when supported.

Supported providers:

- `anthropic`
- `openai-codex`

Behavior:

- Displays usage bars for primary and secondary windows
- Shows reset times
- Computes a 7-day pace delta for Anthropic-style usage windows
- Caches usage briefly to avoid excessive requests
- Refreshes on:
  - `session_start`
  - `model_select`
  - `agent_end`

Data sources:

- Anthropic: `https://api.anthropic.com/api/oauth/usage`
- Codex: `https://chatgpt.com/backend-api/wham/usage`

Use it when:

- you want quota visibility while working
- you switch between Anthropic and Codex models

#### Screenshot

![usage-widget screenshot](assets/screenshot.png)

## Notes

| Extension | Notes |
|---|---|
| `auth-backup.ts` | Requires interactive UI. Restore replaces the full auth file, not a single provider entry. |
| `branch-pr-widget.ts` | Hidden when no PR is associated with the current branch or `gh` is unavailable. |
| `docs-changes.ts` | Hidden when there is no `docs/` directory or no matching changes. |
| `replace-pi-with-claude-code.ts` | Only affects prompt text, not UI labels or command names. |
| `read-url.ts` | Reads public URLs through Jina Reader. Set `JINA_API_KEY` only if you want authenticated fallback after anonymous quota is exhausted. |
| `usage-widget.ts` | Hidden when the active provider is unsupported or no usage data is available. |

## License

MIT License
