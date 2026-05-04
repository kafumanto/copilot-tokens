# copilot-tokens

`copilot-tokens` analyzes GitHub Copilot Chat sessions saved by Visual Studio Code (VS Code). Track token usage and estimate session costs based on OpenRouter pricing data. Report detailed analytics including message counts, token consumption, and total expenses. Export results as JSON or CSV. Cross-platform utility to monitor Copilot usage and budget AI costs.

Source repository: [https://github.com/kafumanto/copilot-tokens](https://github.com/kafumanto/copilot-tokens)

It reads saved session files (VS Code ≥ 1.109 `chatSessions/` format and the legacy `GitHub.copilot-chat/transcripts/` format), counts user-side and assistant-side content with the `o200k_base` tokenizer from `@microsoft/tiktokenizer`, and prints either a text table, JSON, or CSV.

## Quick start with the container image

The primary way to run `copilot-tokens` is the container image built from [container/Containerfile](container/Containerfile). The image works the same way on Windows, macOS, and Linux: mount the VS Code `User` directory at `/data`, then pass any extra CLI flags after the image name.

Podman pulls the image automatically on first run.

The published image and repository live at [https://github.com/kafumanto/copilot-tokens](https://github.com/kafumanto/copilot-tokens).

If you prefer Docker at runtime, replace `podman` with `docker` in the commands below.

### Run on Windows with PowerShell

```powershell
podman run --rm `
  -v "${env:APPDATA}\Code\User:/data:ro" `
  -v "${env:TEMP}:/cache" `
  ghcr.io/kafumanto/copilot-tokens:latest `
  --costs
```

### Run on Windows with Command Prompt

```bat
podman run --rm ^
  -v "%APPDATA%\Code\User:/data:ro" ^
  -v "%TEMP%:/cache" ^
  ghcr.io/kafumanto/copilot-tokens:latest ^
  --costs
```

### Run on Linux with a local VS Code install

```bash
podman run --rm \
  -v "$HOME/.config/Code/User:/data:ro" \
  -v "${TMPDIR:-/tmp}:/cache" \
  ghcr.io/kafumanto/copilot-tokens:latest \
  --costs
```

### Run on Linux with a remote/server VS Code install

```bash
podman run --rm \
  -v "$HOME/.vscode-server/data/User:/data:ro" \
  -v "${TMPDIR:-/tmp}:/cache" \
  ghcr.io/kafumanto/copilot-tokens:latest \
  --costs
```

### Run on macOS

```bash
podman run --rm \
  -v "$HOME/Library/Application Support/Code/User:/data:ro" \
  -v "${TMPDIR:-/tmp}:/cache" \
  ghcr.io/kafumanto/copilot-tokens:latest \
  --costs
```

### Pass extra tool arguments

The container entrypoint forwards all arguments after the image name to the `copilot-tokens` CLI, so the normal CLI flags still work:

```bash
podman run --rm \
  -v "$HOME/.vscode-server/data/User:/data:ro" \
  -v "${TMPDIR:-/tmp}:/cache" \
  ghcr.io/kafumanto/copilot-tokens:latest \
  --filter 7 --models --costs
```

Mount the `User` directory that matches your VS Code installation. For example, VS Code Insiders uses a different path than stable Code, but the container-side mount target always stays `/data`.

When `--costs` is used, the container stores the cached OpenRouter pricing catalog under `/cache` by default. To preserve that cache across runs, mount a writable host directory there:

```bash
podman run --rm \
  -v "$HOME/.vscode-server/data/User:/data:ro" \
  -v "${TMPDIR:-/tmp}:/cache" \
  ghcr.io/kafumanto/copilot-tokens:latest \
  --costs
```

If you do not mount `/cache`, the pricing cache still works for the lifetime of a writable container filesystem, but it is discarded when the container is removed.

## What it reports

For each discovered chat session, the tool reports:

- session ID
- session name (title set by VS Code or derived from the first user message; omitted with `--anonymous`)
- session start time when available
- number of user messages
- number of assistant messages
- approximate input tokens
- approximate output tokens
- approximate total tokens

When `--costs` is specified, the tool also reports approximate input, output, and total USD costs derived from OpenRouter's public model pricing catalog.

It also prints a final total across all scanned sessions.

When `--models` is specified, the tool also reports per-model token splits using the persisted request model identifiers. Model names are shown as `modelProvider/modelName`, for example `copilot/claude-sonnet-4.6`.

## Important limitations

The counts are derived only from content persisted in local transcript files. They do **not** include hidden system prompts, server-side context assembly, or any Copilot-internal tokens that are not written to disk.

Per-model reporting is limited by the details VS Code actually persisted for each turn. When a request was sent with `copilot/auto`, the tool rewrites it to `copilot-auto/<effective-model>` only when the session data includes a persisted resolved model value; otherwise it remains `copilot/auto`. If the resolved model name ends with a release date suffix such as `-2026-03-05` or `-20251001`, that suffix is stripped so equivalent auto-routed turns group under the same model name.

Cost reporting is limited to sessions whose persisted model identifiers can be matched to OpenRouter model pricing. Matching ignores the provider prefix and compares only the model-name suffix after the first `/`, so `copilot/gpt-4o` matches OpenRouter IDs such as `openai/gpt-4o`. If multiple OpenRouter entries share the same suffix, that suffix is skipped and the tool prints a warning rather than guessing.

Cost reporting also does not account for server-side prompt caching. The persisted session data contains no indication that a provider served some input tokens from cache, so `--costs` prices all input tokens at the full rate. Actual billed costs may therefore be lower than reported when caching was active.

## Build the image yourself

The repository includes a Podman build workflow under [container/build.sh](container/build.sh).

### Build locally

From this directory run:

```bash
./container/build.sh
```

This creates the local tags `copilot-tokens:<version>` and `copilot-tokens:latest`.

The build also runs `npm run warmup-tokenizer`, which downloads the `o200k_base` tokenizer file into `node_modules/@microsoft/tiktokenizer/model/` in the builder stage so the final image does not need to fetch it again at runtime.

### Push to GitHub Container Registry

Create a credentials file outside the repository:

```text
GITHUB_USER=your-github-user
GITHUB_TOKEN=github_pat_your_token
```

Then push the version tag and `latest`:

```bash
./container/build.sh --creds /secure/path/copilot-tokens-ghcr.env --push
```

The build script reads the credentials file directly instead of taking secrets on the command line.

### About `--push-public`

```bash
./container/build.sh --creds /secure/path/copilot-tokens-ghcr.env --push-public
```

`--push-public` performs the push, then exits with the package settings URL because GitHub does not currently document a supported API to change GHCR package visibility from a script. The final visibility change still has to be done in the GitHub web UI.

## Native mode requirements

- Node.js
- A VS Code environment with GitHub Copilot Chat transcripts saved under workspace storage

By default, the native CLI auto-detects the first existing workspace storage directory from common VS Code locations for the current platform, prioritizing remote/server paths (Dev Container / remote VS Code server) before native local paths.

Typical candidates include:

```text
Linux/Dev Container/remote server:
  ~/.vscode-server/data/User/workspaceStorage
  ~/.vscode-remote/data/User/workspaceStorage
  ~/.vscode/data/User/workspaceStorage

Linux local:
  ~/.config/Code/User/workspaceStorage
  ~/.config/Code - Insiders/User/workspaceStorage

Windows local:
  %APPDATA%/Code/User/workspaceStorage
  %APPDATA%/Code - Insiders/User/workspaceStorage

macOS local:
  ~/Library/Application Support/Code/User/workspaceStorage
  ~/Library/Application Support/Code - Insiders/User/workspaceStorage
```

If no candidate exists, the tool fails with the checked list and you can pass `--workspace-storage` explicitly.

## Install natively

From this directory:

```bash
npm install
```

## Usage in native mode

Run the default text report:

```bash
node ./bin/copilot-tokens
```

Use the npm script:

```bash
npm run report
```

Print JSON instead of a table:

```bash
node ./bin/copilot-tokens --json
```

Print CSV instead of a table:

```bash
node ./bin/copilot-tokens --csv
```

Include per-model token breakdowns:

```bash
node ./bin/copilot-tokens --models
```

Include cost estimates using cached OpenRouter pricing:

```bash
node ./bin/copilot-tokens --costs
```

Set a custom pricing-cache directory instead of the default temp directory:

```bash
COPILOT_TOKENS_CACHE_DIR="$HOME/.cache/copilot-tokens" node ./bin/copilot-tokens --costs
```

Force-refresh OpenRouter pricing instead of using the local cache:

```bash
node ./bin/copilot-tokens --costs --refresh-costs
```

Print JSON with per-model details:

```bash
node ./bin/copilot-tokens --json --models
```

Print CSV with per-model rows:

```bash
node ./bin/copilot-tokens --csv --models
```

Show only today's sessions:

```bash
node ./bin/copilot-tokens --filter 0
```

Show sessions from the last 7 days:

```bash
node ./bin/copilot-tokens --filter 7
```

Show sessions from a single date:

```bash
node ./bin/copilot-tokens --filter 2026-04-21
```

Show sessions from a date up to today:

```bash
node ./bin/copilot-tokens --filter 2026-02-01+
```

Show sessions between two dates (inclusive):

```bash
node ./bin/copilot-tokens --filter 2026-01-01 2026-04-21
```

Scan a different workspace storage root:

```bash
node ./bin/copilot-tokens --workspace-storage /path/to/workspaceStorage
```

Override the globalStorage directory:

```bash
node ./bin/copilot-tokens --global-storage /path/to/globalStorage
```

Omit session titles (for anonymity):

```bash
node ./bin/copilot-tokens --anonymous
```

Show CLI help:

```bash
node ./bin/copilot-tokens --help
```

## Options

| Option | Description |
| --- | --- |
| `--workspace-storage <path>` | Override the workspace storage directory to scan |
| `--global-storage <path>` | Override the globalStorage directory (default: sibling of `--workspace-storage` named `globalStorage`) |
| `--filter <spec>` | Restrict output to sessions within a date range (see below) |
| `--json` | Print structured JSON output |
| `--csv` | Print CSV output |
| `--models` | Include per-model token breakdowns in supported outputs |
| `--costs` | Add input/output/total USD costs using OpenRouter pricing (cached for 24 hours in the OS temp directory) |
| `--refresh-costs` | Force-refresh OpenRouter pricing instead of using the local cache |
| `--anonymous` | Omit session titles from all output types (for anonymity) |
| `--help` | Show usage information |

`--refresh-costs` is only meaningful together with `--costs`.

### `--filter` syntax

All dates are interpreted as UTC calendar days. The argument is normalized internally to an inclusive `[from, to]` range before filtering.

| Form | Example | Meaning |
| --- | --- | --- |
| `N` (integer) | `--filter 7` | Sessions started within the last N calendar days (0 = today only) |
| `YYYY-MM-DD` | `--filter 2026-04-21` | Sessions started on that exact calendar day |
| `YYYY-MM-DD+` | `--filter 2026-02-01+` | Sessions started on or after that date, up to today |
| `FROM TO` | `--filter 2026-01-01 2026-04-21` | Sessions started between the two dates, inclusive |

Sessions with no recorded start time are excluded when a filter is active.

Filtering is applied before tokenization: files outside the date range are skipped entirely, making filtered runs significantly faster than unfiltered ones.

## How discovery works

The tool walks VS Code's chat storage in three passes and de-duplicates sessions by UUID (newer format wins):

1. **Legacy transcripts** (`VS Code < 1.109`): one `.jsonl` file per session under each workspace's `GitHub.copilot-chat/transcripts/` directory.
2. **New per-workspace sessions** (`VS Code ≥ 1.109`): `.json` or `.jsonl` files under each workspace's `chatSessions/` directory. The `.jsonl` variant (an append-only mutation log) takes priority over the `.json` variant (a flat snapshot) when both exist for the same session.
3. **Empty-window sessions** (`VS Code ≥ 1.109`): sessions started in untitled windows are stored under `globalStorage/emptyWindowChatSessions/` rather than any workspace directory. The `globalStorage/` directory is a sibling of `workspaceStorage/` under the same VS Code `User/` folder and is auto-detected from the selected `--workspace-storage`.

Sessions that have no user messages (created but never interacted with) are excluded from the output.

## How token counting works

The tool parses each session file and counts persisted content. What is counted depends on the format.

**Legacy format** (`GitHub.copilot-chat/transcripts/*.jsonl`):

- `user.message`: message text and serialized attachments
- `assistant.message`: response text, reasoning text, and serialized tool requests

**New format** (`chatSessions/*.json` and `chatSessions/*.jsonl`):

- User turn: message text and serialized context variable attachments
- Assistant turn: visible response text, extended reasoning/thinking blocks, and serialized tool call payloads

All pieces are joined and tokenized with the `o200k_base` encoder. This encoder is used by OpenAI's GPT-4o model family; it is also the best available approximation for Anthropic Claude sessions, since no public JavaScript implementation of Anthropic's tokenizer exists. Empty parts are ignored.

When `--costs` is used, the tool fetches `https://openrouter.ai/api/v1/models` and caches the response for 24 hours in the OS temp directory. Pricing values are converted internally to per-1,000-token rates before multiplication so the arithmetic works with larger values than raw per-token prices.

## Output examples

Text mode:

```text
Start time (UTC)      Session ID  Session Name          User msgs  Asst msgs  Input  Output  Total
--------------------  ----------  --------------------  ---------  ---------  -----  ------  -----
2026-04-20 09:15:00   abc123      My first session              4          5   1024    2048   3072
...
```

Text mode with `--models` adds indented per-model rows below sessions that used more than one model and a final model totals section.

JSON mode:

```json
{
  "root": "/path/to/workspaceStorage",
  "globalRoot": "/path/to/globalStorage",
  "sessionCount": 1,
  "methodology": "Counts are derived from persisted session content only; hidden Copilot-side system/context tokens are not included.",
  "sessions": [
    {
      "sessionId": "abc123",
      "title": "My first session",
      "models": [
        {
          "modelId": "copilot/claude-sonnet-4.6",
          "userMessages": 2,
          "assistantMessages": 2,
          "inputTokens": 512,
          "outputTokens": 1024,
          "totalTokens": 1536
        }
      ]
    }
  ],
  "totals": {},
  "modelTotals": []
}
```

The `models` and `modelTotals` properties are included only when `--models` is specified.

CSV mode:

```csv
Start Time,Session ID,Session Name,User Messages,Assistant Messages,Input Tokens,Output Tokens,Total Tokens
2026-04-20T09:15:00.000Z,abc123,My first session,4,5,1024,2048,3072
,TOTAL,,4,5,1024,2048,3072
```

CSV mode with `--models` adds a `Model` column and emits only per-model rows. Each row repeats the session identifiers and timestamps so it remains self-contained for spreadsheets and downstream processing:

```csv
Start Time,Session ID,Session Name,Model,User Messages,Assistant Messages,Input Tokens,Output Tokens,Total Tokens
2026-04-20T09:15:00.000Z,abc123,My first session,copilot/claude-sonnet-4.6,2,2,512,1024,1536
,TOTAL,,,4,5,1024,2048,3072
,MODEL TOTAL,,copilot/claude-sonnet-4.6,2,2,512,1024,1536
```

## Failure cases

The tool exits with an error when:

- the selected workspace storage directory does not exist
- no Copilot transcript files are found
- a transcript line contains invalid JSON

Parse errors include the file path and line number to make damaged transcripts easier to diagnose.
