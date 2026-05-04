#!/usr/bin/env node

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { createByEncoderName } = require("@microsoft/tiktokenizer");

const REMOTE_SERVER_DIRECTORIES = [".vscode-server", ".vscode-remote", ".vscode"];
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_FILENAME = "copilot-tokens-openrouter-models.json";
const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Session file formats produced by VS Code's chat persistence layer.
 *
 * VS Code < 1.109 wrote one event per line in a custom envelope format under
 * GitHub.copilot-chat/transcripts/ (the "legacy" format).
 *
 * VS Code >= 1.109 switched to a per-workspace chatSessions directory with two
 * variants:
 *   "new-json"   A flat ISerializableChatData3 JSON file – the early 1.109
 *                implementation, now rare; also produced when the setting
 *                "chat.useLogSessionStorage" is explicitly disabled.
 *   "new-jsonl"  An append-only mutation log, one JSON object per line – the
 *                default from VS Code 1.109 onward.
 *
 * Empty-window (untitled) sessions use the same "new-json" / "new-jsonl"
 * schemas but are stored under globalStorage rather than workspaceStorage.
 */
const FORMAT = {
  LEGACY: "legacy",
  NEW_JSON: "new-json",
  NEW_JSONL: "new-jsonl",
};

/**
 * Builds ordered workspaceStorage candidates for remote/server and native VS Code installs.
 * @returns {string[]}
 */
function getWorkspaceStorageCandidates() {
  const homeDirectory = os.homedir();
  const candidates = [];

  const addCandidate = (...segments) => {
    const candidate = path.join(...segments);
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  // Prefer server-style locations first so Dev Container / remote sessions pick
  // the same storage that Copilot uses on the attached host.
  for (const serverDirectory of REMOTE_SERVER_DIRECTORIES) {
    addCandidate(homeDirectory, serverDirectory, "data", "User", "workspaceStorage");
  }

  if (process.platform === "win32") {
    const appDataDirectory = process.env.APPDATA || path.join(homeDirectory, "AppData", "Roaming");
    addCandidate(appDataDirectory, "Code", "User", "workspaceStorage");
    addCandidate(appDataDirectory, "Code - Insiders", "User", "workspaceStorage");
  } else if (process.platform === "darwin") {
    addCandidate(homeDirectory, "Library", "Application Support", "Code", "User", "workspaceStorage");
    addCandidate(homeDirectory, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage");
  } else {
    addCandidate(homeDirectory, ".config", "Code", "User", "workspaceStorage");
    addCandidate(homeDirectory, ".config", "Code - Insiders", "User", "workspaceStorage");
    addCandidate(homeDirectory, ".config", "VSCodium", "User", "workspaceStorage");
  }

  return candidates;
}

/**
 * Chooses the first existing workspaceStorage directory from known platform locations.
 * @returns {{root: string, candidates: string[]}}
 */
function autodetectWorkspaceStorageRoot() {
  const candidates = getWorkspaceStorageCandidates();
  const root = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());

  return { root: root || "", candidates };
}

/**
 * Derives the globalStorage root path from a known workspaceStorage path.
 *
 * VS Code always co-locates workspaceStorage/ and globalStorage/ as siblings
 * under the same User/ directory.  This holds for every install variant:
 *
 *   Native Windows:     %APPDATA%\Code\User\
 *   Native macOS:       ~/Library/Application Support/Code/User/
 *   Native Linux:       ~/.config/Code/User/
 *   Remote / Dev Container server: ~/.vscode-server/data/User/
 *
 * path.dirname(workspaceStorageRoot) therefore always resolves to the correct
 * User/ parent, and joining "globalStorage" gives the sibling directory – no
 * platform-specific logic is required.
 *
 * @param {string} workspaceStorageRoot
 * @returns {string}
 */
function deriveGlobalStorageRoot(workspaceStorageRoot) {
  return path.join(path.dirname(workspaceStorageRoot), "globalStorage");
}

/**
 * Returns the cache file used for OpenRouter model pricing metadata.
 *
 * COPILOT_TOKENS_CACHE_DIR allows callers such as the container image to keep
 * the pricing cache on a persistent mount instead of an ephemeral temp dir.
 * When unset, os.tmpdir() keeps the cache out of the repository while still
 * persisting across repeated CLI invocations on the same machine.
 *
 * @returns {string}
 */
function getOpenRouterCachePath() {
  const configuredCacheDirectory = process.env.COPILOT_TOKENS_CACHE_DIR;
  const cacheDirectory = typeof configuredCacheDirectory === "string" && configuredCacheDirectory.trim()
    ? configuredCacheDirectory.trim()
    : os.tmpdir();

  return path.join(cacheDirectory, OPENROUTER_CACHE_FILENAME);
}

/**
 * Loads cached OpenRouter model metadata when still within the freshness TTL.
 *
 * @param {string} cachePath
 * @returns {object[] | null}
 */
function readOpenRouterModelsCache(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (!Number.isFinite(parsed.fetchedAt) || !Array.isArray(parsed.models)) {
      return null;
    }

    if ((Date.now() - parsed.fetchedAt) > OPENROUTER_CACHE_TTL_MS) {
      return null;
    }

    return parsed.models;
  } catch {
    return null;
  }
}

/**
 * Persists OpenRouter model metadata for reuse by later CLI invocations.
 *
 * Cache writes are best-effort only: pricing lookup should still succeed when
 * the temp directory is read-only or otherwise unavailable.
 *
 * @param {string} cachePath
 * @param {object[]} models
 */
function writeOpenRouterModelsCache(cachePath, models) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now(), models }, null, 2),
      "utf8"
    );
  } catch {
    // Ignore cache write failures.
  }
}

/**
 * Fetches the public OpenRouter models catalog used for pricing lookups.
 *
 * The API response is cached locally to avoid repeated remote requests on
 * successive CLI runs. `forceRefresh` bypasses that cache.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<object[]>}
 */
async function fetchOpenRouterModels(forceRefresh = false) {
  const cachePath = getOpenRouterCachePath();
  if (!forceRefresh) {
    const cachedModels = readOpenRouterModelsCache(cachePath);
    if (cachedModels) {
      return cachedModels;
    }
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      OPENROUTER_MODELS_URL,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "copilot-tokens",
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Failed to fetch OpenRouter models: HTTP ${response.statusCode}${responseText ? ` – ${responseText}` : ""}`
              )
            );
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(responseText);
          } catch (error) {
            reject(new Error(`Failed to parse OpenRouter models response: ${error.message}`));
            return;
          }

          if (!parsed || !Array.isArray(parsed.data)) {
            reject(new Error("Failed to fetch OpenRouter models: response did not contain a data array."));
            return;
          }

          writeOpenRouterModelsCache(cachePath, parsed.data);
          resolve(parsed.data);
        });
      }
    );

    request.on("error", (error) => {
      reject(new Error(`Failed to fetch OpenRouter models: ${error.message}`));
    });
  });
}

/**
 * Returns the substring after the first provider separator in a qualified ID.
 *
 * Examples:
 *   "copilot/gpt-4o" -> "gpt-4o"
 *   "openai/gpt-4o"  -> "gpt-4o"
 *
 * @param {unknown} qualifiedId
 * @returns {string}
 */
function extractModelNameSuffix(qualifiedId) {
  if (typeof qualifiedId !== "string") {
    return "";
  }

  const normalizedId = qualifiedId.trim();
  const slashIndex = normalizedId.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalizedId.length - 1) {
    return "";
  }

  return normalizedId.slice(slashIndex + 1);
}

/**
 * Extracts the model-name suffix from the Copilot reporting identifier.
 *
 * `copilot/auto` cannot be priced because it does not identify a concrete
 * backend model.
 *
 * @param {unknown} modelId
 * @returns {string}
 */
function extractCopilotModelName(modelId) {
  if (typeof modelId !== "string") {
    return "";
  }

  const normalizedId = modelId.trim();
  if (!normalizedId || normalizedId === "copilot/auto" || normalizedId === "(unknown)") {
    return "";
  }

  return extractModelNameSuffix(normalizedId);
}

/**
 * Builds a pricing lookup keyed by the provider-agnostic model suffix.
 *
 * OpenRouter model IDs are provider-qualified (e.g. `openai/gpt-4o`) while
 * Copilot reports models as `copilot/<modelName>` or `copilot-auto/<modelName>`.
 * Matching therefore uses only the portion after the first `/`.
 *
 * Prices are stored as costs per 1 000 tokens rather than per-token costs so
 * later arithmetic works with larger values and reduces floating-point noise.
 *
 * @param {object[]} models
 * @returns {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>}
 */
function buildPricingMap(models) {
  const pricingMap = new Map();
  const ambiguousModelNames = new Set();

  for (const model of models) {
    const openRouterId = typeof model?.id === "string" ? model.id.trim() : "";
    const modelName = extractModelNameSuffix(openRouterId);
    const promptCost = Number.parseFloat(model?.pricing?.prompt);
    const completionCost = Number.parseFloat(model?.pricing?.completion);

    if (!modelName || !Number.isFinite(promptCost) || !Number.isFinite(completionCost)) {
      continue;
    }

    if (ambiguousModelNames.has(modelName)) {
      continue;
    }

    if (pricingMap.has(modelName)) {
      const existing = pricingMap.get(modelName);
      console.warn(
        `WARNING: ambiguous pricing for "${modelName}": ${existing.openRouterId} vs ${openRouterId}; skipping this model name.`
      );
      pricingMap.delete(modelName);
      ambiguousModelNames.add(modelName);
      continue;
    }

    pricingMap.set(modelName, {
      promptPer1k: promptCost * 1000,
      completionPer1k: completionCost * 1000,
      openRouterId,
    });
  }

  return pricingMap;
}

/**
 * Returns cost fields for one model bucket using per-1 000-token pricing.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @param {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>} pricingMap
 * @returns {{ inputCost: number, outputCost: number, totalCost: number } | null}
 */
function computeModelCosts(inputTokens, outputTokens, modelId, pricingMap) {
  if (!pricingMap) {
    return null;
  }

  const modelName = extractCopilotModelName(modelId);
  if (!modelName) {
    return null;
  }

  const pricing = pricingMap.get(modelName);
  if (!pricing) {
    return null;
  }

  const inputCost = (inputTokens / 1000) * pricing.promptPer1k;
  const outputCost = (outputTokens / 1000) * pricing.completionPer1k;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Aggregates costs across a summary's per-model buckets.
 *
 * Session-level costs are derived from the already-computed `byModel` map so
 * token counting itself does not need to know anything about remote pricing.
 *
 * @param {object} summary
 * @param {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>} pricingMap
 * @returns {{ inputCost: number, outputCost: number, totalCost: number } | null}
 */
function computeSummaryCosts(summary, pricingMap) {
  if (!pricingMap) {
    return null;
  }

  let inputCost = 0;
  let outputCost = 0;
  let matchedModelCount = 0;

  for (const modelSummary of getSortedModelSummaries(summary.byModel || {})) {
    const modelCosts = computeModelCosts(
      modelSummary.inputTokens,
      modelSummary.outputTokens,
      modelSummary.modelId,
      pricingMap
    );

    if (!modelCosts) {
      continue;
    }

    matchedModelCount += 1;
    inputCost += modelCosts.inputCost;
    outputCost += modelCosts.outputCost;
  }

  if (matchedModelCount === 0) {
    return null;
  }

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Summarizes whether any reported model totals could be priced.
 *
 * This drives the user-facing warning/footer note for the case where none of
 * the models present in the report could be matched to OpenRouter pricing.
 *
 * @param {Array<{ modelId: string, inputTokens: number, outputTokens: number }>} modelTotals
 * @param {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>} pricingMap
 * @returns {{ totalModels: number, matchedModels: number, unmatchedModels: number, noModelsMatched: boolean }}
 */
function getPricingCoverage(modelTotals, pricingMap) {
  if (!pricingMap) {
    return {
      totalModels: 0,
      matchedModels: 0,
      unmatchedModels: 0,
      noModelsMatched: false,
    };
  }

  let matchedModels = 0;
  let unmatchedModels = 0;

  for (const modelSummary of modelTotals) {
    if (computeModelCosts(modelSummary.inputTokens, modelSummary.outputTokens, modelSummary.modelId, pricingMap)) {
      matchedModels += 1;
    } else {
      unmatchedModels += 1;
    }
  }

  return {
    totalModels: modelTotals.length,
    matchedModels,
    unmatchedModels,
    noModelsMatched: modelTotals.length > 0 && matchedModels === 0,
  };
}

/**
 * Formats a USD cost value for tables/CSV/JSON serialization helpers.
 *
 * @param {number | null | undefined} cost
 * @returns {string}
 */
function formatUsdCost(cost) {
  return cost == null ? "-" : `$${cost.toFixed(6)}`;
}

// Print a compact CLI reference so the script can be discovered without opening
// the source code or README.
function printHelp() {
  console.log(`Usage: copilot-tokens [--workspace-storage <path>] [--global-storage <path>] [--filter <spec>] [--json] [--csv] [--models] [--costs] [--refresh-costs] [--anonymous]

Report token counts for saved GitHub Copilot chat sessions.

Scans VS Code's chat storage locations:
  - <workspaceStorage>/<id>/chatSessions/        (VS Code >= 1.109, per-workspace)
  - <globalStorage>/emptyWindowChatSessions/     (VS Code >= 1.109, untitled windows)
  - <workspaceStorage>/<id>/GitHub.copilot-chat/transcripts/  (legacy, VS Code < 1.109)

Storage roots are auto-detected from known platform locations, including remote
VS Code server and Dev Container paths (~/.vscode-server/data/User/).

Options:
  --workspace-storage <path>  Override the auto-detected workspaceStorage directory
  --global-storage <path>     Override the globalStorage directory
                              (default: sibling of --workspace-storage named "globalStorage")
  --filter <spec>             Restrict output to sessions within a date range (UTC dates).
                              Accepted forms:
                                N             last N calendar days inclusive (0 = today only)
                                YYYY-MM-DD    single calendar day
                                YYYY-MM-DD+   from that date up to today
                                FROM TO       explicit range (two space-separated YYYY-MM-DD values)
  --json                      Print JSON instead of a text table
  --csv                       Print CSV instead of a text table
  --models                    Include per-model token breakdowns in supported outputs
  --costs                     Add input/output/total USD costs using OpenRouter pricing
                              (cached for 24 hours under ${getOpenRouterCachePath()})
  --refresh-costs             Force-refresh OpenRouter pricing instead of using cache
  --anonymous                 Omit session titles from all output types (JSON, CSV, text)
  --help                      Show this help text
`);
}

/**
 * Normalizes a --filter argument (one or two tokens) to an inclusive
 * [fromDate, toDate] range where both dates are "YYYY-MM-DD" strings in UTC.
 *
 * Accepted forms:
 *   "N"                      – last N calendar days inclusive (0 = today only)
 *   "YYYY-MM-DD"             – single calendar day
 *   "YYYY-MM-DD+"            – from that date up to today
 *   "YYYY-MM-DD" "YYYY-MM-DD" – explicit range (two separate tokens)
 *
 * @param {string[]} tokens  Remaining argv tokens immediately after --filter
 * @returns {{ fromDate: string, toDate: string, consumed: number }}
 */
function parseFilterSpec(tokens) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const dateOpenRe = /^\d{4}-\d{2}-\d{2}\+$/;
  const intRe = /^\d+$/;

  const todayUtc = new Date().toISOString().slice(0, 10);

  if (!tokens.length) {
    throw new Error("--filter requires an argument.");
  }

  const first = tokens[0];

  // Two-date explicit range: --filter 2026-01-01 2026-04-21
  if (dateRe.test(first) && tokens.length >= 2 && dateRe.test(tokens[1])) {
    return { fromDate: first, toDate: tokens[1], consumed: 2 };
  }

  // Single integer: last N calendar days (0 = today only)
  if (intRe.test(first)) {
    const n = parseInt(first, 10);
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - n);
    return { fromDate: from.toISOString().slice(0, 10), toDate: todayUtc, consumed: 1 };
  }

  // "YYYY-MM-DD+" – from that date up to today
  if (dateOpenRe.test(first)) {
    return { fromDate: first.slice(0, 10), toDate: todayUtc, consumed: 1 };
  }

  // Single date – same calendar day only
  if (dateRe.test(first)) {
    return { fromDate: first, toDate: first, consumed: 1 };
  }

  throw new Error(
    `Invalid --filter value: "${first}". Expected a number of days, YYYY-MM-DD, YYYY-MM-DD+, or two YYYY-MM-DD dates.`
  );
}

// Parse a very small option surface by hand to keep the tool dependency-free.
// The returned object becomes the single source of truth for runtime behavior.
function parseArgs(argv) {
  const detection = autodetectWorkspaceStorageRoot();
  const options = {
    root: detection.root,
    rootCandidates: detection.candidates,
    globalRoot: "",
    json: false,
    csv: false,
    models: false,
    costs: false,
    refreshCosts: false,
    anonymous: false,
    filterFrom: "",
    filterTo: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--csv") {
      options.csv = true;
      continue;
    }

    if (arg === "--models") {
      options.models = true;
      continue;
    }

    if (arg === "--costs") {
      options.costs = true;
      continue;
    }

    if (arg === "--refresh-costs") {
      options.refreshCosts = true;
      continue;
    }

    if (arg === "--anonymous") {
      options.anonymous = true;
      continue;
    }

    if (arg === "--filter") {
      const spec = parseFilterSpec(argv.slice(index + 1));
      options.filterFrom = spec.fromDate;
      options.filterTo = spec.toDate;
      index += spec.consumed;
      continue;
    }

    if (arg === "--workspace-storage") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --workspace-storage.");
      }

      options.root = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--global-storage") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --global-storage.");
      }

      // Accept an explicit override so users inside non-standard VS Code server
      // configurations can point directly at the right globalStorage folder.
      options.globalRoot = path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  // Derive globalRoot automatically when not overridden on the command line.
  // See deriveGlobalStorageRoot() for why path.dirname is sufficient on all
  // platforms and server configurations.
  if (!options.globalRoot && options.root) {
    options.globalRoot = deriveGlobalStorageRoot(options.root);
  }

  return options;
}

/**
 * @typedef {{ filePath: string, format: string, sessionId: string }} SessionFileEntry
 */

/**
 * Scans all known VS Code chat storage locations and returns a de-duplicated
 * list of session files, with newer storage formats taking priority over older
 * ones whenever the same session UUID appears in multiple locations.
 *
 * --- Why de-duplication is needed ---
 * VS Code 1.109 migrated existing sessions from the legacy transcript format to
 * the new chatSessions directory but left the original files in place.  The same
 * UUID therefore often exists in both locations.  Without de-duplication, a
 * migrated session would be counted twice.
 *
 * --- Scan priority (later writes to the Map override earlier ones) ---
 *   Pass 1 – legacy transcripts  (lowest priority)
 *   Pass 2 – new flat JSON files (intermediate priority)
 *   Pass 3 – new mutation-log JSONL files (highest priority; most complete data)
 *   Pass 4 – empty-window JSONL/JSON files from globalStorage (same tiers)
 *
 * @param {string} workspaceStorageRoot
 * @param {string} globalStorageRoot
 * @returns {SessionFileEntry[]}
 */
function getSessionFiles(workspaceStorageRoot, globalStorageRoot) {
  if (!fs.existsSync(workspaceStorageRoot)) {
    throw new Error(`workspaceStorage directory not found: ${workspaceStorageRoot}`);
  }

  // Map from session UUID to entry.  Writing in ascending priority order means
  // that higher-priority formats automatically overwrite lower-priority ones for
  // duplicate IDs.
  /** @type {Map<string, SessionFileEntry>} */
  const bySessionId = new Map();

  // Registers every file with the given extension from a directory.
  // Silently skips directories that do not exist.
  const addFilesFromDir = (dir, ext, format) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        const filePath = path.join(dir, entry.name);
        const sessionId = path.basename(entry.name, ext);
        bySessionId.set(sessionId, { filePath, format, sessionId });
      }
    }
  };

  const workspaceDirs = fs
    .readdirSync(workspaceStorageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  // Pass 1 – legacy transcript files (lowest priority).
  // Written by VS Code < 1.109 under GitHub.copilot-chat/transcripts/.
  for (const workspaceDir of workspaceDirs) {
    addFilesFromDir(
      path.join(workspaceStorageRoot, workspaceDir.name, "GitHub.copilot-chat", "transcripts"),
      ".jsonl",
      FORMAT.LEGACY
    );
  }

  // Pass 2 – new flat JSON snapshots (intermediate priority).
  // Written during early VS Code 1.109 builds or when
  // "chat.useLogSessionStorage" is disabled.
  for (const workspaceDir of workspaceDirs) {
    addFilesFromDir(
      path.join(workspaceStorageRoot, workspaceDir.name, "chatSessions"),
      ".json",
      FORMAT.NEW_JSON
    );
  }

  // Pass 3 – new append-log JSONL files (highest priority for workspace sessions).
  // The canonical format from VS Code 1.109 onward; always supersedes the flat
  // JSON snapshot when both exist for the same session ID.
  for (const workspaceDir of workspaceDirs) {
    addFilesFromDir(
      path.join(workspaceStorageRoot, workspaceDir.name, "chatSessions"),
      ".jsonl",
      FORMAT.NEW_JSONL
    );
  }

  // Pass 4 – empty-window (untitled) sessions stored under globalStorage.
  // VS Code routes these here rather than workspaceStorage because they are not
  // associated with any workspace folder.  JSON first so JSONL can override.
  if (globalStorageRoot) {
    const emptyWindowDir = path.join(globalStorageRoot, "emptyWindowChatSessions");
    addFilesFromDir(emptyWindowDir, ".json", FORMAT.NEW_JSON);
    addFilesFromDir(emptyWindowDir, ".jsonl", FORMAT.NEW_JSONL);
  }

  // Sort by file path for stable, reproducible output across runs.
  return [...bySessionId.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Reads the first 1 KB of a session file and extracts its start date cheaply,
 * without fully parsing the file or running the tokenizer.
 *
 * All three formats store the session timestamp near the very top of the file:
 *   NEW_JSON   – "creationDate": <unix-ms> within the root JSON object
 *   NEW_JSONL  – same field inside "v" on the first line (kind=0 baseline)
 *   LEGACY     – "startTime": "<ISO-8601>" inside the first session.start line
 *
 * A regex match is used instead of JSON.parse to stay resilient against
 * partial reads at the 1 KB boundary.
 *
 * @param {SessionFileEntry} entry
 * @returns {string} "YYYY-MM-DD" in UTC, or "" if not found
 */
function peekSessionDate(entry) {
  try {
    const fd = fs.openSync(entry.filePath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    const snippet = buf.slice(0, n).toString("utf8");

    if (entry.format === FORMAT.LEGACY) {
      // "startTime" is an ISO 8601 string; grab the date part directly.
      const match = snippet.match(/"startTime"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
      if (match) return match[1];
    } else {
      // NEW_JSON and NEW_JSONL both use a Unix millisecond timestamp.
      const match = snippet.match(/"creationDate"\s*:\s*(\d+)/);
      if (match) return new Date(parseInt(match[1], 10)).toISOString().slice(0, 10);
    }
  } catch {
    // Swallow errors — returning "" causes the entry to be treated as
    // undated and excluded when a date filter is active (same behaviour as
    // the post-summarize filter for sessions with no startTime).
  }
  return "";
}

/**
 * Normalizes a raw string to a single-line, sentence-trimmed title.
 *
 * Step 1 – first line only: everything after the first newline is discarded.
 *   Multi-line user messages used as fallback titles would otherwise produce
 *   broken CSV rows and unreadable table cells.
 *
 * Step 2 – truncate at the first sentence boundary: if the first line
 *   contains a '.' followed by whitespace, it is cut at the dot (inclusive).
 *   Example: "Update the README.md file. Then commit." → "Update the README.md file."
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeTitle(text) {
  // Discard everything after the first newline.
  const firstLine = text.split(/\r?\n/)[0];

  // Truncate at the first ". " boundary (dot followed by any whitespace),
  // keeping the dot so the result reads as a complete sentence.
  const match = firstLine.match(/\.\s/);
  return match ? firstLine.slice(0, match.index + 1) : firstLine;
}

/**
 * Truncates a text string to a short title suitable for display in the table.
 * Applies normalizeTitle first, then collapses whitespace and cuts at a word
 * boundary within maxLen characters, appending "\u2026" when truncated.
 *
 * Only used for the legacy format, which has no explicit title field.
 *
 * @param {string} text
 * @param {number} [maxLen=60]
 * @returns {string}
 */
function makeTitle(text, maxLen = 60) {
  // Normalize to a single-line, sentence-trimmed string first so the
  // length truncation below operates on already-clean input.
  const normalized = normalizeTitle(text);
  // Collapse any remaining whitespace runs within the line.
  const flat = normalized.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;

  // Prefer cutting at the last sentence boundary within the limit.
  const sentenceEnd = flat.lastIndexOf(".", maxLen - 1);
  if (sentenceEnd > maxLen / 2) return flat.slice(0, sentenceEnd + 1) + "...";

  // Fall back to the last word boundary.
  const wordEnd = flat.lastIndexOf(" ", maxLen - 1);
  const cutAt = wordEnd > maxLen / 2 ? wordEnd : maxLen;
  return flat.slice(0, cutAt) + "...";
}

// Tokenize the collected text fragments as one prompt/response payload. The
// newline join roughly mirrors how multi-part transcript data would be read by
// a human while keeping the counting logic simple and deterministic.
function tokenize(tokenizer, parts) {
  if (parts.length === 0) {
    return 0;
  }

  return tokenizer.encode(parts.join("\n")).length;
}

// Surface malformed transcript data with the exact file and line number so a
// broken session can be diagnosed quickly instead of failing ambiguously later.
function parseJsonLine(filePath, line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON in ${filePath} at line ${lineNumber}: ${error.message}`
    );
  }
}

/**
 * Creates an empty per-model accumulator.
 *
 * Model buckets mirror the top-level counters so formatting code can render
 * them with the same logic as session rows and totals.
 *
 * @param {string} modelId
 * @returns {{ modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }}
 */
function createEmptyModelSummary(modelId) {
  return {
    modelId,
    userMessages: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

/**
 * Normalizes a resolved backend model name before it is exposed in reports.
 *
 * Copilot sometimes persists resolved auto-model identifiers with a trailing
 * release date suffix such as `-2026-03-05` or `-20251001`. Those suffixes are
 * useful for telemetry but make report grouping noisy, so they are stripped
 * only from auto-resolved model names.
 *
 * @param {unknown} resolvedModel
 * @returns {string}
 */
function normalizeResolvedModelName(resolvedModel) {
  if (typeof resolvedModel !== "string" || !resolvedModel.trim()) {
    return "";
  }

  return resolvedModel.trim().replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/**
 * Resolves the reporting identifier for a request model.
 *
 * Normal requests keep their persisted `request.modelId` value.  Auto-routed
 * requests are rewritten to a more specific identifier when VS Code persisted
 * the actual backend model in `resolvedModel`.
 *
 * @param {unknown} modelId
 * @param {unknown} resolvedModel
 * @returns {string}
 */
function getEffectiveModelId(modelId, resolvedModel) {
  const normalizedModelId = typeof modelId === "string" && modelId.trim()
    ? modelId.trim()
    : "(unknown)";

  if (normalizedModelId !== "copilot/auto") {
    return normalizedModelId;
  }

  const normalizedResolvedModel = normalizeResolvedModelName(resolvedModel);
  if (normalizedResolvedModel) {
    return `copilot-auto/${normalizedResolvedModel}`;
  }

  return normalizedModelId;
}

/**
 * Searches a persisted result payload for the first usable resolved model ID.
 *
 * The append-only JSONL format does not keep a single stable shape for request
 * result patches. Depending on the event, `resolvedModel` may be written:
 *
 * - directly on the result object (`entry.v.resolvedModel`)
 * - under nested metadata objects (`entry.v.metadata.resolvedModel`)
 * - inside array-wrapped patch payloads (`entry.v[0].result.metadata.resolvedModel`)
 *
 * A small recursive walk keeps the replay logic tolerant of those storage
 * variants without hard-coding every currently observed path.
 *
 * @param {unknown} value
 * @returns {string}
 */
function findResolvedModel(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (typeof value.resolvedModel === "string" && value.resolvedModel.trim()) {
    return value.resolvedModel.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const resolvedModel = findResolvedModel(item);
      if (resolvedModel) {
        return resolvedModel;
      }
    }
    return "";
  }

  for (const nestedValue of Object.values(value)) {
    const resolvedModel = findResolvedModel(nestedValue);
    if (resolvedModel) {
      return resolvedModel;
    }
  }

  return "";
}

/**
 * Extracts the best available reporting identifier from a persisted request.
 *
 * Flat JSON snapshots may already contain `request.result.resolvedModel`, while
 * mutation-log sessions can learn that field later via a separate kind=1 patch.
 * This helper covers the snapshot case directly.
 *
 * @param {object} request
 * @returns {string}
 */
function getEffectiveRequestModelId(request) {
  return getEffectiveModelId(request?.modelId, findResolvedModel(request?.result));
}

/**
 * Returns per-model buckets sorted by descending token usage.
 *
 * A stable secondary sort on modelId keeps outputs deterministic when two
 * buckets have the same token count.
 *
 * @param {Record<string, { modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }>} byModel
 * @returns {Array<{ modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }>}
 */
function getSortedModelSummaries(byModel) {
  return Object.values(byModel || {}).sort((left, right) => {
    if (left.totalTokens !== right.totalTokens) {
      return right.totalTokens - left.totalTokens;
    }

    return left.modelId.localeCompare(right.modelId);
  });
}

/**
 * Adds nullable cost fields to a serialized output object.
 *
 * @param {object} serialized
 * @param {{ inputCost: number, outputCost: number, totalCost: number } | null} costs
 * @returns {object}
 */
function addSerializedCosts(serialized, costs) {
  serialized.inputCost = costs ? costs.inputCost : null;
  serialized.outputCost = costs ? costs.outputCost : null;
  serialized.totalCost = costs ? costs.totalCost : null;
  return serialized;
}

/**
 * Serializes one per-model bucket for JSON output.
 *
 * @param {{ modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }} modelSummary
 * @param {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>} pricingMap
 * @returns {object}
 */
function serializeModelSummary(modelSummary, pricingMap) {
  const serialized = {
    modelId: modelSummary.modelId,
    userMessages: modelSummary.userMessages,
    assistantMessages: modelSummary.assistantMessages,
    inputTokens: modelSummary.inputTokens,
    outputTokens: modelSummary.outputTokens,
    totalTokens: modelSummary.totalTokens,
  };

  if (pricingMap) {
    addSerializedCosts(
      serialized,
      computeModelCosts(
        modelSummary.inputTokens,
        modelSummary.outputTokens,
        modelSummary.modelId,
        pricingMap
      )
    );
  }

  return serialized;
}

/**
 * Removes internal-only fields from a session summary before JSON output.
 *
 * The in-memory summary carries `byModel` for formatting and aggregation, but
 * the public JSON shape should expose only the documented top-level counters,
 * plus a `models` array when the user explicitly requested per-model output.
 *
 * @param {object} summary
 * @param {boolean} includeModels
 * @param {Map<string, { promptPer1k: number, completionPer1k: number, openRouterId: string }>} [pricingMap]
 * @returns {object}
 */
function serializeSummary(summary, includeModels, pricingMap, anonymous = false) {
  const serialized = {
    sessionId: summary.sessionId,
    startTime: summary.startTime,
    userMessages: summary.userMessages,
    assistantMessages: summary.assistantMessages,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    totalTokens: summary.totalTokens,
  };

  if (!anonymous) {
    serialized.title = summary.title;
  }

  if (pricingMap) {
    addSerializedCosts(serialized, computeSummaryCosts(summary, pricingMap));
  }

  if (includeModels) {
    const models = getSortedModelSummaries(summary.byModel || {}).map((modelSummary) =>
      serializeModelSummary(modelSummary, pricingMap)
    );
    if (models.length > 0) {
      serialized.models = models;
    }
  }

  return serialized;
}

/**
 * Builds cross-session per-model totals from session-level `byModel` maps.
 *
 * This mirrors the TOTAL row for sessions, but keeps model totals separate so
 * JSON can expose them as a dedicated top-level array and the text/CSV formats
 * can render them after the session aggregate section.
 *
 * @param {object[]} summaries
 * @returns {Array<{ modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }>}
 */
function makeModelTotals(summaries) {
  /** @type {Record<string, { modelId: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }>} */
  const byModel = {};

  for (const summary of summaries) {
    for (const modelSummary of getSortedModelSummaries(summary.byModel || {})) {
      if (!byModel[modelSummary.modelId]) {
        byModel[modelSummary.modelId] = createEmptyModelSummary(modelSummary.modelId);
      }

      byModel[modelSummary.modelId].userMessages += modelSummary.userMessages;
      byModel[modelSummary.modelId].assistantMessages += modelSummary.assistantMessages;
      byModel[modelSummary.modelId].inputTokens += modelSummary.inputTokens;
      byModel[modelSummary.modelId].outputTokens += modelSummary.outputTokens;
      byModel[modelSummary.modelId].totalTokens += modelSummary.totalTokens;
    }
  }

  return getSortedModelSummaries(byModel);
}

/**
 * Accumulates token counts for one request+response pair from the new VS Code
 * chat storage format (ISerializableChatData3), used by both the flat JSON and
 * the mutation-log JSONL formats.
 *
 * User-side content:
 *   request.message.text           – the text the user typed
 *   request.variableData.variables – attached context variables (files, symbols,
 *     selections…), serialized to JSON so their tokens are approximated
 *
 * Assistant-side content is spread across typed response "parts":
 *   "thinking"                 – extended chain-of-thought reasoning (Claude
 *                                extended thinking, o1/o3 reasoning models).
 *                                Counted even if not visible to the user because
 *                                it genuinely consumes output tokens.
 *   "toolInvocationSerialized" – tool call + result payloads; can be very large
 *                                (file contents, directory listings…).
 *   IMarkdownString + others   – the visible response text.  IMarkdownString
 *                                objects have no "kind" field; text is in "value".
 *
 * The "extraResponseParts" parameter carries response chunks that arrived via
 * kind=2 mutation-log patches after the initial request object was written.
 * For flat JSON files this will always be an empty array.
 *
 * @param {object}   request           ISerializableChatRequestData from storage
 * @param {object[]} extraResponseParts Additional response parts from log patches
 * @param {object}   tokenizer
 * @param {string}   modelId           Effective reporting identifier for the request
 * @param {object}   summary           Mutated in-place
 */
function countNewFormatRequestTokens(request, extraResponseParts, tokenizer, modelId, summary) {
  // --- User side ---
  const userParts = [];

  const messageText = request.message?.text;
  if (typeof messageText === "string" && messageText.length > 0) {
    userParts.push(messageText);
  }

  const variables = request.variableData?.variables;
  if (Array.isArray(variables) && variables.length > 0) {
    // Context attachments are structured objects; JSON.stringify is an
    // approximation but preserves relative magnitude across sessions.
    userParts.push(JSON.stringify(variables));
  }

  const inputTokens = tokenize(tokenizer, userParts);

  // --- Assistant side ---
  const allResponseParts = [...(request.response || []), ...(extraResponseParts || [])];
  const assistantParts = [];

  for (const part of allResponseParts) {
    if (part === null || typeof part !== "object") continue;

    const kind = part.kind;

    if (kind === "thinking") {
      // Extended reasoning block (Claude extended thinking, o1/o3 chain-of-
      // thought).  Included because it directly uses output tokens.
      if (typeof part.value === "string" && part.value.length > 0) {
        assistantParts.push(part.value);
      }
    } else if (kind === "toolInvocationSerialized") {
      // Tool call + result payloads.  Serialized to JSON because individual
      // fields vary widely by tool type (file contents, search results, etc.).
      assistantParts.push(JSON.stringify(part));
    } else if (typeof part.value === "string" && part.value.length > 0) {
      // Covers the common IMarkdownString shape { value: "…", isTrusted?: … }
      // and any other part that exposes its text via a "value" string.
      assistantParts.push(part.value);
    } else if (typeof part.content === "string" && part.content.length > 0) {
      // Some part variants use "content" instead of "value".
      assistantParts.push(part.content);
    } else if (kind !== undefined) {
      // Unknown or infrastructure part (e.g. "mcpServersStarting") with no
      // obvious text field.  Serialize it for a rough estimate; "{}" is skipped.
      const serialized = JSON.stringify(part);
      if (serialized.length > 2) {
        assistantParts.push(serialized);
      }
    }
    // Parts with no "kind" and no text (e.g. { isTrusted: true }) are skipped.
  }

  const outputTokens = tokenize(tokenizer, assistantParts);

  summary.userMessages += 1;
  summary.assistantMessages += 1;
  summary.inputTokens += inputTokens;
  summary.outputTokens += outputTokens;

  if (!summary.byModel[modelId]) {
    summary.byModel[modelId] = createEmptyModelSummary(modelId);
  }

  summary.byModel[modelId].userMessages += 1;
  summary.byModel[modelId].assistantMessages += 1;
  summary.byModel[modelId].inputTokens += inputTokens;
  summary.byModel[modelId].outputTokens += outputTokens;
  summary.byModel[modelId].totalTokens += inputTokens + outputTokens;
}

/**
 * Summarizes a session stored as a flat ISerializableChatData3 JSON file
 * (chatSessions/*.json).
 *
 * VS Code 1.109 initially wrote the full ChatModel serialization as a single
 * JSON file per session.  This format was soon superseded by the append-only
 * JSONL mutation log (see summarizeNewLogSession) but may still be present in:
 *   - workspaces opened for the first time during early 1.109 builds, or
 *   - installations where "chat.useLogSessionStorage" is set to false.
 *
 * @param {string} filePath
 * @param {object} tokenizer
 * @returns {object} summary
 */
function summarizeNewFlatSession(filePath, tokenizer) {
  const sessionId = path.basename(filePath, ".json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse JSON in ${filePath}: ${error.message}`);
  }

  const summary = {
    sessionId: data.sessionId || sessionId,
    // creationDate is stored as a Unix millisecond timestamp.
    startTime: data.creationDate ? new Date(data.creationDate).toISOString() : "",
    // customTitle is set by VS Code when the user renames the chat or when the
    // model auto-generates a title after the first exchange.
    title: typeof data.customTitle === "string" && data.customTitle.trim() ? normalizeTitle(data.customTitle.trim()) : "",
    userMessages: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };

  for (const request of data.requests || []) {
    // Flat snapshots may already persist the resolved backend model on the
    // request result, so the effective reporting identifier can be derived
    // directly from the request object without extra replay state.
    countNewFormatRequestTokens(
      request,
      [],
      tokenizer,
      getEffectiveRequestModelId(request),
      summary
    );
  }

  // Fall back to the first user message text when VS Code has not yet stored a
  // customTitle (e.g. the session ended before title generation was triggered).
  // The full text is used rather than a derived short title because customTitle,
  // when present, is already a concise label; the fallback mirrors that intent.
  if (!summary.title) {
    const firstText = (data.requests?.[0]?.message?.text) || "";
    if (firstText) summary.title = normalizeTitle(firstText);
  }

  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  return summary;
}

/**
 * Summarizes a session stored in VS Code's append-only mutation-log format
 * (chatSessions/*.jsonl, the default since VS Code 1.109).
 *
 * --- Why an append-log? ---
 * Chat sessions grow incrementally: each turn, each streaming chunk, each tool
 * call appends new data.  Re-serializing the entire ChatModel on every change
 * would be slow for long sessions (potentially megabytes of JSON each time).
 * VS Code's ObjectMutationLog (chatSessionOperationLog.ts) records deltas
 * instead and replays them on load.
 *
 * --- The three line kinds ---
 *
 *   kind=0  Full ISerializableChatData3 snapshot in field "v".  Always the
 *           first line; provides the session baseline at creation time (usually
 *           requests:[], inputState with the selected model).
 *
 *   kind=1  Scalar patch: "k" is a key-path array, "v" is the new value.
 *           Used for inputState mutations (draft text, model selection,
 *           attachment list) and customTitle.  Most carry no conversation
 *           content; we only intercept customTitle and skip the rest.
 *
 *   kind=2  Array / object patch: "k" is a key-path, "v" is an array of
 *           items to insert, optional "i" is a sparse-array start offset.
 *           Two shapes carry conversation content:
 *             k=["requests"]                   → v[] are complete request objects
 *             k=["requests", N, "response"]    → v[] are response parts to
 *               append to request[N].response; "i" is the position in the final
 *               array (irrelevant for counting – we accumulate all parts)
 *
 * --- Why we don't implement the full reconciler ---
 * ObjectMutationLog supports arbitrary nested key-path mutations and sparse-
 * array merges.  Fully replicating it would require implementing patch
 * application, key-path traversal, and merge semantics – essentially porting
 * VS Code internals.  For token counting we only need completed request/
 * response pairs, which always arrive via the two kind=2 shapes above.  A
 * single forward pass recognising those two shapes – and ignoring everything
 * else – is sufficient and keeps this tool free from VS Code source dependency.
 *
 * @param {string} filePath
 * @param {object} tokenizer
 * @returns {object} summary
 */
function summarizeNewLogSession(filePath, tokenizer) {
  const sessionId = path.basename(filePath, ".jsonl");
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  const summary = {
    sessionId,
    startTime: "",
    title: "",
    userMessages: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };

  // Accumulates complete request objects, seeded from the kind=0 baseline and
  // extended by kind=2 ["requests"] patches.
  /** @type {object[]} */
  const requestList = [];

  // Streaming response chunks arrive as separate kind=2 patches after the
  // initial request object is written.  Accumulated here by request index,
  // merged in when counting.
  /** @type {Map<number, object[]>} */
  const extraResponseParts = new Map();

  // Tracks the reporting identifier for each request index.  Most requests can
  // be resolved immediately from request.modelId; auto-routed requests may be
  // rewritten later when the corresponding kind=1 result patch persists the
  // actual backend model in `resolvedModel`.
  /** @type {Map<number, string>} */
  const requestEffectiveModels = new Map();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const entry = parseJsonLine(filePath, lines[lineIndex], lineIndex + 1);

    if (entry.kind === 0) {
      // Baseline snapshot written when the session is first created.
      const base = entry.v || {};
      if (!summary.startTime && base.creationDate) {
        summary.startTime = new Date(base.creationDate).toISOString();
      }
      // Prefer the stored session ID over the filename in case they diverge
      // (e.g. after a manual file rename).
      if (base.sessionId) {
        summary.sessionId = base.sessionId;
      }
      // Normally empty at creation, but include any pre-populated requests.
      if (Array.isArray(base.requests)) {
        for (let requestIndex = 0; requestIndex < base.requests.length; requestIndex += 1) {
          requestEffectiveModels.set(
            requestList.length + requestIndex,
            getEffectiveRequestModelId(base.requests[requestIndex])
          );
        }
        requestList.push(...base.requests);
      }
      continue;
    }

    if (entry.kind === 1) {
      // Scalar patch: inputState.inputText, inputState.selectedModel,
      // customTitle, and request result objects.  We only care about customTitle
      // and the per-request result patch that can reveal `resolvedModel` for
      // auto-routed requests; everything else carries no conversation content.
      if (
        Array.isArray(entry.k) &&
        entry.k.length === 3 &&
        entry.k[0] === "requests" &&
        typeof entry.k[1] === "number" &&
        entry.k[2] === "result"
      ) {
        const requestIndex = entry.k[1];
        const currentModelId = requestEffectiveModels.get(requestIndex);
        if (currentModelId === "copilot/auto") {
          requestEffectiveModels.set(
            requestIndex,
            getEffectiveModelId(currentModelId, findResolvedModel(entry.v))
          );
        }
      }

      if (
        Array.isArray(entry.k) &&
        entry.k.length === 1 &&
        entry.k[0] === "customTitle" &&
        typeof entry.v === "string" &&
        entry.v.trim()
      ) {
        summary.title = normalizeTitle(entry.v.trim());
      }
      continue;
    }

    if (entry.kind === 2) {
      const k = entry.k;
      const v = entry.v;
      if (!Array.isArray(k) || !Array.isArray(v)) continue;

      if (k.length === 1 && k[0] === "requests") {
        // One or more complete request objects appended to the session.
        for (let requestIndex = 0; requestIndex < v.length; requestIndex += 1) {
          requestEffectiveModels.set(
            requestList.length + requestIndex,
            getEffectiveRequestModelId(v[requestIndex])
          );
        }
        requestList.push(...v);
      } else if (
        k.length === 3 &&
        k[0] === "requests" &&
        typeof k[1] === "number" &&
        k[2] === "response"
      ) {
        // Streaming response parts for the request at index k[1].
        // The "i" sparse-array offset is intentionally ignored: position in
        // the final array doesn't affect token counts.
        const requestIndex = k[1];
        if (!extraResponseParts.has(requestIndex)) {
          extraResponseParts.set(requestIndex, []);
        }
        extraResponseParts.get(requestIndex).push(...v);
      }
      // All other k shapes (inputState patches written as kind=2, etc.) do not
      // carry conversation content and are intentionally ignored.
    }
  }

  // Count tokens for each collected request, folding in any streamed response
  // parts that arrived via subsequent kind=2 patches.
  for (let i = 0; i < requestList.length; i += 1) {
    countNewFormatRequestTokens(
      requestList[i],
      extraResponseParts.get(i) || [],
      tokenizer,
      requestEffectiveModels.get(i) || getEffectiveRequestModelId(requestList[i]),
      summary
    );
  }

  // If VS Code never wrote a customTitle patch (session ended mid-turn, or
  // title generation was not triggered), fall back to the first user message
  // text verbatim.  makeTitle() is intentionally not called here: customTitle,
  // when present, is already a concise label and the fallback mirrors that.
  if (!summary.title) {
    const firstText = requestList[0]?.message?.text || "";
    if (firstText) summary.title = normalizeTitle(firstText);
  }

  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  return summary;
}

/**
 * Summarizes a session stored in the legacy GitHub Copilot transcript format
 * (GitHub.copilot-chat/transcripts/*.jsonl, used by VS Code < 1.109).
 *
 * Each line is a JSON event envelope with a "type" field:
 *   "session.start"     – metadata including the creation timestamp
 *   "user.message"      – user turn: data.content + data.attachments
 *   "assistant.message" – assistant turn: data.content + data.reasoningText
 *                         + data.toolRequests
 *
 * This format was written by the GitHub Copilot Chat extension directly and
 * predates VS Code's native ChatSessionStore (introduced in VS Code 1.109).
 * It is preserved here for backward compatibility with sessions created before
 * the storage migration.
 *
 * @param {string} filePath
 * @param {object} tokenizer
 * @returns {object} summary
 */
function summarizeLegacyTranscript(filePath, tokenizer) {
  const sessionId = path.basename(filePath, ".jsonl");
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  const summary = {
    sessionId,
    startTime: "",
    title: "",
    userMessages: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };

  for (let index = 0; index < lines.length; index += 1) {
    const event = parseJsonLine(filePath, lines[index], index + 1);
    const data = event.data || {};

    // session.start usually arrives once and gives the best sortable timestamp
    // for the whole conversation.
    if (event.type === "session.start" && !summary.startTime && data.startTime) {
      summary.startTime = data.startTime;
      continue;
    }

    if (event.type === "user.message") {
      const parts = [];

      // Plain message text is the largest contributor to user-side tokens.
      if (typeof data.content === "string" && data.content.length > 0) {
        parts.push(data.content);
        // Derive a title from the first user message; the legacy format has no
        // explicit title field.
        if (!summary.title) summary.title = makeTitle(data.content);
      }

      // Attachments influence the prompt too, so include their persisted JSON
      // representation when present.
      if (Array.isArray(data.attachments) && data.attachments.length > 0) {
        parts.push(JSON.stringify(data.attachments));
      }

      summary.userMessages += 1;
      summary.inputTokens += tokenize(tokenizer, parts);
      continue;
    }

    if (event.type === "assistant.message") {
      const parts = [];

      // Count visible assistant output.
      if (typeof data.content === "string" && data.content.length > 0) {
        parts.push(data.content);
      }

      // Some transcripts also persist separate reasoning text; when present we
      // count it because it was stored as part of the assistant event.
      if (typeof data.reasoningText === "string" && data.reasoningText.length > 0) {
        parts.push(data.reasoningText);
      }

      // Tool requests are serialized payloads that can materially affect token
      // usage, so they are counted as part of assistant-side output.
      if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) {
        parts.push(JSON.stringify(data.toolRequests));
      }

      summary.assistantMessages += 1;
      summary.outputTokens += tokenize(tokenizer, parts);
    }
  }

  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  return summary;
}

// Keep output stable and easy to read by sorting chronologically when possible,
// with a session ID fallback for older or partial transcripts.
function sortSummaries(summaries) {
  return [...summaries].sort((left, right) => {
    if (left.startTime && right.startTime && left.startTime !== right.startTime) {
      return left.startTime.localeCompare(right.startTime);
    }

    if (left.startTime && !right.startTime) {
      return -1;
    }

    if (!left.startTime && right.startTime) {
      return 1;
    }

    return left.sessionId.localeCompare(right.sessionId);
  });
}

// Build a final aggregate row so both text and JSON modes can expose an overall
// total without each caller having to reimplement the reduction logic.
function makeTotals(summaries) {
  return summaries.reduce(
    (totals, summary) => {
      totals.userMessages += summary.userMessages;
      totals.assistantMessages += summary.assistantMessages;
      totals.inputTokens += summary.inputTokens;
      totals.outputTokens += summary.outputTokens;
      totals.totalTokens += summary.totalTokens;

      for (const modelSummary of getSortedModelSummaries(summary.byModel || {})) {
        if (!totals.byModel[modelSummary.modelId]) {
          totals.byModel[modelSummary.modelId] = createEmptyModelSummary(modelSummary.modelId);
        }

        totals.byModel[modelSummary.modelId].userMessages += modelSummary.userMessages;
        totals.byModel[modelSummary.modelId].assistantMessages += modelSummary.assistantMessages;
        totals.byModel[modelSummary.modelId].inputTokens += modelSummary.inputTokens;
        totals.byModel[modelSummary.modelId].outputTokens += modelSummary.outputTokens;
        totals.byModel[modelSummary.modelId].totalTokens += modelSummary.totalTokens;
      }

      return totals;
    },
    {
      sessionId: "TOTAL",
      startTime: "",
      title: "",
      userMessages: 0,
      assistantMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      byModel: {},
    }
  );
}

// Format summaries as RFC 4180-compliant CSV.
// A field is quoted when it contains a comma, double-quote, or newline; any
// double-quote characters within the field value are escaped by doubling them.
function formatCsv(summaries, totals, options, modelTotals, pricingMap) {
  const csvField = (value) => {
    const str = String(value ?? "");
    // Quote if the value contains a comma, double-quote, newline, or
    // carriage return – all characters that would break unquoted CSV.
    if (/[,"\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = ["Start Time", "Session ID"];
  if (!options.anonymous) {
    headers.push("Session Name");
  }

  if (options.models) {
    headers.push("Model");
  }

  headers.push(
    "User Messages",
    "Assistant Messages",
    "Input Tokens",
    "Output Tokens",
    "Total Tokens"
  );

  if (options.costs) {
    headers.push("Input Cost ($)", "Output Cost ($)", "Total Cost ($)");
  }

  /**
   * Converts a summary-like object to a CSV row.
   *
   * @param {{ startTime: string, sessionId: string, title: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }} summary
   * @param {string} [modelId=""]
   * @param {{ inputCost: number, outputCost: number, totalCost: number } | null} [costs=null]
   * @returns {string[]}
   */
  const makeCsvRow = (summary, modelId = "", costs = null) => {
    const base = [
      csvField(summary.startTime || ""),
      csvField(summary.sessionId),
    ];

    if (!options.anonymous) {
      base.push(csvField(summary.title || ""));
    }

    if (options.models) {
      base.push(csvField(modelId));
    }

    base.push(
      csvField(summary.userMessages),
      csvField(summary.assistantMessages),
      csvField(summary.inputTokens),
      csvField(summary.outputTokens),
      csvField(summary.totalTokens)
    );

    if (options.costs) {
      base.push(
        csvField(costs ? costs.inputCost.toFixed(6) : ""),
        csvField(costs ? costs.outputCost.toFixed(6) : ""),
        csvField(costs ? costs.totalCost.toFixed(6) : "")
      );
    }

    return base;
  };

  const rows = [];

  for (const summary of summaries) {
    if (!options.models) {
      rows.push(makeCsvRow(summary, "", computeSummaryCosts(summary, pricingMap)));
      continue;
    }

    const models = getSortedModelSummaries(summary.byModel || {});
    for (const modelSummary of models) {
      const modelRow = {
        startTime: summary.startTime,
        sessionId: summary.sessionId,
        userMessages: modelSummary.userMessages,
        assistantMessages: modelSummary.assistantMessages,
        inputTokens: modelSummary.inputTokens,
        outputTokens: modelSummary.outputTokens,
        totalTokens: modelSummary.totalTokens,
      };
      if (!options.anonymous) {
        modelRow.title = summary.title;
      }
      rows.push(
        makeCsvRow(
          modelRow,
          modelSummary.modelId,
          computeModelCosts(
            modelSummary.inputTokens,
            modelSummary.outputTokens,
            modelSummary.modelId,
            pricingMap
          )
        )
      );
    }
  }

  rows.push(makeCsvRow(totals, options.models ? "" : undefined, computeSummaryCosts(totals, pricingMap)));

  if (options.models) {
    for (const modelSummary of modelTotals) {
      const modelTotalRow = {
        startTime: "",
        sessionId: "MODEL TOTAL",
        userMessages: modelSummary.userMessages,
        assistantMessages: modelSummary.assistantMessages,
        inputTokens: modelSummary.inputTokens,
        outputTokens: modelSummary.outputTokens,
        totalTokens: modelSummary.totalTokens,
      };
      if (!options.anonymous) {
        modelTotalRow.title = "";
      }
      rows.push(
        makeCsvRow(
          modelTotalRow,
          modelSummary.modelId,
          computeModelCosts(
            modelSummary.inputTokens,
            modelSummary.outputTokens,
            modelSummary.modelId,
            pricingMap
          )
        )
      );
    }
  }

  return [headers.map(csvField).join(","), ...rows.map((row) => row.join(","))].join("\n");
}

// Render a plain-text table with auto-sized columns so the default output stays
// shell-friendly and readable without needing an external table formatter.
function formatTable(summaries, totals, options, modelTotals, pricingMap) {
  // Cap the Session Name column width so long titles don't blow out the table.
  const TITLE_MAX_WIDTH = 50;

  // Thousands separator used for numeric columns in the text table.
  // Change this constant to switch globally (e.g. "," or "_").
  const THOUSANDS_SEP = " ";

  // Formats an integer with a thousands separator so large token counts are
  // easy to read at a glance (e.g. 1 234 567 instead of 1234567).
  const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEP);

  // Returns the display label for the Model column.
  // Shows the single model name when only one model was used, "*" when multiple models
  // contributed, and "" for rows where no model data is applicable.
  const sessionModelLabel = (byModel) => {
    const keys = Object.keys(byModel || {});
    if (keys.length === 1) return keys[0];
    return keys.length > 1 ? "*" : "";
  };

  /**
   * @param {{ startTime: string, sessionId: string, title: string, userMessages: number, assistantMessages: number, inputTokens: number, outputTokens: number, totalTokens: number }} summary
   * @param {{ inputCost: number, outputCost: number, totalCost: number } | null} [costs=null]
   * @param {string} [model=""] Single model name, "*" for multiple, or "" when not applicable.
   * @returns {string[]}
   */
  const makeTableRow = (summary, costs = null, model = "") => {
    const row = [
      summary.startTime ? summary.startTime.replace("T", " ").replace("Z", "") : "-",
      summary.sessionId || "",
    ];

    if (!options.anonymous) {
      row.push(summary.title ? summary.title.slice(0, TITLE_MAX_WIDTH) : "-");
    }

    row.push(
      model,
      fmtNum(summary.userMessages),
      fmtNum(summary.assistantMessages),
      fmtNum(summary.inputTokens),
      fmtNum(summary.outputTokens),
      fmtNum(summary.totalTokens),
    );

    if (options.costs) {
      row.push(
        formatUsdCost(costs?.inputCost),
        formatUsdCost(costs?.outputCost),
        formatUsdCost(costs?.totalCost)
      );
    }

    return row;
  };

  const headerCells = [
    "Start time (UTC)",
    "Session ID",
  ];
  if (!options.anonymous) {
    headerCells.push("Session Name");
  }
  headerCells.push(
    "Model",
    "User msgs",
    "Asst msgs",
    "Input",
    "Output",
    "Total",
  );

  if (options.costs) {
    headerCells.push("Input $", "Output $", "Total $");
  }

  /** @type {Array<{ type: string, cells?: string[] }>} */
  const rowEntries = [
    {
      type: "header",
      cells: headerCells,
    },
  ];

  for (const summary of summaries) {
    rowEntries.push({
      type: "session",
      cells: makeTableRow(summary, computeSummaryCosts(summary, pricingMap), sessionModelLabel(summary.byModel)),
    });

    if (!options.models) {
      continue;
    }

    const models = getSortedModelSummaries(summary.byModel || {});
    if (models.length < 2) {
      continue;
    }

    for (const modelSummary of models) {
      const modelRow = {
        startTime: "",
        sessionId: "",
        userMessages: modelSummary.userMessages,
        assistantMessages: modelSummary.assistantMessages,
        inputTokens: modelSummary.inputTokens,
        outputTokens: modelSummary.outputTokens,
        totalTokens: modelSummary.totalTokens,
      };
      if (!options.anonymous) {
        modelRow.title = `  - ${modelSummary.modelId}`;
      }
      rowEntries.push({
        type: "session-model",
        cells: makeTableRow(modelRow, computeModelCosts(
          modelSummary.inputTokens,
          modelSummary.outputTokens,
          modelSummary.modelId,
          pricingMap
        )),
      });
    }
  }

  rowEntries.push({
    type: "total",
    cells: makeTableRow(totals, computeSummaryCosts(totals, pricingMap), sessionModelLabel(totals.byModel)),
  });

  if (options.models && modelTotals.length > 0) {
    rowEntries.push({ type: "divider" });
    for (const modelSummary of modelTotals) {
      const modelTotalRow = {
        startTime: "",
        sessionId: "MODEL TOTAL",
        userMessages: modelSummary.userMessages,
        assistantMessages: modelSummary.assistantMessages,
        inputTokens: modelSummary.inputTokens,
        outputTokens: modelSummary.outputTokens,
        totalTokens: modelSummary.totalTokens,
      };
      if (!options.anonymous) {
        modelTotalRow.title = modelSummary.modelId;
      }
      rowEntries.push({
        type: "model-total",
        cells: makeTableRow(modelTotalRow, computeModelCosts(
          modelSummary.inputTokens,
          modelSummary.outputTokens,
          modelSummary.modelId,
          pricingMap
        )),
      });
    }
  }

  const rows = rowEntries.filter((entry) => Array.isArray(entry.cells)).map((entry) => entry.cells);
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );

  return rowEntries
    .map((entry, rowIndex) => {
      if (entry.type === "divider") {
        return widths.map((width) => "-".repeat(width)).join("  ");
      }

      const row = entry.cells;
      const formatted = row.map((cell, columnIndex) => {
        // Columns 0–3 are text (Start time, Session ID, Session Name, Model); the rest are numeric.
        const isNumeric = columnIndex >= 4;
        return isNumeric ? cell.padStart(widths[columnIndex]) : cell.padEnd(widths[columnIndex]);
      });

      const line = formatted.join("  ");
      if (rowIndex === 0) {
        const divider = widths.map((width) => "-".repeat(width)).join("  ");
        return `${line}\n${divider}`;
      }

      return line;
    })
    .join("\n");
}

// Main CLI flow:
// 1. read options and derive storage roots,
// 2. discover all session files across formats and storage locations,
// 3. summarize each session with the shared tokenizer,
// 4. filter out empty sessions (no user messages),
// 5. print either machine-readable JSON or a human-readable table.
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.root) {
    throw new Error(
      `Could not auto-detect a VS Code workspaceStorage directory. Checked:\n${options.rootCandidates
        .map((candidate) => `- ${candidate}`)
        .join("\n")}\nUse --workspace-storage <path> to specify it explicitly.`
    );
  }

  const sessionFiles = getSessionFiles(options.root, options.globalRoot);
  if (sessionFiles.length === 0) {
    throw new Error(`No Copilot session files found under ${options.root}`);
  }

  // o200k_base is the tokenizer used by OpenAI's GPT-4o model family (including
  // GPT-4.1, o1, o3, and GPT-5.x).  Copilot also routes to Anthropic Claude
  // models, which use a proprietary tokenizer with no public JS implementation.
  // o200k_base is therefore the best available approximation across all models
  // that Copilot may use.  The resulting counts are already approximate (hidden
  // system prompts are excluded), so the small per-token discrepancy on Claude
  // sessions is acceptable.
  const tokenizer = await createByEncoderName("o200k_base");

  const summarize = (entry) => {
    if (entry.format === FORMAT.NEW_JSON) return summarizeNewFlatSession(entry.filePath, tokenizer);
    if (entry.format === FORMAT.NEW_JSONL) return summarizeNewLogSession(entry.filePath, tokenizer);
    return summarizeLegacyTranscript(entry.filePath, tokenizer);
  };

  // When --filter is active, peek at each file's date cheaply (first 1 KB
  // only) and skip files that fall outside the requested range.  This avoids
  // running the tokenizer on sessions that will be thrown away anyway, which
  // makes filtered invocations significantly faster.
  const filesToProcess = (options.filterFrom || options.filterTo)
    ? sessionFiles.filter((entry) => {
        const date = peekSessionDate(entry);
        if (!date) return false;
        return (!options.filterFrom || date >= options.filterFrom) &&
               (!options.filterTo || date <= options.filterTo);
      })
    : sessionFiles;

  // Filter out sessions that have no user messages.  These are sessions that
  // were created but never interacted with (draft inputState only); they
  // produce all-zero rows that add noise without contributing countable tokens.
  const summaries = sortSummaries(
    filesToProcess.map(summarize).filter((s) => s.userMessages > 0)
  );

  if (summaries.length === 0) {
    throw new Error(`No Copilot sessions with messages found under ${options.root}`);
  }

  const totals = makeTotals(summaries);
  const modelTotals = makeModelTotals(summaries);
  const pricingMap = options.costs
    ? buildPricingMap(await fetchOpenRouterModels(options.refreshCosts))
    : null;
  const pricingCoverage = options.costs ? getPricingCoverage(modelTotals, pricingMap) : null;

  if (pricingCoverage?.noModelsMatched) {
    console.warn("WARNING: none of the reported models matched OpenRouter pricing. Cost columns will be empty.");
  }

  if (options.csv) {
    console.log(formatCsv(summaries, totals, options, modelTotals, pricingMap));
    return;
  }

  if (options.json) {
    const jsonOutput = {
      root: options.root,
      globalRoot: options.globalRoot,
      sessionCount: summaries.length,
      methodology:
        "Counts are derived from persisted session content only; hidden Copilot-side system/context tokens are not included.",
      sessions: summaries.map((summary) => serializeSummary(summary, options.models, pricingMap, options.anonymous)),
      totals: serializeSummary(totals, false, pricingMap, options.anonymous),
    };

    if (options.models) {
      jsonOutput.modelTotals = modelTotals.map((modelSummary) =>
        serializeModelSummary(modelSummary, pricingMap)
      );
    }

    if (pricingCoverage?.noModelsMatched) {
      jsonOutput.costsWarning =
        "No reported models matched OpenRouter pricing, so cost fields are null.";
    }

    console.log(
      JSON.stringify(jsonOutput, null, 2)
    );
    return;
  }

  console.log(formatTable(summaries, totals, options, modelTotals, pricingMap));
  console.log("");
  console.log(`Sessions: ${summaries.length}`);
  console.log(`Scanned roots: ${options.root}`);
  if (options.globalRoot) {
    console.log(`               ${options.globalRoot}`);
  }
  console.log(
    "Note: counts are derived from persisted session content only; hidden Copilot-side system/context tokens are not included."
  );
  if (pricingCoverage?.noModelsMatched) {
    console.log(
      "Note: cost estimates are unavailable because no reported models matched OpenRouter pricing."
    );
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
