import express from "express";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const require = createRequire(import.meta.url);
const swaggerUiAssetDir = path.dirname(require.resolve("swagger-ui-dist/package.json"));
// The generated Playwright config is written into RUNS_DIR, which may sit
// outside the project (it is configurable). A bare "@playwright/test" there
// resolves from the config's own directory upward and fails. Anchoring a
// createRequire to this installation resolves it from the server's tree
// instead, and works whichever entry point the installed version exposes.
const serverModuleAnchorUrl = pathToFileURL(path.join(rootDir, "package.json")).href;
// The version used to be a literal here, which meant every release had to
// remember to edit two files. v0.13.0 shipped as "0.12.0" in /health until the
// release checklist caught it; reading package.json removes the chance to drift.
function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  } catch {
    // Reporting a stale number would be worse than admitting we do not know.
    return "unknown";
  }
}

const documentationPaths = {
  openApi: "/openapi.json",
  docs: "/docs",
  playground: "/playground",
  runs: "/runs",
  swaggerAssets: "/swagger-ui",
};

const config = {
  serviceName: process.env.SERVICE_NAME || "playwright-player",
  serviceVersion: process.env.SERVICE_VERSION || readPackageVersion(),
  host: process.env.HOST || "0.0.0.0",
  port: parseInteger(process.env.PORT, 3000),
  apiBasePath: process.env.API_BASE_PATH || "/api",
  mcpBasePath: process.env.MCP_BASE_PATH || "/mcp",
  scriptsDir: path.resolve(process.env.SCRIPTS_DIR || path.join(rootDir, "scripts")),
  runsDir: path.resolve(process.env.RUNS_DIR || path.join(rootDir, "data", "runs")),
  artifactsDir: path.resolve(process.env.ARTIFACTS_DIR || path.join(rootDir, "data", "artifacts")),
  storageStateDir: path.resolve(process.env.STORAGE_STATE_DIR || path.join(rootDir, "storage-states")),
  routeFixturesDir: path.resolve(process.env.ROUTE_FIXTURES_DIR || process.env.SCRIPTS_DIR || path.join(rootDir, "scripts")),
  environmentsDir: path.resolve(process.env.ENVIRONMENTS_DIR || path.join(rootDir, "data", "environments")),
  datasetsDir: path.resolve(process.env.DATASETS_DIR || path.join(rootDir, "data", "datasets")),
  schedulesDir: path.resolve(process.env.SCHEDULES_DIR || path.join(rootDir, "data", "schedules")),
  secretsDir: path.resolve(process.env.SECRETS_DIR || path.join(rootDir, "secrets")),
  bodyLimit: process.env.BODY_LIMIT || "5mb",
  defaultBrowserType: process.env.DEFAULT_BROWSER_TYPE || "chromium",
  defaultHeadless: parseBoolean(process.env.DEFAULT_HEADLESS, true),
  sessionTtlMs: parseInteger(process.env.SESSION_TTL_MS, 30 * 60 * 1000),
  cleanupIntervalMs: parseInteger(process.env.SESSION_CLEANUP_INTERVAL_MS, 30 * 1000),
  maxSessions: parseInteger(process.env.MAX_SESSIONS, 10),
  maxContextsPerSession: parseInteger(process.env.MAX_CONTEXTS_PER_SESSION, 5),
  maxPagesPerSession: parseInteger(process.env.MAX_PAGES_PER_SESSION, 10),
  maxConcurrentRuns: parseInteger(process.env.MAX_CONCURRENT_RUNS, 4),
  maxQueuedRuns: parseInteger(process.env.MAX_QUEUED_RUNS, 100),
  runTimeoutMs: parseInteger(process.env.RUN_TIMEOUT_MS, 30 * 60 * 1000),
  maxBlockedRequestLogEntries: parseInteger(process.env.MAX_BLOCKED_REQUEST_LOG_ENTRIES, 100),
  maxRetainedRuns: parseInteger(process.env.MAX_RETAINED_RUNS, 50),
  requeueInterruptedRuns: parseBoolean(process.env.REQUEUE_INTERRUPTED_RUNS, false),
  mcpSessionTtlMs: parseInteger(process.env.MCP_SESSION_TTL_MS, 60 * 60 * 1000),
  maxActionLogEntries: parseInteger(process.env.MAX_ACTION_LOG_ENTRIES, 500),
  maxWorkflowIterations: parseInteger(process.env.MAX_WORKFLOW_ITERATIONS, 200),
  maxWorkflowSteps: parseInteger(process.env.MAX_WORKFLOW_STEPS, 500),
  maxWorkflowDurationMs: parseInteger(process.env.MAX_WORKFLOW_DURATION_MS, 5 * 60 * 1000),
  approvalTimeoutMs: parseInteger(process.env.APPROVAL_TIMEOUT_MS, 60 * 60 * 1000),
  maxPendingApprovals: parseInteger(process.env.MAX_PENDING_APPROVALS, 50),
  maxScriptBundleFiles: parseInteger(process.env.MAX_SCRIPT_BUNDLE_FILES, 50),
  maxScriptBundleBytes: parseInteger(process.env.MAX_SCRIPT_BUNDLE_BYTES, 8 * 1024 * 1024),
  maxEventLogEntries: parseInteger(process.env.MAX_EVENT_LOG_ENTRIES, 1500),
  maxRunLogEntries: parseInteger(process.env.MAX_RUN_LOG_ENTRIES, 3000),
  enableEvaluate: parseBoolean(process.env.ENABLE_EVALUATE, true),
  // Playwright auto-dismisses dialogs only while no "dialog" listener exists.
  // This server always attaches one (to log them), so it must decide explicitly
  // or every alert/confirm/prompt blocks the action that raised it.
  defaultDialogAction: process.env.DEFAULT_DIALOG_ACTION || "dismiss",
  defaultDialogPromptText: process.env.DEFAULT_DIALOG_PROMPT_TEXT || "",
  dialogHandlingTimeoutMs: parseInteger(process.env.DIALOG_HANDLING_TIMEOUT_MS, 5000),
  validationTimeoutMs: parseInteger(process.env.VALIDATION_TIMEOUT_MS, 60_000),
  commandOutputLimitBytes: parseInteger(process.env.COMMAND_OUTPUT_LIMIT_BYTES, 256 * 1024),
  runEnvPassthrough: parseCsv(process.env.RUN_ENV_PASSTHROUGH),
  maxRetainedArtifacts: parseInteger(process.env.MAX_RETAINED_ARTIFACTS, 2000),
  // Variable names matching this are stored as "***". A run still receives the
  // real value; only what is written to disk and returned by the API is masked.
  redactVariablePattern: process.env.REDACT_VARIABLE_PATTERN || "(pass|secret|token|credential|pwd|api[-_]?key)",
  maxDatasetRows: parseInteger(process.env.MAX_DATASET_ROWS, 200),
  scheduleTickMs: parseInteger(process.env.SCHEDULE_TICK_MS, 30 * 1000),
  notifyTimeoutMs: parseInteger(process.env.NOTIFY_TIMEOUT_MS, 10 * 1000),
  notifyAllowlist: parseCsv(process.env.NOTIFY_ALLOWLIST),
  maxDownloadBytes: parseInteger(process.env.MAX_DOWNLOAD_BYTES, 64 * 1024 * 1024),
  maxApiResponseBodyBytes: parseInteger(process.env.MAX_API_RESPONSE_BODY_BYTES, 256 * 1024),
  apiRequestTimeoutMs: parseInteger(process.env.API_REQUEST_TIMEOUT_MS, 30 * 1000),
  captureFailureArtifacts: parseBoolean(process.env.CAPTURE_FAILURE_ARTIFACTS, true),
  purgeSessionArtifactsOnClose: parseBoolean(process.env.PURGE_SESSION_ARTIFACTS_ON_CLOSE, false),
  apiToken: process.env.API_TOKEN || "",
  urlAllowlist: parseCsv(process.env.URL_ALLOWLIST),
  allowedOrigins: parseCsv(process.env.ALLOWED_ORIGINS),
  launchArgs: parseCsv(process.env.PLAYWRIGHT_LAUNCH_ARGS),
  protocolVersion: "2025-03-26",
  playwrightCliPath: path.join(rootDir, "node_modules", "playwright", "cli.js"),
};

const browsers = {
  chromium,
  firefox,
  webkit,
};

const isDocker = (() => {
  try {
    return fs.existsSync("/.dockerenv")
      || (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"));
  } catch {
    return false;
  }
})();

for (const [label, dirPath] of [
  ["SCRIPTS_DIR", config.scriptsDir],
  ["RUNS_DIR", config.runsDir],
  ["ARTIFACTS_DIR", config.artifactsDir],
]) {
  try {
    await ensureDir(dirPath);
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") {
      console.error(
        `cannot write to ${label} (${dirPath}): ${error.code}.\n`
        + `The process runs as uid ${process.getuid?.() ?? "?"}. If this is a mounted volume, `
        + "make it writable by that uid (for example `chown -R 1001:1001 ./data`) or run the "
        + "container with --user matching the directory's owner.",
      );
      process.exit(1);
    }
    throw error;
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function toIso(value = Date.now()) {
  return new Date(value).toISOString();
}

// Date.now() is wall-clock and can step backwards (NTP correction, a host
// suspend/resume under WSL2 or a VM), which produced negative durations and made
// a failed step sort last in "slowest steps" - exactly backwards. Elapsed time
// has to come from a monotonic source.
function monotonicNow() {
  return performance.now();
}

function elapsedMs(startedAtMonotonic) {
  return Math.max(0, Math.round(monotonicNow() - startedAtMonotonic));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, length = 400) {
  if (typeof value !== "string" || value.length <= length) {
    return value;
  }

  return `${value.slice(0, length)}...`;
}

function summarize(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value);
  }

  try {
    return truncate(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function safeFilename(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "artifact";
}

async function ensureDir(dirPath) {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(filePath) {
  try {
    return await fsPromises.stat(filePath);
  } catch {
    return null;
  }
}

// A half-written run record is worse than none: the reader cannot tell it is
// truncated. Write to a sibling and rename, which is atomic on both POSIX and
// NTFS.
async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fsPromises.rename(tempPath, filePath);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Environments and datasets are both "named JSON documents in a directory", so
// they share one tiny store rather than growing two near-identical CRUD paths.
class NamedJsonStore {
  constructor(dirPath, label) {
    this.dirPath = dirPath;
    this.label = label;
  }

  resolve(name) {
    const cleaned = String(name ?? "").trim();
    if (!cleaned || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) {
      throw new ApiError(
        400,
        "INVALID_NAME",
        `${this.label} name must start alphanumeric and contain only letters, digits, dot, dash or underscore`,
      );
    }

    return { name: cleaned, filePath: resolveWithin(this.dirPath, `${cleaned}.json`, `${this.label} name`) };
  }

  async list() {
    await ensureDir(this.dirPath);
    const entries = await fsPromises.readdir(this.dirPath, { withFileTypes: true }).catch(() => []);
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .sort();

    const out = [];
    for (const name of names) {
      const document = await readJsonFile(path.join(this.dirPath, `${name}.json`));
      if (document) {
        out.push({ name, ...document });
      }
    }

    return out;
  }

  async get(name) {
    const { name: cleaned, filePath } = this.resolve(name);
    const document = await readJsonFile(filePath);
    if (!document) {
      throw new ApiError(404, `${this.label.toUpperCase()}_NOT_FOUND`, `${this.label} not found: ${cleaned}`);
    }

    return { name: cleaned, ...document };
  }

  async save(name, document) {
    const { name: cleaned, filePath } = this.resolve(name);
    await ensureDir(this.dirPath);
    const stored = { ...document };
    delete stored.name;
    await writeJsonAtomic(filePath, { ...stored, updatedAt: toIso() });
    return this.get(cleaned);
  }

  async remove(name) {
    const { name: cleaned, filePath } = this.resolve(name);
    if (!(await fileExists(filePath))) {
      throw new ApiError(404, `${this.label.toUpperCase()}_NOT_FOUND`, `${this.label} not found: ${cleaned}`);
    }
    await fsPromises.unlink(filePath);
    return { deleted: cleaned };
  }
}

async function removeDir(dirPath) {
  await fsPromises.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
}

// Resolves `reference` against `baseDir` and refuses anything that escapes it.
// Absolute paths and `..` segments both resolve outside the root, so one
// path.relative check covers both.
function resolveWithin(baseDir, reference, label = "path") {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, String(reference ?? ""));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiError(400, "PATH_OUTSIDE_ROOT", `${label} must stay inside ${root}: ${reference}`);
  }

  return target;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function matchesHostPattern(hostname, pattern) {
  const host = String(hostname || "").toLowerCase();
  const normalized = String(pattern || "").toLowerCase().trim();
  if (!normalized) {
    return false;
  }
  if (normalized === "*") {
    return true;
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === normalized;
}

// An empty allowlist means "no policy configured", which allows everything.
// Loopback is always permitted: the server's own demo page lives there, and
// blocking it would make the allowlist unusable for local targets.
function isAllowedHost(hostname, allowlist) {
  if (!allowlist?.length) {
    return true;
  }
  if (LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase())) {
    return true;
  }

  return allowlist.some((entry) => matchesHostPattern(hostname, entry));
}

// A per-run allowlist may only narrow the configured one; otherwise a caller
// could widen its own network reach past what the operator permitted.
function narrowAllowlist(globalAllowlist, requested) {
  if (!Array.isArray(requested) || !requested.length) {
    return { allowlist: globalAllowlist, rejected: [] };
  }

  const cleaned = requested.map((entry) => String(entry).toLowerCase().trim()).filter(Boolean);
  if (!globalAllowlist?.length) {
    return { allowlist: cleaned, rejected: [] };
  }

  const allowlist = [];
  const rejected = [];
  for (const entry of cleaned) {
    // Test the pattern's own host form against the operator policy, so
    // "*.evil.com" cannot slip past an allowlist of "example.com".
    const probe = entry.startsWith("*.") ? entry.slice(2) : entry;
    if (entry !== "*" && globalAllowlist.some((allowed) => matchesHostPattern(probe, allowed))) {
      allowlist.push(entry);
    } else {
      rejected.push(entry);
    }
  }

  return { allowlist: allowlist.length ? allowlist : globalAllowlist, rejected };
}

// Minimal 5-field cron. No scheduling dependency is available here, so this
// covers the subset people actually write: *, n, a,b, a-b, */n and a-b/n.
const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 },
];

function parseCronField(raw, { name, min, max }) {
  const allowed = new Set();
  for (const part of String(raw).split(",")) {
    const token = part.trim();
    if (!token) {
      throw new ApiError(400, "INVALID_CRON", `${name}: empty element in "${raw}"`);
    }

    const [range, stepRaw] = token.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new ApiError(400, "INVALID_CRON", `${name}: step must be a positive integer, got "${stepRaw}"`);
    }

    let from;
    let to;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      [from, to] = range.split("-").map(Number);
    } else {
      from = Number(range);
      to = from;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new ApiError(400, "INVALID_CRON", `${name}: "${token}" is not a range within ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) {
      allowed.add(value);
    }
  }

  return allowed;
}

function parseCron(expression) {
  const parts = String(expression ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new ApiError(
      400,
      "INVALID_CRON",
      `cron needs 5 fields (minute hour dayOfMonth month dayOfWeek), got ${parts.length}`,
    );
  }

  return CRON_FIELDS.map((field, index) => parseCronField(parts[index], field));
}

function cronMatches(fields, date) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  // Standard cron: when both day fields are restricted, either may match.
  const domRestricted = dayOfMonth.size !== 31;
  const dowRestricted = dayOfWeek.size !== 7;
  const dayOk = domRestricted && dowRestricted
    ? dayOfMonth.has(date.getDate()) || dayOfWeek.has(date.getDay())
    : dayOfMonth.has(date.getDate()) && dayOfWeek.has(date.getDay());

  return minute.has(date.getMinutes())
    && hour.has(date.getHours())
    && month.has(date.getMonth() + 1)
    && dayOk;
}

const REDACTED = "***";
const SECRET_REFERENCE_PATTERN = /\{\{\s*secret\.([A-Za-z0-9_.-]+)\s*\}\}/g;

// A password passed in `variables` used to be written into run.json and returned
// by GET /api/runs — permanently, and readable by anyone with API access or the
// mounted volume. Two defences: a `{{secret.NAME}}` reference whose value never
// enters the record at all, and name-based masking for literal values.
class SecretResolver {
  constructor(options) {
    this.secretsDir = options.secretsDir;
    this.namePattern = new RegExp(options.redactVariablePattern, "i");
    this.cache = new Map();
  }

  isSensitiveName(name) {
    return this.namePattern.test(String(name));
  }

  async readSecret(name) {
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }

    // A file wins over the environment so an operator can rotate without a
    // restart; the env form exists for deployments that inject secrets that way.
    let value = null;
    try {
      const filePath = resolveWithin(this.secretsDir, name, "secret name");
      value = (await fsPromises.readFile(filePath, "utf8")).replace(/\r?\n$/, "");
    } catch {
      const envKey = `PW_PLAYER_SECRET_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      value = process.env[envKey] ?? null;
    }

    this.cache.set(name, value);
    return value;
  }

  // Returns the values a run actually receives, a copy safe to persist, and the
  // literal strings to scrub from anything the run prints.
  async resolveVariables(variables = {}) {
    const resolved = {};
    const safe = {};
    const sensitiveValues = new Set();
    const missing = [];

    for (const [key, raw] of Object.entries(variables)) {
      if (typeof raw !== "string") {
        resolved[key] = raw;
        safe[key] = this.isSensitiveName(key) ? REDACTED : raw;
        continue;
      }


      let usedSecret = false;
      let value = raw;
      const references = [...raw.matchAll(SECRET_REFERENCE_PATTERN)];
      for (const [match, secretName] of references) {
        const secret = await this.readSecret(secretName);
        if (secret === null) {
          missing.push(secretName);
          continue;
        }
        usedSecret = true;
        value = value.split(match).join(secret);
      }

      resolved[key] = value;
      // A referenced secret is never stored, even if the name looks harmless:
      // the reference itself is the useful thing to keep.
      safe[key] = usedSecret ? raw : (this.isSensitiveName(key) ? REDACTED : raw);
      // Short values would mask far too much of the output to be worth it.
      if ((usedSecret || this.isSensitiveName(key)) && value && value.length >= 6) {
        sensitiveValues.add(value);
      }
    }

    if (missing.length) {
      throw new ApiError(
        400,
        "SECRET_NOT_FOUND",
        `No value for secret(s): ${[...new Set(missing)].join(", ")}. `
        + `Put the value in ${this.secretsDir}/<name> or set PW_PLAYER_SECRET_<NAME>.`,
      );
    }

    return { resolved, safe, sensitiveValues: [...sensitiveValues] };
  }
}

// A script that prints a credential would otherwise have it written into
// logs.jsonl and served by the log API. This masks the values the server itself
// handed to the run. It cannot reach Playwright's own report, trace or video —
// those are written by Playwright, so a script must still not print secrets.
function scrubSensitive(text, sensitiveValues) {
  if (!sensitiveValues?.length) {
    return text;
  }

  let out = text;
  for (const value of sensitiveValues) {
    if (value) {
      out = out.split(value).join(REDACTED);
    }
  }

  return out;
}

// A caller could otherwise make the server POST to any host it can reach, which
// turns this into an SSRF proxy. NOTIFY_ALLOWLIST gates it; falling back to
// URL_ALLOWLIST keeps a single-policy deployment safe by default, and an
// unrestricted server stays unrestricted.
function assertNotifyUrlAllowed(rawUrl, options) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, "INVALID_NOTIFY_URL", `notify.url is not a valid URL: ${rawUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ApiError(400, "INVALID_NOTIFY_URL", `notify.url must be http or https, got ${parsed.protocol}`);
  }

  const allowlist = options.notifyAllowlist.length ? options.notifyAllowlist : options.urlAllowlist;
  if (allowlist.length && !isAllowedHost(parsed.hostname, allowlist)) {
    throw new ApiError(
      403,
      "NOTIFY_URL_NOT_ALLOWED",
      `notify.url host is not allowed: ${parsed.hostname}. Add it to NOTIFY_ALLOWLIST.`,
    );
  }

  return parsed.toString();
}

function normalizeNotify(notify, options) {
  if (!notify) {
    return null;
  }

  const on = String(notify.on || "failure").toLowerCase();
  if (!["failure", "always"].includes(on)) {
    throw new ApiError(400, "INVALID_REQUEST", 'notify.on must be "failure" or "always"');
  }

  return {
    url: assertNotifyUrlAllowed(notify.url, options),
    on,
    headers: notify.headers && typeof notify.headers === "object" ? notify.headers : undefined,
  };
}

const SCRIPT_EXTENSION_PATTERN = /\.(spec|test|pw)\.(js|mjs|cjs|ts|mts|cts)$/i;
const VALID_REGEX_FLAGS = /^[dgimsuvy]*$/;

// `"/pattern/flags"` is the documented way to send a regular expression through
// JSON. Anything else - including a plain URL path such as "/checkout/cart" -
// must stay a literal string, so flags are validated and construction guarded.
function parseRegexLiteral(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return null;
  }

  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }

  const flags = value.slice(lastSlash + 1);
  if (!VALID_REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length) {
    return null;
  }

  try {
    return new RegExp(value.slice(1, lastSlash), flags);
  } catch {
    return null;
  }
}

// Resolves an uploaded script key + optional file name to a path inside the
// scripts directory, rejecting traversal and non-Playwright extensions.
function resolveScriptUploadPath(scriptsDir, scriptKey, fileName) {
  const key = String(scriptKey ?? "").trim();
  if (!key) {
    throw new ApiError(400, "INVALID_SCRIPT_KEY", "scriptKey is required");
  }

  let extension = ".spec.js";
  if (fileName) {
    const match = SCRIPT_EXTENSION_PATTERN.exec(String(fileName));
    if (!match) {
      throw new ApiError(
        400,
        "INVALID_SCRIPT_FILENAME",
        "fileName must end with .spec/.test/.pw plus js, mjs, cjs, ts, mts, or cts",
      );
    }
    extension = match[0];
  }

  const absolutePath = resolveWithin(scriptsDir, `${key}${extension}`, "scriptKey");
  return {
    absolutePath,
    extension,
    scriptKey: path.relative(path.resolve(scriptsDir), absolutePath)
      .split(path.sep)
      .join("/")
      .replace(SCRIPT_EXTENSION_PATTERN, ""),
  };
}

async function listFilesRecursively(dirPath) {
  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

class ApiError extends Error {
  constructor(statusCode, code, message, details = undefined, artifacts = undefined) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.artifacts = artifacts;
  }
}

function toApiError(error, fallback = {}) {
  if (error instanceof ApiError) {
    if (fallback.details && !error.details) {
      error.details = fallback.details;
    }

    if (fallback.artifacts && !error.artifacts) {
      error.artifacts = fallback.artifacts;
    }

    return error;
  }

  return new ApiError(
    fallback.statusCode ?? 500,
    fallback.code ?? "INTERNAL_ERROR",
    error?.message ?? "Unexpected error",
    fallback.details,
    fallback.artifacts,
  );
}

class ScriptRegistry {
  constructor(options) {
    this.options = options;
    this.scripts = new Map();
  }

  async refresh() {
    await ensureDir(this.options.scriptsDir);
    const files = await listFilesRecursively(this.options.scriptsDir);
    const nextScripts = new Map();

    for (const filePath of files) {
      if (!this.isScriptFile(filePath)) {
        continue;
      }

      const relativePath = path.relative(this.options.scriptsDir, filePath).split(path.sep).join("/");
      const key = relativePath.replace(/(\.spec|\.test|\.pw)?\.[^.]+$/, "");
      const stats = await fsPromises.stat(filePath);
      nextScripts.set(key, {
        scriptKey: key,
        absolutePath: filePath,
        relativePath,
        sizeBytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
      });
    }

    this.scripts = new Map([...nextScripts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    return this.list();
  }

  isScriptFile(filePath) {
    return /\.(spec|test|pw)\.(js|mjs|cjs|ts|mts|cts)$/i.test(filePath);
  }

  list() {
    return [...this.scripts.values()];
  }

  get(scriptKey) {
    const script = this.scripts.get(scriptKey);
    if (!script) {
      throw new ApiError(404, "SCRIPT_NOT_FOUND", `Script not found: ${scriptKey}`);
    }

    return script;
  }

  async sync() {
    const scripts = await this.refresh();
    return {
      scripts,
      git: await this.resolveGitInfo(),
    };
  }

  async resolveGitInfo() {
    try {
      const gitOptions = { timeoutMs: 5000, maxOutputBytes: 8 * 1024 };
      const revParse = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], rootDir, gitOptions);
      if (!revParse.stdout.includes("true")) {
        return { available: false };
      }

      const branch = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir, gitOptions);
      const commit = await runCommand("git", ["rev-parse", "HEAD"], rootDir, gitOptions);
      return {
        available: true,
        branch: branch.stdout.trim(),
        commit: commit.stdout.trim(),
      };
    } catch {
      return { available: false };
    }
  }
}

// Every spawn here runs caller-influenced code, so both wall-clock time and
// captured output are bounded; an unbounded child could hang a request forever
// or buffer a runaway log into the heap.
function runCommand(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const outputLimit = options.maxOutputBytes ?? 256 * 1024;
  const env = options.env;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, cleanObject({
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));

    const buffers = { stdout: "", stderr: "" };
    let truncated = false;
    let timedOut = false;

    const capture = (stream, chunk) => {
      const remaining = outputLimit - buffers[stream].length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      buffers[stream] += text.slice(0, remaining);
      truncated = truncated || text.length > remaining;
    };

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const { stdout, stderr } = buffers;
      if (timedOut) {
        reject(new ApiError(408, "COMMAND_TIMEOUT", `${command} exceeded ${timeoutMs}ms and was killed`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, code, truncated });
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
}

// The spawned Playwright process must not inherit the server's whole
// environment: API_TOKEN and any other operator secret would be readable from
// inside every test file the server runs.
const RUN_ENV_BASE_KEYS = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PATHEXT", "WINDIR", "NUMBER_OF_PROCESSORS",
];

function buildRunEnv(extra = {}) {
  const env = {};
  for (const key of [...RUN_ENV_BASE_KEYS, ...config.runEnvPassthrough]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Playwright needs its own configuration to locate browsers offline.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PLAYWRIGHT_") && value !== undefined) {
      env[key] = value;
    }
  }

  // SCRIPTS_DIR is configurable and is usually a mounted volume, so a spec file
  // sitting outside this project cannot resolve `@playwright/test` from its own
  // directory. NODE_PATH points the run at the server's installation.
  const serverModules = path.join(rootDir, "node_modules");
  env.NODE_PATH = [serverModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

  return { ...env, ...extra };
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectFilesWithMetadata(baseDir) {
  if (!(await fileExists(baseDir))) {
    return [];
  }

  const files = await listFilesRecursively(baseDir);
  const results = [];

  for (const filePath of files) {
    const stats = await fsPromises.stat(filePath);
    results.push({
      fileName: path.basename(filePath),
      relativePath: path.relative(baseDir, filePath).split(path.sep).join("/"),
      absolutePath: filePath,
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
    });
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function renderPlaywrightConfig({ scriptsDir, outputDir, htmlReportDir, jsonReportPath, proxyUrl }) {
  return `import { createRequire } from "node:module";

const require = createRequire(${JSON.stringify(serverModuleAnchorUrl)});
const { defineConfig, devices } = require("@playwright/test");

const maybe = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value;
};

const headed = process.env.PW_PLAYER_HEADED === "true";
const baseURL = maybe(process.env.PW_PLAYER_BASE_URL);
const trace = maybe(process.env.PW_PLAYER_TRACE) || "on-first-retry";
const video = maybe(process.env.PW_PLAYER_VIDEO) || "retain-on-failure";
const screenshot = maybe(process.env.PW_PLAYER_SCREENSHOT) || "only-on-failure";
const storageState = maybe(process.env.PW_PLAYER_STORAGE_STATE);
const timeoutMs = Number.parseInt(process.env.PW_PLAYER_TIMEOUT_MS || "30000", 10);

export default defineConfig({
  testDir: ${JSON.stringify(scriptsDir)},
  timeout: timeoutMs,
  outputDir: ${JSON.stringify(outputDir)},
  reporter: [
    ["list"],
    ["json", { outputFile: ${JSON.stringify(jsonReportPath)} }],
    ["./${RUN_STEP_REPORTER_FILE}"],
    ["html", { open: "never", outputFolder: ${JSON.stringify(htmlReportDir)} }],
  ],
  use: {
    baseURL,
    headless: !headed,
    trace,
    video,
    screenshot,
    storageState,
${proxyUrl ? `    // URL_ALLOWLIST is enforced by a loopback proxy owned by the server.
    // Set at launch as well as context level because Firefox only honours a
    // proxy given at browser launch. Loopback bypasses it.
    proxy: ${JSON.stringify({ server: proxyUrl, bypass: "localhost,127.0.0.1,::1" })},
    launchOptions: { proxy: ${JSON.stringify({ server: proxyUrl, bypass: "localhost,127.0.0.1,::1" })} },
` : ""}  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "webkit", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
`;
}

// Run state used to live only in memory, so a container restart erased every
// result and its evidence became unreachable. Each run now owns a directory
// holding `run.json` (the record) and `logs.jsonl` (append-only output), next to
// the artifacts it already produced. No external database: this has to work in a
// single air-gapped container.
const RUN_RECORD_FILE = "run.json";
const RUN_LOG_FILE = "logs.jsonl";
const RUN_SCRIPT_SNAPSHOT_DIR = "script";

// A pinned script used to be a single file copied by basename, so a spec that
// imported a sibling module could not run at all ("Cannot find module
// .../script/helpers.js") and a key with a directory lost its path. Seven of
// the nine scripts this repo ships import ./helpers.js, so they all failed.
// The snapshot now carries the module graph, laid out as it is in SCRIPTS_DIR.
//
// `import x from "./a.js"`, `import "./a.js"`, `export * from "../a.js"`,
// `import("./a.js")` and `require("./a.js")`. Only relative specifiers can
// resolve inside SCRIPTS_DIR; a package or node: specifier is not ours to copy.
const RELATIVE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\1/g;

// Node ESM wants an explicit extension, but Playwright's loader and TypeScript
// specs also accept extensionless and directory imports.
const SCRIPT_DEPENDENCY_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];

function findRelativeSpecifiers(source) {
  return [...source.matchAll(RELATIVE_SPECIFIER_PATTERN)].map((match) => match[2]);
}

async function resolveScriptDependency(scriptsRoot, fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    ...SCRIPT_DEPENDENCY_SUFFIXES.map((suffix) => base + suffix),
    ...SCRIPT_DEPENDENCY_SUFFIXES.slice(1).map((suffix) => path.join(base, `index${suffix}`)),
  ];

  for (const candidate of candidates) {
    // A dependency reached through ../.. outside the scripts directory is not
    // ours to snapshot, and copying it would widen what a script can read.
    const relative = path.relative(scriptsRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Walks the module graph from the entry script. An unresolvable specifier is
// recorded rather than raised: a regex over JavaScript has false positives (a
// commented-out import matches), and refusing to queue a working script over
// one would be worse than the module error the run would report anyway.
async function collectScriptBundle(scriptsDir, entryAbsolutePath, limits = {}) {
  const scriptsRoot = path.resolve(scriptsDir);
  const maxFiles = limits.maxFiles || 50;
  const maxBytes = limits.maxBytes || 8 * 1024 * 1024;

  const queue = [entryAbsolutePath];
  const visited = new Set();
  const files = [];
  const unresolved = [];
  let totalBytes = 0;

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const content = await fsPromises.readFile(current, "utf8");
    const relativePath = path.relative(scriptsRoot, current).split(path.sep).join("/");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    totalBytes += sizeBytes;

    if (files.length >= maxFiles) {
      throw new ApiError(
        400,
        "SCRIPT_BUNDLE_TOO_LARGE",
        `${path.basename(entryAbsolutePath)} pulls in more than ${maxFiles} files (MAX_SCRIPT_BUNDLE_FILES)`,
      );
    }
    if (totalBytes > maxBytes) {
      throw new ApiError(
        400,
        "SCRIPT_BUNDLE_TOO_LARGE",
        `${path.basename(entryAbsolutePath)} and its imports exceed ${maxBytes} bytes (MAX_SCRIPT_BUNDLE_BYTES)`,
      );
    }

    files.push({ relativePath, absolutePath: current, content, sizeBytes, sha256: sha256Hex(content) });

    for (const specifier of findRelativeSpecifiers(content)) {
      const resolved = await resolveScriptDependency(scriptsRoot, current, specifier);
      if (resolved) {
        queue.push(resolved);
      } else {
        unresolved.push({ from: relativePath, specifier });
      }
    }
  }

  return { files, unresolved };
}
const RUN_STEPS_FILE = "steps.json";
const RUN_STEP_REPORTER_FILE = "pw-player-steps-reporter.mjs";
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
// Bookkeeping, not test evidence: both have dedicated endpoints, and listing
// them as artifacts inflates artifactCount and clutters the download list.
const RUN_INTERNAL_FILES = new Set([RUN_RECORD_FILE, RUN_LOG_FILE, RUN_STEPS_FILE]);

function isRunEvidence(relativePath) {
  return !RUN_INTERNAL_FILES.has(relativePath);
}

// URL_ALLOWLIST was only enforced on session browsers. A script run is a separate
// process, so nothing stopped it reaching any host - the one security asymmetry
// left after v0.3.0. Each run now gets its own loopback-only proxy that the run's
// browser is pointed at, which works for all three engines (a Chromium-specific
// flag would not) and attributes every blocked request to the run that made it.
// Playwright nests steps arbitrarily deep (a click inside an expect inside a
// test.step). Keep the shape but drop everything a timeline does not use.
// Playwright's json reporter does not include steps, so "the test took 12s" says
// nothing about which click or assertion was slow. This reporter records the
// step tree per test and writes it next to the report; `test.id` here equals
// `spec.id` in the json report, which is how the two are joined.
function renderStepReporter(outputPath) {
  return `import fs from "node:fs";

const OUTPUT = ${JSON.stringify(outputPath)};
const MAX_DEPTH = 6;

function trim(steps, depth = 0) {
  if (!Array.isArray(steps) || depth > MAX_DEPTH) {
    return undefined;
  }

  const mapped = [];
  for (const step of steps) {
    if (!step?.title) {
      continue;
    }
    const entry = {
      title: String(step.title).slice(0, 300),
      category: step.category,
      durationMs: typeof step.duration === "number" ? step.duration : null,
    };
    if (step.error?.message) {
      entry.error = String(step.error.message).slice(0, 1000);
    }
    const nested = trim(step.steps, depth + 1);
    if (nested) {
      entry.steps = nested;
    }
    mapped.push(entry);
  }

  return mapped.length ? mapped : undefined;
}

export default class PwPlayerStepReporter {
  constructor() {
    this.byTest = {};
  }

  onTestEnd(test, result) {
    try {
      // Later retries overwrite earlier ones, matching the json report, which
      // also reports the last result.
      this.byTest[test.id] = {
        retry: result.retry,
        status: result.status,
        steps: trim(result.steps) || [],
      };
    } catch {
      // A reporter must never fail the run it is observing.
    }
  }

  async onEnd() {
    try {
      fs.writeFileSync(OUTPUT, JSON.stringify(this.byTest), "utf8");
    } catch {
      // Steps are a convenience; losing them must not fail the run.
    }
  }
}
`;
}

function flattenReportSteps(steps, depth = 0) {
  if (!Array.isArray(steps) || depth > 6) {
    return undefined;
  }

  const mapped = steps
    // pw:api covers the actual click/fill/assert calls; the rest is framework noise.
    .filter((step) => step.title)
    .map((step) => cleanObject({
      title: truncate(step.title, 300),
      category: step.category,
      durationMs: typeof step.duration === "number" ? step.duration : undefined,
      error: step.error?.message ? truncate(step.error.message, 1000) : undefined,
      steps: flattenReportSteps(step.steps, depth + 1),
    }));

  return mapped.length ? mapped : undefined;
}

class RunNetworkGuard {
  constructor({ allowlist, maxBlockedEntries = 100 }) {
    this.allowlist = allowlist;
    this.maxBlockedEntries = maxBlockedEntries;
    this.blocked = [];
    this.blockedCount = 0;
    this.allowedCount = 0;
    this.server = null;
    this.sockets = new Set();
  }

  recordBlocked(method, host) {
    this.blockedCount += 1;
    if (this.blocked.length < this.maxBlockedEntries) {
      this.blocked.push({ ts: toIso(), method, host });
    }
  }

  track(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }

  async start() {
    this.server = http.createServer((req, res) => {
      // Proxied plain HTTP arrives as an absolute-form request URI.
      let hostname;
      try {
        hostname = new URL(req.url).hostname;
      } catch {
        res.writeHead(400, { "content-type": "text/plain" }).end("malformed proxy request");
        return;
      }

      if (!isAllowedHost(hostname, this.allowlist)) {
        this.recordBlocked(req.method || "GET", hostname);
        res.writeHead(403, { "content-type": "text/plain" })
          .end(`playwright-player: ${hostname} is not in URL_ALLOWLIST`);
        return;
      }

      this.allowedCount += 1;
      const target = new URL(req.url);
      const upstream = http.request({
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" }).end("upstream error");
        } else {
          res.end();
        }
      });
      req.pipe(upstream);
    });

    this.server.on("connect", (req, socket, head) => {
      this.track(socket);
      const [rawHost, rawPort] = String(req.url || "").split(":");
      const hostname = rawHost?.replace(/^\[|\]$/g, "");
      if (!hostname || !isAllowedHost(hostname, this.allowlist)) {
        this.recordBlocked("CONNECT", hostname || "unknown");
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }

      this.allowedCount += 1;
      const upstream = net.connect(Number(rawPort) || 443, hostname, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) {
          upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      this.track(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });

    this.server.on("clientError", (error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    // Loopback only: nothing outside this container can use the proxy.
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });

    return this.proxyUrl;
  }

  get proxyUrl() {
    const address = this.server?.address();
    return address ? `http://127.0.0.1:${address.port}` : null;
  }

  summary() {
    return {
      allowlist: this.allowlist,
      proxyUrl: this.proxyUrl,
      allowedRequests: this.allowedCount,
      blockedRequests: this.blockedCount,
      blocked: this.blocked,
    };
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}

class RunManager {
  constructor(options) {
    this.options = options;
    this.registry = options.registry;
    this.environments = new NamedJsonStore(options.environmentsDir, "environment");
    this.datasets = new NamedJsonStore(options.datasetsDir, "dataset");
    this.schedules = new NamedJsonStore(options.schedulesDir, "schedule");
    this.secrets = new SecretResolver(options);
    this.scheduleTimer = null;
    this.runs = new Map();
    this.queue = [];
    this.pendingWrites = new Map();
    this.draining = false;
  }

  // ---- persistence --------------------------------------------------------

  runDir(runId) {
    return path.join(this.options.runsDir, runId);
  }

  // Records store absolute paths, but RUNS_DIR is configurable and is usually a
  // mounted volume, so the directory can legitimately move between lifetimes.
  // Everything lives under the run directory, so re-derive from the current root.
  rebasePaths(runId, storedPaths = {}) {
    const runDir = this.runDir(runId);
    const rebased = { runDir };
    for (const [key, value] of Object.entries(storedPaths)) {
      if (key === "runDir" || typeof value !== "string") {
        continue;
      }
      rebased[key] = path.join(runDir, path.basename(value));
    }

    return rebased;
  }

  // Everything needed to answer a query after a restart. The live child process
  // and the log array are deliberately excluded.
  toRecord(run) {
    return {
      runId: run.runId,
      scriptKey: run.scriptKey,
      status: run.status,
      priority: run.priority,
      attempt: run.attempt,
      retryOf: run.retryOf,
      pid: run.pid,
      createdAt: run.createdAt,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      interruptedReason: run.interruptedReason,
      request: run.request,
      script: run.script,
      environment: run.environment,
      schedule: run.schedule,
      notify: run.notify,
      notification: run.notification,
      datasetRow: run.datasetRow,
      network: run.network,
      paths: run.paths,
      summary: run.summary,
      tests: run.tests,
      logCount: run.logCount,
      artifactCount: run.artifacts.length,
      recordVersion: 1,
    };
  }

  fromRecord(record) {
    return {
      ...record,
      // Deliberately absent from the record. A requeued run re-resolves them.
      resolvedVariables: null,
      sensitiveValues: [],
      logs: [],
      logCount: record.logCount ?? 0,
      artifacts: [],
      tests: record.tests ?? [],
      priority: record.priority ?? 0,
      attempt: record.attempt ?? 1,
      process: null,
      cancelRequested: false,
      persisted: true,
    };
  }

  // All disk work for a run goes through one chain. Two concurrent
  // fsPromises.appendFile calls are not guaranteed to be atomic for a payload of
  // arbitrary size, so unserialised appends could splice two log lines together
  // and make the JSONL unparseable.
  enqueueWrite(runId, work) {
    const previous = this.pendingWrites.get(runId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work).catch((error) => {
      console.error(`[run] disk write failed for ${runId}`, error);
    });
    this.pendingWrites.set(runId, next);
    return next;
  }

  persist(run) {
    if (!run.paths?.runDir) {
      return Promise.resolve();
    }

    const record = this.toRecord(run);
    return this.enqueueWrite(run.runId, () => writeJsonAtomic(path.join(run.paths.runDir, RUN_RECORD_FILE), record));
  }

  async flushWrites() {
    await Promise.allSettled([...this.pendingWrites.values()]);
  }

  // Rebuilds the index from disk and reconciles anything the previous process
  // left mid-flight: those child processes died with it and cannot be resumed.
  async restore() {
    await ensureDir(this.options.runsDir);
    const entries = await fsPromises.readdir(this.options.runsDir, { withFileTypes: true }).catch(() => []);
    const restored = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) {
        continue;
      }

      const record = await readJsonFile(path.join(this.options.runsDir, entry.name, RUN_RECORD_FILE));
      if (!record?.runId) {
        continue;
      }

      const run = this.fromRecord(record);
      run.paths = this.rebasePaths(run.runId, run.paths);
      if (run.script?.snapshotPath) {
        // Stored absolute paths are not trusted across a restart, so the
        // snapshot is relocated under this run's directory.
        const snapshotDir = path.join(run.paths.runDir, RUN_SCRIPT_SNAPSHOT_DIR);
        run.script.snapshotDir = snapshotDir;
        const relocated = run.script.relativePath
          ? path.join(snapshotDir, ...run.script.relativePath.split("/"))
          : path.join(snapshotDir, path.basename(run.script.snapshotPath));
        // Runs queued before the snapshot kept its directory layout have the
        // entry file flattened to the snapshot root.
        run.script.snapshotPath = (await fileExists(relocated))
          ? relocated
          : path.join(snapshotDir, path.basename(run.script.snapshotPath));
      }
      run.artifacts = (await collectFilesWithMetadata(run.paths?.runDir || this.runDir(run.runId)))
        .filter((file) => isRunEvidence(file.relativePath));
      this.runs.set(run.runId, run);
      restored.push(run);
    }

    const interrupted = [];
    for (const run of restored) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        continue;
      }

      const wasQueued = run.status === "queued";
      if (wasQueued || this.options.requeueInterruptedRuns) {
        // Secret values were never stored, so resolve them again from source.
        try {
          const restored = await this.secrets.resolveVariables(run.request?.variables || {});
          run.resolvedVariables = restored.resolved;
          run.sensitiveValues = restored.sensitiveValues;
        } catch (error) {
          run.status = "failed";
          run.endedAt = toIso();
          run.interruptedReason = `could not restore variables: ${error.message}`;
          await this.persist(run);
          continue;
        }

        run.status = "queued";
        run.queuedAt = run.queuedAt || toIso();
        run.pid = null;
        run.attempt = wasQueued ? run.attempt : (run.attempt ?? 1) + 1;
        this.queue.push(run.runId);
      } else {
        run.status = "interrupted";
        run.endedAt = toIso();
        run.interruptedReason = "server stopped while the run was executing";
        interrupted.push(run.runId);
      }
      await this.persist(run);
    }

    this.sortQueue();
    console.log(
      `[run] restored ${restored.length} run(s) from disk`
      + `; ${this.queue.length} queued, ${interrupted.length} marked interrupted`,
    );
    this.drain();
    return { restored: restored.length, queued: this.queue.length, interrupted };
  }

  listRuns(filter = {}) {
    let runs = [...this.runs.values()];
    if (filter.status) {
      const wanted = new Set(parseCsv(filter.status));
      runs = runs.filter((run) => wanted.has(run.status));
    }
    if (filter.scriptKey) {
      runs = runs.filter((run) => run.scriptKey === filter.scriptKey);
    }

    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const total = runs.length;
    const offset = Math.max(Number(filter.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
    return {
      total,
      offset,
      limit,
      runs: runs.slice(offset, offset + limit).map((run) => this.serializeRun(run)),
    };
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new ApiError(404, "RUN_NOT_FOUND", `Run not found: ${runId}`);
    }

    return run;
  }

  serializeRun(run) {
    return {
      runId: run.runId,
      scriptKey: run.scriptKey,
      status: run.status,
      priority: run.priority ?? 0,
      attempt: run.attempt ?? 1,
      retryOf: run.retryOf ?? null,
      queuePosition: run.status === "queued" ? this.queue.indexOf(run.runId) : null,
      pid: run.pid,
      createdAt: run.createdAt,
      queuedAt: run.queuedAt ?? null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      interruptedReason: run.interruptedReason ?? null,
      request: run.request,
      script: run.script ?? null,
      environment: run.environment ?? null,
      schedule: run.schedule ?? null,
      notify: run.notify ?? null,
      notification: run.notification ?? null,
      datasetRow: run.datasetRow ?? null,
      network: run.network ?? null,
      paths: run.paths,
      logCount: run.logCount ?? run.logs.length,
      artifactCount: run.artifacts.length,
      summary: run.summary,
      tests: run.tests ?? [],
    };
  }

  appendLog(run, stream, chunk) {
    const message = chunk.toString("utf8");
    const lines = message.split(/\r?\n/).filter(Boolean);
    const entries = lines.map((line) => ({
      ts: toIso(),
      stream,
      line: truncate(scrubSensitive(line, run.sensitiveValues), 4000),
    }));
    if (!entries.length) {
      return;
    }

    run.logs.push(...entries);
    run.logCount = (run.logCount ?? 0) + entries.length;
    if (run.logs.length > this.options.maxRunLogEntries) {
      run.logs.splice(0, run.logs.length - this.options.maxRunLogEntries);
    }

    // Appending keeps the full output on disk even though memory only holds the
    // newest maxRunLogEntries lines.
    if (run.paths?.runDir) {
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      const filePath = path.join(run.paths.runDir, RUN_LOG_FILE);
      this.enqueueWrite(run.runId, () => fsPromises.appendFile(filePath, payload, "utf8"));
    }
  }

  countActiveRuns() {
    return [...this.runs.values()].filter((run) => run.status === "running").length;
  }

  countQueuedRuns() {
    return this.queue.length;
  }

  // Higher priority first, then oldest first, so a burst cannot starve an
  // earlier request.
  sortQueue() {
    this.queue.sort((leftId, rightId) => {
      const left = this.runs.get(leftId);
      const right = this.runs.get(rightId);
      if (!left || !right) {
        return 0;
      }
      return (right.priority ?? 0) - (left.priority ?? 0)
        || (left.queuedAt || "").localeCompare(right.queuedAt || "");
    });
  }

  describeQueue() {
    return {
      queued: this.queue.length,
      running: this.countActiveRuns(),
      maxConcurrentRuns: this.options.maxConcurrentRuns,
      maxQueuedRuns: this.options.maxQueuedRuns,
      entries: this.queue.map((runId, index) => {
        const run = this.runs.get(runId);
        return {
          position: index,
          runId,
          scriptKey: run?.scriptKey,
          priority: run?.priority ?? 0,
          queuedAt: run?.queuedAt,
          attempt: run?.attempt ?? 1,
        };
      }),
    };
  }

  // Single-flight: `drain` is re-entered from several places (enqueue, child
  // exit, restore) and must not start the same run twice.
  drain() {
    if (this.draining) {
      return;
    }

    this.draining = true;
    queueMicrotask(() => {
      this.drainNow()
        .catch((error) => console.error("[run] queue drain failed", error))
        .finally(() => {
          this.draining = false;
          if (this.queue.length && this.countActiveRuns() < this.options.maxConcurrentRuns) {
            this.drain();
          }
        });
    });
  }

  async drainNow() {
    while (this.queue.length && this.countActiveRuns() < this.options.maxConcurrentRuns) {
      const runId = this.queue.shift();
      const run = this.runs.get(runId);
      if (!run) {
        // A queued id with no record means something removed the run without
        // dequeueing it. Retention used to do exactly that; say so loudly rather
        // than dropping the request in silence.
        console.error(`[run] queued run ${runId} has no record and was dropped`);
        continue;
      }
      if (run.status !== "queued") {
        continue;
      }

      // Claim the slot before the first await.
      run.status = "running";
      try {
        await this.startRun(run);
      } catch (error) {
        const apiError = toApiError(error);
        run.status = "failed";
        run.endedAt = toIso();
        run.exitCode = -1;
        this.appendLog(run, "stderr", Buffer.from(`${apiError.code}: ${apiError.message}`, "utf8"));
        await this.persist(run);
        console.error(`[run] could not start ${run.runId}: ${apiError.message}`);
      }
    }
  }

  // Keeps the newest `maxRetainedRuns` runs and deletes the on-disk output of
  // everything older. Without this, every run leaks a report + trace directory.
  async pruneRuns() {
    // Only terminal runs may be pruned. Before the queue existed "not running"
    // meant "finished"; now it also matches "queued", and pruning one of those
    // would delete a run that is still waiting to execute.
    const prunable = [...this.runs.values()]
      .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const excess = this.runs.size - this.options.maxRetainedRuns;
    for (let index = 0; index < excess && index < prunable.length; index += 1) {
      const run = prunable[index];
      await (this.pendingWrites.get(run.runId) || Promise.resolve()).catch(() => undefined);
      this.runs.delete(run.runId);
      this.pendingWrites.delete(run.runId);
      if (run.paths.runDir) {
        await removeDir(run.paths.runDir);
      }
    }
  }

  // The slot has to be taken in the same synchronous turn as the check.
  // Checking first and registering the run after several awaits let concurrent
  // requests all pass the check and blow past the limit.
  // An environment supplies the parts that vary by deployment, so the same
  // scenario can be pointed at dev, staging or production without the caller
  // reassembling baseURL, storage state and variables every time. Anything the
  // request states explicitly wins; variables merge key by key.
  async composeRequest(request) {
    if (!request.environment) {
      return { request, environment: null };
    }

    const environment = await this.environments.get(request.environment);
    const composed = {
      ...request,
      baseURL: request.baseURL ?? environment.baseURL,
      project: request.project ?? environment.project,
      storageStateRef: request.storageStateRef ?? environment.storageStateRef,
      urlAllowlist: request.urlAllowlist ?? environment.urlAllowlist,
      variables: { ...(environment.variables || {}), ...(request.variables || {}) },
    };

    return { request: composed, environment };
  }

  // A dataset turns one request into one run per row, which is the point of
  // keeping input data separate: the same scenario, many inputs.
  async expandDataset(request) {
    if (!request.dataset) {
      return [request];
    }

    const dataset = await this.datasets.get(request.dataset);
    const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
    if (!rows.length) {
      throw new ApiError(400, "DATASET_EMPTY", `Dataset ${dataset.name} has no rows`);
    }
    if (rows.length > this.options.maxDatasetRows) {
      throw new ApiError(
        400,
        "DATASET_TOO_LARGE",
        `Dataset ${dataset.name} has ${rows.length} rows; MAX_DATASET_ROWS is ${this.options.maxDatasetRows}`,
      );
    }

    const selected = request.datasetRow === undefined || request.datasetRow === null
      ? rows.map((row, index) => ({ row, index }))
      : [{ row: rows[Number(request.datasetRow)], index: Number(request.datasetRow) }];

    if (selected.some((entry) => !entry.row || typeof entry.row !== "object")) {
      throw new ApiError(400, "DATASET_ROW_NOT_FOUND", `Dataset ${dataset.name} has no row ${request.datasetRow}`);
    }

    return selected.map(({ row, index }) => ({
      ...request,
      datasetRow: index,
      // Row values are the most specific input, so they win over both the
      // environment and the request's own variables.
      variables: { ...(request.variables || {}), ...row },
    }));
  }

  // Exceeding the concurrency limit used to be a 429. A request that is valid
  // now waits its turn instead of being thrown away; only a full queue rejects.
  async createRun(request, meta = {}) {
    const script = this.registry.get(request.scriptKey);
    if (!(await fileExists(this.options.playwrightCliPath))) {
      throw new ApiError(
        500,
        "PLAYWRIGHT_CLI_NOT_FOUND",
        `Playwright CLI not found at ${this.options.playwrightCliPath}. Install dependencies first.`,
      );
    }
    if (request.storageStateRef) {
      const storagePath = this.resolveStorageState(request.storageStateRef);
      if (!(await fileExists(storagePath))) {
        throw new ApiError(400, "STORAGE_STATE_NOT_FOUND", `Storage state not found: ${request.storageStateRef}`);
      }
    }
    if (this.queue.length >= this.options.maxQueuedRuns) {
      throw new ApiError(
        429,
        "RUN_QUEUE_FULL",
        `The run queue is full (${this.options.maxQueuedRuns}). Wait for it to drain or cancel queued runs.`,
      );
    }

    // Real values go to the child process; the record keeps the masked copy.
    const { resolved: resolvedVariables, safe: safeVariables, sensitiveValues } = await this.secrets
      .resolveVariables(request.variables || {});
    const notify = normalizeNotify(request.notify, this.options);
    const policy = narrowAllowlist(this.options.urlAllowlist, request.urlAllowlist);
    const runId = createId("run");
    const runDir = this.runDir(runId);
    await ensureDir(runDir);

    // Pin the script: the file can change or be deleted while the run waits, so
    // a snapshot plus its hash is what makes the stored result reproducible.
    const pinnedScript = await this.snapshotScript(runDir, script);

    const run = {
      runId,
      scriptKey: request.scriptKey,
      // Never persist the request as given: it may carry a literal credential.
      request: { ...request, variables: safeVariables },
      resolvedVariables,
      sensitiveValues,
      environment: meta.environment ? { name: meta.environment.name, baseURL: meta.environment.baseURL } : null,
      schedule: meta.schedule ?? null,
      notify,
      notification: null,
      datasetRow: request.datasetRow ?? null,
      script: pinnedScript,
      status: "queued",
      network: {
        allowlist: policy.allowlist,
        rejectedAllowlistEntries: policy.rejected,
        enforced: policy.allowlist.length > 0,
      },
      priority: Number.isFinite(Number(request.priority)) ? Number(request.priority) : 0,
      attempt: meta.attempt ?? 1,
      retryOf: meta.retryOf ?? null,
      createdAt: toIso(),
      queuedAt: toIso(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      interruptedReason: null,
      pid: null,
      paths: { runDir },
      logs: [],
      logCount: 0,
      artifacts: [],
      summary: null,
      tests: [],
      process: null,
      cancelRequested: false,
    };

    this.runs.set(runId, run);
    this.queue.push(runId);
    this.sortQueue();
    await this.persist(run);

    // Drain inline so the response reports what actually happened: a run that
    // got a free slot comes back as "running" with its pid, rather than
    // "queued" until a microtask fires. Concurrent creates are safe because the
    // slot is claimed synchronously right after the queue shift.
    await this.drainNow();
    return this.serializeRun(run);
  }

  // Copies the script next to the run record and records its hash.
  async snapshotScript(runDir, script) {
    const snapshotDir = path.join(runDir, RUN_SCRIPT_SNAPSHOT_DIR);
    await ensureDir(snapshotDir);

    const { files, unresolved } = await collectScriptBundle(this.options.scriptsDir, script.absolutePath, {
      maxFiles: this.options.maxScriptBundleFiles,
      maxBytes: this.options.maxScriptBundleBytes,
    });

    for (const file of files) {
      // Laid out as it is in SCRIPTS_DIR so every relative import still
      // resolves, and so a key with a directory keeps its path.
      const target = resolveWithin(snapshotDir, file.relativePath, "script snapshot path");
      await ensureDir(path.dirname(target));
      await fsPromises.writeFile(target, file.content, "utf8");
    }

    const entry = files[0];
    const snapshotPath = resolveWithin(snapshotDir, entry.relativePath, "script snapshot path");
    if (unresolved.length) {
      console.warn(
        `[run] ${script.scriptKey}: could not resolve `
        + unresolved.map((miss) => `${miss.specifier} (from ${miss.from})`).join(", "),
      );
    }

    return cleanObject({
      scriptKey: script.scriptKey,
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      // The pin only means something if it covers everything the run loads: a
      // helper edited between two runs would otherwise be invisible.
      bundleSha256: sha256Hex(files.map((file) => `${file.relativePath}:${file.sha256}`).sort().join("\n")),
      files: files.map((file) => ({ relativePath: file.relativePath, sha256: file.sha256, sizeBytes: file.sizeBytes })),
      unresolvedImports: unresolved.length ? unresolved : undefined,
      snapshotPath,
      snapshotDir,
      capturedAt: toIso(),
      git: await this.registry.resolveGitInfo().catch(() => ({ available: false })),
    });
  }

  async retryRun(runId) {
    const original = this.getRun(runId);
    if (!TERMINAL_RUN_STATUSES.has(original.status)) {
      throw new ApiError(409, "RUN_NOT_FINISHED", `Run ${runId} is ${original.status}; cancel it before retrying`);
    }

    const { request, environment } = await this.composeRequest(original.request);
    return this.createRun(request, {
      attempt: (original.attempt ?? 1) + 1,
      retryOf: original.retryOf ?? runId,
      environment,
    });
  }

  async startRun(run) {
    const { runId, request } = run;
    if (!(await fileExists(this.options.playwrightCliPath))) {
      throw new ApiError(
        500,
        "PLAYWRIGHT_CLI_NOT_FOUND",
        `Playwright CLI not found at ${this.options.playwrightCliPath}. Install dependencies first.`,
      );
    }

    // Without this the run would spawn against a missing file and report the
    // unhelpful "no tests found" instead of naming the real problem.
    if (!run.script?.snapshotPath || !(await fileExists(run.script.snapshotPath))) {
      throw new ApiError(
        500,
        "SCRIPT_SNAPSHOT_MISSING",
        `The pinned script snapshot for ${runId} is missing; delete the run and create it again`,
      );
    }

    const runDir = run.paths.runDir;
    const outputDir = path.join(runDir, "test-results");
    const htmlReportDir = path.join(runDir, "html-report");
    const jsonReportPath = path.join(runDir, "report.json");
    const configPath = path.join(runDir, "playwright.config.mjs");

    await ensureDir(runDir);
    await ensureDir(outputDir);

    // The guard has to be listening before the browser launches.
    let proxyUrl = null;
    if (run.network?.allowlist?.length) {
      run.guard = new RunNetworkGuard({
        allowlist: run.network.allowlist,
        maxBlockedEntries: this.options.maxBlockedRequestLogEntries,
      });
      proxyUrl = await run.guard.start();
      run.network.proxyUrl = proxyUrl;
      console.log(`[run] ${runId} network policy active on ${proxyUrl} (${run.network.allowlist.join(", ")})`);
    }

    await fsPromises.writeFile(
      path.join(runDir, RUN_STEP_REPORTER_FILE),
      renderStepReporter(path.join(runDir, RUN_STEPS_FILE)),
      "utf8",
    );
    await fsPromises.writeFile(
      configPath,
      renderPlaywrightConfig({
        scriptsDir: run.script.snapshotDir || path.join(runDir, RUN_SCRIPT_SNAPSHOT_DIR),
        outputDir,
        htmlReportDir,
        jsonReportPath,
        proxyUrl,
      }),
      "utf8",
    );

    // The snapshot is what was pinned when the run was queued; the registry
    // entry may have been edited or deleted since.
    const args = [
      this.options.playwrightCliPath,
      "test",
      run.script.snapshotPath,
      "--config",
      configPath,
    ];

    if (request.project) {
      args.push("--project", request.project);
    }
    if (request.grep) {
      args.push("--grep", request.grep);
    }
    if (request.shard) {
      args.push("--shard", request.shard);
    }

    const env = buildRunEnv({
      PW_PLAYER_RUN_ID: runId,
      PW_PLAYER_SCRIPT_KEY: request.scriptKey,
      PW_PLAYER_TARGET_ENV: request.env || "",
      PW_PLAYER_BASE_URL: request.baseURL || "",
      PW_PLAYER_HEADED: String(Boolean(request.headed)),
      PW_PLAYER_TRACE: request.trace || "on-first-retry",
      PW_PLAYER_VIDEO: request.video || "retain-on-failure",
      PW_PLAYER_SCREENSHOT: request.screenshot || "only-on-failure",
      PW_PLAYER_STORAGE_STATE: request.storageStateRef ? this.resolveStorageState(request.storageStateRef) : "",
      // The resolved values live only here and in the child process, never in
      // run.json or any API response.
      PW_PLAYER_VARIABLES_JSON: JSON.stringify(run.resolvedVariables || {}),
      PW_PLAYER_TIMEOUT_MS: String(request.timeoutMs || 30_000),
    });

    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    run.startedAt = toIso();
    run.pid = child.pid;

    // A hung run would otherwise hold a queue slot forever.
    if (this.options.runTimeoutMs > 0) {
      run.timeoutTimer = setTimeout(() => {
        if (run.process !== child) {
          return;
        }
        run.timedOut = true;
        this.appendLog(
          run,
          "stderr",
          Buffer.from(`playwright-player: run exceeded RUN_TIMEOUT_MS (${this.options.runTimeoutMs}ms) and was killed`, "utf8"),
        );
        child.kill("SIGKILL");
      }, this.options.runTimeoutMs);
      run.timeoutTimer.unref?.();
    }
    run.paths = {
      runDir,
      configPath,
      outputDir,
      htmlReportDir,
      jsonReportPath,
    };
    run.process = child;
    await this.persist(run);

    child.stdout.on("data", (chunk) => {
      this.appendLog(run, "stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.appendLog(run, "stderr", chunk);
    });
    child.on("error", (error) => {
      run.status = "failed";
      run.endedAt = toIso();
      run.exitCode = -1;
      this.appendLog(run, "stderr", Buffer.from(error.message, "utf8"));
      this.persist(run);
      this.drain();
    });
    child.on("close", (code, signal) => {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = null;
      run.exitCode = code;
      run.signal = signal;
      run.endedAt = toIso();
      run.process = null;
      if (run.cancelRequested) {
        run.status = "cancelled";
      } else if (run.timedOut) {
        run.status = "failed";
        run.interruptedReason = `exceeded RUN_TIMEOUT_MS (${this.options.runTimeoutMs}ms)`;
      } else if (code === 0) {
        run.status = "completed";
      } else {
        run.status = "failed";
      }

      // This callback is not awaited by anyone, so a rejection here would take
      // the whole process down as an unhandled rejection.
      (async () => {
        if (run.guard) {
          // Keep the counters and the blocked list; drop the listener.
          run.network = { ...run.network, ...run.guard.summary() };
          await run.guard.stop();
          run.guard = null;
        }
        run.summary = await this.buildSummary(run);
        run.tests = await this.extractTestResults(run);
        await this.deliverNotification(run);
        run.artifacts = (await collectFilesWithMetadata(run.paths.runDir))
          .filter((file) => isRunEvidence(file.relativePath));
        await this.persist(run);
        await this.pruneRuns();
      })().catch((error) => {
        console.error(`[run] post-processing failed runId=${run.runId}`, error);
      }).finally(() => {
        // Free the slot for whatever is waiting.
        this.drain();
      });
    });

    return this.serializeRun(run);
  }

  // Playwright's JSON report is deeply nested; flatten it once at completion so
  // "실패 알림" and "결과 콜백": one outbound POST when the run ends. One attempt
  // with a timeout, and the outcome is recorded on the run so a silent failure
  // to notify is still visible.
  async deliverNotification(run) {
    if (!run.notify) {
      return;
    }
    if (run.notify.on === "failure" && run.status === "completed") {
      return;
    }

    const payload = {
      event: "run.finished",
      service: this.options.serviceName,
      runId: run.runId,
      scriptKey: run.scriptKey,
      status: run.status,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      attempt: run.attempt ?? 1,
      schedule: run.schedule ?? null,
      environment: run.environment?.name ?? null,
      datasetRow: run.datasetRow ?? null,
      summary: run.summary ?? null,
      // The redacted copy: a notification must not be the thing that leaks a
      // credential to a third-party endpoint.
      request: run.request,
      failedTests: (run.tests || [])
        .filter((test) => test.status === "failed")
        .map((test) => ({ title: test.title, project: test.project, error: test.error })),
    };

    const startedAt = monotonicNow();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.notifyTimeoutMs);
      timer.unref?.();
      const response = await fetch(run.notify.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(run.notify.headers || {}) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      run.notification = {
        url: run.notify.url,
        attemptedAt: toIso(),
        durationMs: elapsedMs(startedAt),
        status: response.status,
        delivered: response.ok,
      };
      if (!response.ok) {
        console.error(`[run] notification for ${run.runId} returned ${response.status}`);
      }
    } catch (error) {
      run.notification = {
        url: run.notify.url,
        attemptedAt: toIso(),
        durationMs: elapsedMs(startedAt),
        delivered: false,
        error: error.name === "AbortError" ? `timed out after ${this.options.notifyTimeoutMs}ms` : error.message,
      };
      console.error(`[run] notification for ${run.runId} failed: ${run.notification.error}`);
    }
  }

  // ---- schedules ----------------------------------------------------------

  async saveSchedule(name, document) {
    const stored = { ...document };
    delete stored.name;
    if (!stored.request?.scriptKey) {
      throw new ApiError(400, "INVALID_REQUEST", "request.scriptKey is required");
    }

    parseCron(stored.cron);
    if (stored.notify) {
      normalizeNotify(stored.notify, this.options);
    }
    // Fail at save time rather than at 2am.
    this.registry.get(stored.request.scriptKey);
    if (stored.request.environment) {
      await this.environments.get(stored.request.environment);
    }
    if (stored.request.dataset) {
      await this.datasets.get(stored.request.dataset);
    }

    return this.schedules.save(name, { ...stored, enabled: stored.enabled !== false });
  }

  // Fires the schedule's request now, with optional overrides — which is how a
  // deploy pipeline triggers the scenarios that gate a release.
  async triggerSchedule(name, overrides = {}) {
    const schedule = await this.schedules.get(name);
    const merged = {
      ...schedule.request,
      ...overrides,
      variables: { ...(schedule.request.variables || {}), ...(overrides.variables || {}) },
      notify: overrides.notify ?? schedule.notify,
    };

    const { request, environment } = await this.composeRequest(merged);
    const expanded = await this.expandDataset(request);
    const meta = { environment, schedule: schedule.name };
    const runs = [];
    for (const entry of expanded) {
      runs.push(await this.createRun(entry, meta));
    }

    await this.schedules.save(schedule.name, { ...schedule, lastTriggeredAt: toIso() });

    return request.dataset
      ? { schedule: schedule.name, dataset: request.dataset, rowCount: runs.length, runs }
      : { schedule: schedule.name, ...runs[0] };
  }

  startScheduler() {
    if (this.options.scheduleTickMs <= 0) {
      return;
    }

    this.scheduleTimer = setInterval(() => {
      this.tickSchedules().catch((error) => console.error("[schedule] tick failed", error));
    }, this.options.scheduleTickMs);
    this.scheduleTimer.unref?.();
  }

  stopScheduler() {
    clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async tickSchedules() {
    const now = new Date();
    // Minute granularity: the tick runs more often than that, so the fired
    // minute is recorded to stop a schedule firing twice for the same minute.
    const minuteKey = toIso(new Date(
      now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0,
    ));
    const schedules = await this.schedules.list().catch(() => []);

    for (const schedule of schedules) {
      if (schedule.enabled === false || schedule.lastFiredMinute === minuteKey) {
        continue;
      }

      let fields;
      try {
        fields = parseCron(schedule.cron);
      } catch (error) {
        console.error(`[schedule] ${schedule.name} has an invalid cron: ${error.message}`);
        continue;
      }

      if (!cronMatches(fields, now)) {
        continue;
      }

      // Recorded before running, so a crash mid-run cannot re-fire the minute.
      await this.schedules.save(schedule.name, { ...schedule, lastFiredMinute: minuteKey });
      try {
        const result = await this.triggerSchedule(schedule.name);
        console.log(`[schedule] ${schedule.name} fired: ${result.runId || `${result.rowCount} runs`}`);
      } catch (error) {
        const message = toApiError(error).message;
        console.error(`[schedule] ${schedule.name} could not run: ${message}`);
        await this.schedules.save(schedule.name, {
          ...schedule,
          lastFiredMinute: minuteKey,
          lastError: { at: toIso(), message },
        });
      }
    }
  }

  // stored history can be queried without re-parsing the whole report.
  async extractTestResults(run) {
    if (!run.paths?.runDir) {
      return [];
    }

    const report = run.paths.jsonReportPath ? await readJsonFile(run.paths.jsonReportPath) : null;
    if (!report?.suites) {
      return [];
    }

    // Written by the generated step reporter; keyed by the same id the json
    // report calls spec.id.
    const stepsBySpecId = (await readJsonFile(path.join(run.paths.runDir, RUN_STEPS_FILE))) || {};

    const tests = [];
    const walk = (suites, titlePath) => {
      for (const suite of suites || []) {
        const nextPath = suite.title ? [...titlePath, suite.title] : titlePath;
        for (const spec of suite.specs || []) {
          for (const test of spec.tests || []) {
            const last = test.results?.[test.results.length - 1];
            tests.push(cleanObject({
              title: [...nextPath, spec.title].filter(Boolean).join(" > "),
              project: test.projectName || undefined,
              status: last?.status ?? test.status ?? "unknown",
              expectedStatus: test.expectedStatus,
              durationMs: last?.duration ?? null,
              retries: Math.max((test.results?.length ?? 1) - 1, 0),
              file: spec.file || suite.file || undefined,
              line: spec.line,
              error: last?.error?.message ? truncate(last.error.message, 2000) : undefined,
              // Playwright records a step per click/fill/assert with its own
              // duration. Without these a "test took 12s" tells you nothing
              // about which step was slow or which one failed.
              steps: stepsBySpecId[spec.id]?.steps
                // Fallback for a record written before the step reporter existed.
                ?? flattenReportSteps(last?.steps),
              // The screenshot, video and trace Playwright attached to this
              // test, as paths relative to the run directory so they can be
              // fetched through the run artifact route.
              attachments: (last?.attachments || []).map((attachment) => cleanObject({
                name: attachment.name,
                contentType: attachment.contentType,
                path: attachment.path
                  ? path.relative(run.paths.runDir, attachment.path).split(path.sep).join("/")
                  : undefined,
              })).filter((attachment) => attachment.path),
            }));
          }
        }
        walk(suite.suites, nextPath);
      }
    };
    walk(report.suites, []);
    return tests;
  }

  async buildSummary(run) {
    const report = run.paths.jsonReportPath ? await readJsonFile(run.paths.jsonReportPath) : null;
    const artifacts = await this.listArtifacts(run.runId).catch(() => []);
    if (!report) {
      return {
        runId: run.runId,
        status: run.status,
        exitCode: run.exitCode,
        artifactCount: artifacts.length,
      };
    }

    return {
      runId: run.runId,
      status: run.status,
      exitCode: run.exitCode,
      stats: report.stats,
      suites: report.suites?.length ?? 0,
      errors: report.errors?.length ?? 0,
      artifactCount: artifacts.length,
    };
  }

  resolveStorageState(reference) {
    return resolveWithin(this.options.storageStateDir, reference, "storageStateRef");
  }

  async validateScript(request) {
    const validationId = createId("validation");
    const validationDir = path.join(this.options.runsDir, validationId);
    await ensureDir(validationDir);

    let targetPath;
    if (request.content) {
      // Only the bare file name is honoured; a caller-supplied path would
      // otherwise let `filename` write anywhere on disk.
      const fileName = safeFilename(path.basename(String(request.filename || "inline.spec.js")));
      const validFileName = SCRIPT_EXTENSION_PATTERN.test(fileName) ? fileName : "inline.spec.js";
      targetPath = path.join(validationDir, validFileName);
      await fsPromises.writeFile(targetPath, request.content, "utf8");
    } else if (request.scriptKey) {
      targetPath = this.registry.get(request.scriptKey).absolutePath;
    } else if (request.scriptPath) {
      targetPath = resolveWithin(this.options.scriptsDir, request.scriptPath, "scriptPath");
      if (!(await fileExists(targetPath))) {
        throw new ApiError(404, "SCRIPT_NOT_FOUND", `Script not found: ${request.scriptPath}`);
      }
    } else {
      throw new ApiError(400, "INVALID_REQUEST", "scriptKey, scriptPath, or content is required");
    }

    // `--list` loads the test file, which runs its module scope. That is test
    // discovery, not a static check, so it is opt-out-able and the cheap,
    // side-effect-free parse is available as its own mode.
    const mode = request.mode === "syntax" ? "syntax" : "discover";
    if (mode === "syntax") {
      return this.checkSyntax(validationDir, targetPath, validationId);
    }

    const configPath = path.join(validationDir, "playwright.config.mjs");
    const jsonReportPath = path.join(validationDir, "report.json");
    const htmlReportDir = path.join(validationDir, "html-report");
    const outputDir = path.join(validationDir, "test-results");
    await fsPromises.writeFile(
      configPath,
      renderPlaywrightConfig({
        scriptsDir: path.dirname(targetPath),
        outputDir,
        htmlReportDir,
        jsonReportPath,
      }),
      "utf8",
    );

    const args = [
      this.options.playwrightCliPath,
      "test",
      targetPath,
      "--config",
      configPath,
      "--list",
      "--pass-with-no-tests",
    ];
    if (request.project) {
      args.push("--project", request.project);
    }
    if (request.grep) {
      args.push("--grep", request.grep);
    }

    try {
      const result = await runCommand(process.execPath, args, rootDir, {
        timeoutMs: this.options.validationTimeoutMs,
        maxOutputBytes: this.options.commandOutputLimitBytes,
        env: buildRunEnv(),
      }).catch((error) => ({
        stdout: "",
        stderr: error.message,
        code: 1,
      }));

      return {
        valid: result.code === 0,
        mode,
        // Callers need to know this was not a static check.
        executesModuleScope: true,
        validationId,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: Boolean(result.truncated),
      };
    } finally {
      // Validation is throwaway work; leaving the scratch directory behind made
      // data/runs grow on every assist_scaffold call.
      await removeDir(validationDir);
    }
  }

  // Parse-only check: never loads or executes the file.
  async checkSyntax(validationDir, targetPath, validationId) {
    try {
      const extension = path.extname(targetPath).toLowerCase();
      if (![".js", ".mjs", ".cjs"].includes(extension)) {
        return {
          valid: null,
          mode: "syntax",
          executesModuleScope: false,
          validationId,
          stdout: "",
          stderr: `Syntax-only checking is not available for ${extension || "this"} files. Use mode "discover", which loads the file through Playwright.`,
          supported: false,
        };
      }

      const result = await runCommand(process.execPath, ["--check", targetPath], rootDir, {
        timeoutMs: Math.min(this.options.validationTimeoutMs, 15_000),
        maxOutputBytes: this.options.commandOutputLimitBytes,
        env: buildRunEnv(),
      }).catch((error) => ({ stdout: "", stderr: error.message, code: 1 }));

      return {
        valid: result.code === 0,
        mode: "syntax",
        executesModuleScope: false,
        supported: true,
        validationId,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await removeDir(validationDir);
    }
  }

  async cancelRun(runId) {
    const run = this.getRun(runId);

    // A queued run has no process yet; it just leaves the queue.
    if (run.status === "queued") {
      const index = this.queue.indexOf(runId);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      run.status = "cancelled";
      run.cancelRequested = true;
      run.endedAt = toIso();
      await this.persist(run);
      return { runId, status: "cancelled" };
    }

    if (!run.process) {
      return {
        runId,
        status: run.status,
      };
    }

    run.cancelRequested = true;
    await this.persist(run);
    const child = run.process;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (run.process === child) {
        child.kill("SIGKILL");
      }
    }, 10_000);
    killTimer.unref?.();
    return {
      runId,
      status: "cancelling",
    };
  }

  async listArtifacts(runId) {
    const run = this.getRun(runId);
    if (!run.paths.runDir) {
      return [];
    }

    const files = await collectFilesWithMetadata(run.paths.runDir);
    return files.filter((file) => isRunEvidence(file.relativePath));
  }

  async getReport(runId) {
    const run = this.getRun(runId);
    if (!run.tests?.length && TERMINAL_RUN_STATUSES.has(run.status)) {
      run.tests = await this.extractTestResults(run);
    }

    return {
      ...this.serializeRun(run),
      report: run.paths.jsonReportPath ? await readJsonFile(run.paths.jsonReportPath) : null,
      summary: run.summary || (await this.buildSummary(run)),
    };
  }

  // In-memory logs are capped and are empty for a run restored from disk, so
  // fall back to the append-only file.
  async getLogs(runId, options = {}) {
    const run = this.getRun(runId);
    const wantsAll = options.source === "file" || !run.logs.length;
    let logs = run.logs;
    let source = "memory";

    if (wantsAll && run.paths?.runDir) {
      const filePath = path.join(run.paths.runDir, RUN_LOG_FILE);
      const raw = await fsPromises.readFile(filePath, "utf8").catch(() => null);
      if (raw !== null) {
        logs = raw.split("\n").filter(Boolean).flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
        source = "file";
      }
    }

    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 20_000);
    return {
      runId,
      status: run.status,
      source,
      totalCount: run.logCount ?? logs.length,
      logs: logs.slice(-limit),
    };
  }

  async deleteRun(runId) {
    const run = this.getRun(runId);
    if (run.status === "running" || run.status === "queued") {
      throw new ApiError(409, "RUN_STILL_RUNNING", `Run is ${run.status}; cancel it before deleting`);
    }

    this.pendingWrites.delete(runId);

    this.runs.delete(runId);
    if (run.paths.runDir) {
      await removeDir(run.paths.runDir);
    }
    return { deleted: runId };
  }

  // Resolves an artifact path reported by listArtifacts back to a file inside
  // the run directory so artifacts can actually be downloaded.
  async resolveArtifactPath(runId, relativePath) {
    const run = this.getRun(runId);
    if (!run.paths.runDir) {
      throw new ApiError(409, "RUN_NOT_STARTED", `Run ${runId} has not produced any output yet`);
    }
    const absolutePath = resolveWithin(run.paths.runDir, relativePath, "artifact path");
    if (!isRunEvidence(path.relative(run.paths.runDir, absolutePath).split(path.sep).join("/"))) {
      throw new ApiError(
        400,
        "NOT_AN_ARTIFACT",
        `${relativePath} is run bookkeeping; use GET /runs/{runId} or /runs/{runId}/logs instead`,
      );
    }
    const stats = await statOrNull(absolutePath);
    if (!stats || !stats.isFile()) {
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Run artifact not found: ${relativePath}`);
    }

    return { absolutePath, fileName: path.basename(absolutePath) };
  }

  async killAll() {
    for (const run of this.runs.values()) {
      clearTimeout(run.timeoutTimer);
      if (run.guard) {
        await run.guard.stop().catch(() => undefined);
        run.guard = null;
      }
      if (run.process) {
        run.process.kill("SIGKILL");
        run.status = "interrupted";
        run.endedAt = toIso();
        run.interruptedReason = "server shut down";
        this.persist(run);
      }
    }

    await this.flushWrites();
  }
}

function sanitizeScriptKey(value) {
  const rawSegments = String(value || "generated/test")
    .split(/[\\/]+/)
    .filter(Boolean);
  const normalized = rawSegments
    .map((segment, index) => {
      const cleaned = index === rawSegments.length - 1
        ? segment.replace(/(\.spec|\.test|\.pw)?\.[^.]+$/i, "")
        : segment;
      return safeFilename(cleaned).toLowerCase();
    })
    .filter(Boolean)
    .join("/");

  return normalized || "generated/test";
}

function deriveTestName(goal, fallback = "generated test") {
  const source = String(goal || fallback).trim();
  if (!source) {
    return "generated test";
  }

  return source
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s/@:_-]+/gu, "")
    .trim()
    .slice(0, 120) || "generated test";
}

function deriveScriptKeyFromGoal(goal) {
  const tokens = String(goal || "generated test")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 2)
    .slice(0, 6);

  if (!tokens.length) {
    return "generated/test";
  }

  if (tokens.length === 1) {
    return `generated/${tokens[0]}`;
  }

  return `${tokens[0]}/${tokens.slice(1).join("-")}`;
}

function deriveTagsFromGoal(goal) {
  const lower = String(goal || "").toLowerCase();
  const tags = [];

  if (/(smoke|스모크)/.test(lower)) {
    tags.push("@smoke");
  }
  if (/(login|signin|sign-in|로그인)/.test(lower)) {
    tags.push("@auth");
  }
  if (/(checkout|order|purchase|결제|주문)/.test(lower)) {
    tags.push("@checkout");
  }
  if (/(chat|message|thread|채팅|메시지)/.test(lower)) {
    tags.push("@chat");
  }
  if (/(search|검색)/.test(lower)) {
    tags.push("@search");
  }

  return [...new Set(tags)];
}

function renderJsValue(value) {
  if (value === undefined) {
    return "undefined";
  }

  const pattern = parseRegexLiteral(value);
  if (pattern) {
    return String(pattern);
  }

  return JSON.stringify(value);
}

function renderLocatorCode(locator, target = "page") {
  if (!locator || typeof locator !== "object") {
    throw new ApiError(400, "INVALID_LOCATOR", "locator must be an object");
  }

  let expression;
  if (locator.role) {
    const options = cleanObject({
      name: locator.name,
      exact: locator.exact,
      checked: locator.checked,
      disabled: locator.disabled,
      expanded: locator.expanded,
      includeHidden: locator.includeHidden,
      level: locator.level,
      pressed: locator.pressed,
      selected: locator.selected,
    });
    expression = Object.keys(options).length
      ? `${target}.getByRole(${renderJsValue(locator.role)}, ${renderJsValue(options)})`
      : `${target}.getByRole(${renderJsValue(locator.role)})`;
  } else if (locator.text) {
    expression = `${target}.getByText(${renderJsValue(locator.text)}, ${renderJsValue(cleanObject({ exact: locator.exact }))})`;
  } else if (locator.label) {
    expression = `${target}.getByLabel(${renderJsValue(locator.label)}, ${renderJsValue(cleanObject({ exact: locator.exact }))})`;
  } else if (locator.placeholder) {
    expression = `${target}.getByPlaceholder(${renderJsValue(locator.placeholder)}, ${renderJsValue(cleanObject({ exact: locator.exact }))})`;
  } else if (locator.testId) {
    expression = `${target}.getByTestId(${renderJsValue(locator.testId)})`;
  } else if (locator.altText) {
    expression = `${target}.getByAltText(${renderJsValue(locator.altText)}, ${renderJsValue(cleanObject({ exact: locator.exact }))})`;
  } else if (locator.title) {
    expression = `${target}.getByTitle(${renderJsValue(locator.title)}, ${renderJsValue(cleanObject({ exact: locator.exact }))})`;
  } else if (locator.css) {
    expression = `${target}.locator(${renderJsValue(locator.css)})`;
  } else if (locator.xpath) {
    expression = `${target}.locator(${renderJsValue(`xpath=${locator.xpath}`)})`;
  } else if (locator.selector) {
    expression = `${target}.locator(${renderJsValue(locator.selector)})`;
  } else {
    throw new ApiError(400, "INVALID_LOCATOR", "unsupported locator shape for scaffold rendering");
  }

  if (locator.hasText) {
    expression += `.filter(${renderJsValue({ hasText: locator.hasText })})`;
  }
  // Keep this precedence identical to resolveLocator so a scaffolded script
  // targets the same element as the equivalent live API call.
  if (locator.nth !== undefined) {
    expression += `.nth(${Number(locator.nth)})`;
  } else if (locator.first) {
    expression += ".first()";
  } else if (locator.last) {
    expression += ".last()";
  }

  return expression;
}

// Step values can arrive as `value`/`valueFrom` or, for assertions, as
// `expected`/`expectedFrom`. Both spellings are accepted so a plan produced for
// page_assert scaffolds into working code.
function renderStepValue(step, fields = ["value"]) {
  const candidates = Array.isArray(fields) ? fields : [fields];
  for (const field of candidates) {
    const fromKey = `${field}From`;
    if (typeof step[fromKey] === "string" && step[fromKey]) {
      return `variables[${renderJsValue(step[fromKey])}]`;
    }
  }

  for (const field of candidates) {
    if (step[field] !== undefined) {
      return renderJsValue(step[field]);
    }
  }

  return renderJsValue(undefined);
}

function renderStepCode(step, target = "page") {
  const action = String(step.action || "").trim();
  if (!action) {
    return "  // TODO: define step action";
  }

  switch (action) {
    case "comment":
      return `  // ${String(step.text || step.note || "fill in this step").replace(/\r?\n/g, " ")}`;
    case "goto":
      return `  await ${target}.goto(${renderJsValue(step.url)});`;
    case "click":
      return `  await ${renderLocatorCode(step.locator, target)}.click(${renderJsValue(cleanObject({ button: step.button, clickCount: step.clickCount }))});`;
    case "fill":
      return `  await ${renderLocatorCode(step.locator, target)}.fill(${renderStepValue(step)});`;
    case "press":
      return `  await ${renderLocatorCode(step.locator, target)}.press(${renderJsValue(step.key || "Enter")});`;
    case "hover":
      return `  await ${renderLocatorCode(step.locator, target)}.hover();`;
    case "selectOption":
      return `  await ${renderLocatorCode(step.locator, target)}.selectOption(${renderJsValue(step.values || step.value || step.options)});`;
    case "waitFor":
      if (step.loadState) {
        return `  await ${target}.waitForLoadState(${renderJsValue(step.loadState)});`;
      }
      if (step.url) {
        return `  await ${target}.waitForURL(${renderJsValue(step.url)});`;
      }
      if (step.text) {
        return `  await ${target}.getByText(${renderJsValue(step.text)}, ${renderJsValue(cleanObject({ exact: step.exact }))}).first().waitFor({ state: "visible" });`;
      }
      if (step.locator) {
        return `  await ${renderLocatorCode(step.locator, target)}.waitFor(${renderJsValue(cleanObject({ state: step.state || "visible" }))});`;
      }
      return "  await page.waitForLoadState(\"domcontentloaded\");";
    case "assertVisible":
      return `  await expect(${renderLocatorCode(step.locator, target)}).toBeVisible();`;
    case "assertText": {
      const locatorExpression = renderLocatorCode(step.locator, target);
      const expectedValue = renderStepValue(step, ["expected", "value"]);
      if ((step.match || "contains") === "equals") {
        return `  await expect(${locatorExpression}).toHaveText(${expectedValue});`;
      }
      return `  await expect(${locatorExpression}).toContainText(${expectedValue});`;
    }
    case "assertCount": {
      const locatorExpression = renderLocatorCode(step.locator, target);
      const expectedCount = Number(step.expected ?? step.value);
      if (!Number.isFinite(expectedCount)) {
        throw new ApiError(400, "INVALID_STEP", "assertCount requires a numeric expected value");
      }
      return `  await expect(${locatorExpression}).toHaveCount(${expectedCount});`;
    }
    case "assertUrl": {
      const expectedUrl = renderJsValue(step.expected ?? step.value ?? step.url);
      if ((step.match || "equals") === "contains") {
        return `  expect(${target}.url()).toContain(${expectedUrl});`;
      }
      return `  await expect(${target}).toHaveURL(${expectedUrl});`;
    }
    case "screenshot":
      return `  await ${target}.screenshot(${renderJsValue(cleanObject({ fullPage: step.fullPage ?? true, path: step.path, type: step.type }))});`;
    default:
      return `  // TODO: map unsupported step action "${action}"`;
  }
}

function buildSuggestedSteps(request = {}) {
  if (Array.isArray(request.steps) && request.steps.length) {
    return request.steps;
  }

  const authoringLanguage = resolveAuthoringLanguage(request);
  const copy = getAuthoringCopy(authoringLanguage);
  const goal = String(request.goal || request.request || request.prompt || "").toLowerCase();
  const locators = {
    ...inferLocatorsFromInspection(request),
    ...(request.knownLocators || {}),
    ...(request.locators || {}),
  };
  const expectations = Array.isArray(request.expectations) ? request.expectations : [];
  const steps = [];

  if (request.startUrl || request.baseURL) {
    steps.push({
      action: "goto",
      url: request.startUrl || request.baseURL,
      status: "ready",
    });
  }

  if (/(login|signin|sign-in|로그인)/.test(goal)) {
    steps.push({
      action: locators.username || locators.email ? "fill" : "comment",
      locator: locators.username || locators.email || undefined,
      valueFrom: "username",
      text: copy.needUserName,
      status: locators.username || locators.email ? "ready" : "needs-input",
    });
    steps.push({
      action: locators.password ? "fill" : "comment",
      locator: locators.password || undefined,
      valueFrom: "password",
      text: copy.needPassword,
      status: locators.password ? "ready" : "needs-input",
    });
    steps.push({
      action: locators.submit ? "click" : "comment",
      locator: locators.submit || undefined,
      text: copy.needSubmit,
      status: locators.submit ? "ready" : "needs-input",
    });
  }

  if (/(search|검색)/.test(goal)) {
    steps.push({
      action: locators.searchInput ? "fill" : "comment",
      locator: locators.searchInput || undefined,
      valueFrom: "query",
      text: copy.needSearchInput,
      status: locators.searchInput ? "ready" : "needs-input",
    });
    steps.push({
      action: locators.searchSubmit ? "click" : "comment",
      locator: locators.searchSubmit || undefined,
      text: copy.needSearchSubmit,
      status: locators.searchSubmit ? "ready" : "needs-input",
    });
  }

  if (/(chat|message|thread|채팅|메시지)/.test(goal)) {
    steps.push({
      action: locators.messageInput ? "fill" : "comment",
      locator: locators.messageInput || undefined,
      valueFrom: "message",
      text: copy.needMessageInput,
      status: locators.messageInput ? "ready" : "needs-input",
    });
    steps.push({
      action: locators.sendButton ? "click" : "comment",
      locator: locators.sendButton || undefined,
      text: copy.needSendButton,
      status: locators.sendButton ? "ready" : "needs-input",
    });
  }

  for (const expectation of expectations) {
    if (typeof expectation === "string") {
      steps.push({
        action: "comment",
        text: `${copy.assertExpectation}: ${expectation}`,
        status: "needs-input",
      });
    } else if (expectation?.locator && expectation?.value !== undefined) {
      steps.push({
        action: "assertText",
        locator: expectation.locator,
        value: expectation.value,
        match: expectation.match || "contains",
        status: "ready",
      });
    }
  }

  if (!steps.length) {
    steps.push({
      action: "comment",
      text: copy.noSteps,
      status: "needs-input",
    });
  }

  return steps;
}

class ScriptAssistant {
  constructor(options) {
    this.options = options;
    this.registry = options.registry;
    this.runManager = options.runManager;
  }

  getCapabilities() {
    return {
      purpose: "LLM-friendly Playwright authoring helpers for offline and air-gapped environments.",
      recommendedWorkflow: [
        "assist_plan",
        "session_create",
        "context_create",
        "page_create",
        "page_navigate",
        "page_inspect",
        "assist_scaffold",
        "script_validate",
        "run_create",
      ],
      supportedProjects: ["chromium", "firefox", "webkit"],
      scaffoldSaveSupported: true,
      locatorFields: ["role", "name", "text", "label", "placeholder", "testId", "altText", "title", "css", "xpath", "selector", "hasText", "first", "last", "nth"],
      stepActions: ["goto", "reload", "goBack", "goForward", "click", "fill", "press", "hover", "drag", "selectOption", "waitFor", "assertVisible", "assertText", "assertUrl", "assertCount", "screenshot", "comment"],
      scriptExtensions: [".spec.js", ".spec.ts", ".test.js", ".test.ts", ".pw.js", ".pw.ts"],
      registryScriptCount: this.registry.list().length,
      scriptLanguages: ["js", "ts"],
      inspectionAwarePlanning: true,
      locatorVerification: {
        supported: true,
        description: "page_inspect resolves each candidate against the live DOM and reports matchCount plus locatorStatus. A confidence score alone does not mean the locator is unique.",
        statuses: ["unique", "ambiguous", "not-found"],
      },
      // Scaffolded scripts are plain Playwright files, so they use native
      // JavaScript control flow. This block is about session_execute, where
      // branching is expressed in the step tree instead.
      sessionWorkflow: {
        controlFlow: ["if", "repeat", "forEach", "while", "break", "continue", "approval"],
        description:
          "session_execute steps nest. if/then/else branches on a captured value or on live page state; "
          + "repeat, forEach and while loop, with break and continue; approval stops the workflow for a person. "
          + "A page condition that is simply not true comes back false rather than failing the workflow.",
        approvalFlow: ["session_execute", "session_approvals", "session_approval_decide", "session_execute_resume"],
      },
      examplesAvailable: true,
      authoringLocales: ["ko", "en"],
      browserLanguageAwarePages: ["/", documentationPaths.playground, documentationPaths.runs, "/demo/test-page"],
      stableDemoTestIds: ["primary-action", "status", "message-input", "send-message", "profile-result", "counter-value"],
    };
  }

  examples(request = {}) {
    return buildAssistExamples(resolveAuthoringLanguage(request));
  }

  plan(request = {}) {
    const authoringLanguage = resolveAuthoringLanguage(request);
    const copy = getAuthoringCopy(authoringLanguage);
    const goal = String(request.goal || request.request || request.prompt || request.testName || "").trim();
    const recommendedScriptKey = sanitizeScriptKey(request.scriptKey || deriveScriptKeyFromGoal(goal));
    const testName = request.testName || deriveTestName(goal, recommendedScriptKey.replaceAll("/", " "));
    const suggestedSteps = buildSuggestedSteps(request);
    const tags = [...new Set([...(request.tags || []), ...deriveTagsFromGoal(goal)])];
    const inferredLocators = inferLocatorsFromInspection(request);
    const missingInputs = [];
    const useTypeScript = resolveScriptLanguage(request) === "ts";

    for (const step of suggestedSteps) {
      if (step.status === "needs-input" && step.text) {
        missingInputs.push(step.text);
      }
    }

    const shouldInspectFirst = suggestedSteps.some((step) => step.status === "needs-input");
    return {
      goal,
      testName,
      recommendedScriptKey,
      recommendedFileName: `${recommendedScriptKey.split("/").pop()}.spec.${useTypeScript ? "ts" : "js"}`,
      tags,
      language: authoringLanguage,
      startUrl: request.startUrl || request.baseURL || null,
      storageStateRef: request.storageStateRef || null,
      inferredLocators,
      assumptions: [
        copy.inspectFirst,
        copy.preferStable,
      ],
      missingInputs,
      suggestedSteps,
      suggestedRunRequest: cleanObject({
        scriptKey: recommendedScriptKey,
        project: request.project || "chromium",
        env: request.env,
        baseURL: request.baseURL || request.startUrl,
        grep: tags.length ? tags[0] : undefined,
        storageStateRef: request.storageStateRef,
        variables: request.variables,
      }),
      suggestedMcpSequence: shouldInspectFirst ? [
        "assist_plan",
        "session_create",
        "context_create",
        "page_create",
        "page_navigate",
        "page_inspect",
        "assist_scaffold",
        "script_validate",
      ] : [
        "assist_plan",
        "assist_scaffold",
        "script_validate",
        "run_create",
      ],
    };
  }

  renderScaffold(request = {}) {
    const plan = request.plan || this.plan(request);
    const testName = request.testName || plan.testName;
    const tags = [...new Set([...(request.tags || []), ...(plan.tags || [])])];
    const steps = Array.isArray(request.steps) && request.steps.length ? request.steps : plan.suggestedSteps;
    const useOptions = cleanObject({
      baseURL: request.baseURL || request.startUrl || plan.startUrl || undefined,
      storageState: request.storageStateRef || plan.storageStateRef || undefined,
      locale: request.locale,
      timezoneId: request.timezoneId,
    });
    const scriptTitle = tags.length ? `${tags.join(" ")} ${testName}` : testName;
    const lines = [
      "import { test, expect } from \"@playwright/test\";",
      "",
    ];
    const needsVariables = steps.some((step) => typeof step?.valueFrom === "string" || typeof step?.expectedFrom === "string");

    if (Object.keys(useOptions).length) {
      lines.push(`test.use(${renderJsValue(useOptions)});`);
      lines.push("");
    }

    if ((request.variables && Object.keys(request.variables).length) || needsVariables) {
      // The run API injects values as PW_PLAYER_VARIABLES_JSON. Inlining them as
      // constants meant a scaffolded script ignored whatever the caller passed
      // at run time, so the literal becomes the default and the run wins.
      lines.push(`const defaultVariables = ${JSON.stringify(request.variables || {}, null, 2)};`);
      lines.push("const variables = { ...defaultVariables, ...JSON.parse(process.env.PW_PLAYER_VARIABLES_JSON || \"{}\") };");
      lines.push("");
    }

    lines.push(`test(${renderJsValue(scriptTitle)}, async ({ page }) => {`);
    if (plan.goal) {
      lines.push(`  // Goal: ${plan.goal.replace(/\r?\n/g, " ")}`);
    }
    for (const step of steps) {
      lines.push(renderStepCode(step));
    }
    lines.push("});");

    return lines.join("\n");
  }

  async scaffold(request = {}) {
    const plan = request.plan || this.plan(request);
    const scriptKey = sanitizeScriptKey(request.scriptKey || plan.recommendedScriptKey);
    const useTypeScript = resolveScriptLanguage(request) === "ts";
    const relativePath = `${scriptKey}.spec.${useTypeScript ? "ts" : "js"}`;
    const fileName = path.basename(relativePath);
    const content = this.renderScaffold({
      ...request,
      plan,
    });

    let savedScript = null;
    if (request.save) {
      savedScript = await this.saveScript(relativePath, content, request.overwrite);
    }

    const validation = request.validate === false ? null : await this.runManager.validateScript({
      content,
      filename: fileName,
      project: request.project,
      grep: request.grep,
    });

    return {
      plan,
      scriptKey,
      language: useTypeScript ? "ts" : "js",
      relativePath,
      content,
      savedScript,
      validation,
    };
  }

  async saveScript(relativePath, content, overwrite = false) {
    const normalizedRelativePath = relativePath
      .split("/")
      .map((segment, index, parts) => {
        if (index === parts.length - 1) {
          const extension = segment.toLowerCase().endsWith(".ts") ? "ts" : "js";
          const fileName = safeFilename(segment.replace(/(\.spec|\.test|\.pw)?\.[^.]+$/i, "")) || "generated";
          return `${fileName}.spec.${extension}`;
        }
        return safeFilename(segment).toLowerCase();
      })
      .filter(Boolean)
      .join("/");

    const absolutePath = path.resolve(this.options.scriptsDir, normalizedRelativePath);
    const scriptsRoot = path.resolve(this.options.scriptsDir);
    if (!absolutePath.startsWith(scriptsRoot)) {
      throw new ApiError(400, "INVALID_SCRIPT_PATH", "scaffold path must stay within the scripts directory");
    }
    if ((await fileExists(absolutePath)) && !overwrite) {
      throw new ApiError(409, "SCRIPT_ALREADY_EXISTS", `Script already exists: ${normalizedRelativePath}`);
    }

    await ensureDir(path.dirname(absolutePath));
    await fsPromises.writeFile(absolutePath, content, "utf8");
    await this.registry.refresh();

    const scriptKey = normalizedRelativePath.replace(/(\.spec|\.test|\.pw)?\.[^.]+$/, "");
    return this.registry.get(scriptKey);
  }
}

function normalizePattern(value) {
  if (!value || typeof value !== "string") {
    return value;
  }

  return parseRegexLiteral(value) ?? value;
}

function resolveLocator(page, locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    throw new ApiError(400, "INVALID_LOCATOR", "locator must be an object");
  }

  let result;
  if (locator.role) {
    result = page.getByRole(locator.role, {
      name: locator.name,
      exact: locator.exact,
      checked: locator.checked,
      disabled: locator.disabled,
      expanded: locator.expanded,
      includeHidden: locator.includeHidden,
      level: locator.level,
      pressed: locator.pressed,
      selected: locator.selected,
    });
  } else if (locator.text) {
    result = page.getByText(locator.text, { exact: locator.exact });
  } else if (locator.label) {
    result = page.getByLabel(locator.label, { exact: locator.exact });
  } else if (locator.placeholder) {
    result = page.getByPlaceholder(locator.placeholder, { exact: locator.exact });
  } else if (locator.testId) {
    result = page.getByTestId(locator.testId);
  } else if (locator.altText) {
    result = page.getByAltText(locator.altText, { exact: locator.exact });
  } else if (locator.title) {
    result = page.getByTitle(locator.title, { exact: locator.exact });
  } else if (locator.css) {
    result = page.locator(locator.css);
  } else if (locator.xpath) {
    result = page.locator(`xpath=${locator.xpath}`);
  } else if (locator.selector) {
    result = page.locator(locator.selector);
  } else {
    throw new ApiError(
      400,
      "INVALID_LOCATOR",
      "locator must include role, text, label, placeholder, testId, altText, title, css, xpath, or selector",
    );
  }

  if (locator.hasText) {
    result = result.filter({ hasText: locator.hasText });
  }
  if (locator.nth !== undefined) {
    result = result.nth(locator.nth);
  } else if (locator.first) {
    result = result.first();
  } else if (locator.last) {
    result = result.last();
  }

  return result;
}

// Statuses that mean "the caller sent something wrong" rather than "the page
// misbehaved". Only the latter is worth capturing artifacts for.
const BAD_REQUEST_STATUS_CODES = new Set([400, 401, 403, 404, 409, 413, 429]);

// Playwright evaluates a *string* as a plain expression and does not invoke it,
// so `"() => document.title"` - the form every example and LLM reaches for -
// evaluated to a function object and came back as `undefined` with no error.
// Wrapping it in an IIFE calls the function when there is one, returns the value
// when there is not, and forwards `arg` either way. It stays a plain expression,
// so it does not need `unsafe-eval` in the page's CSP.
function buildEvaluateExpression(expression, arg) {
  let serializedArg;
  try {
    serializedArg = arg === undefined ? "undefined" : JSON.stringify(arg);
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "arg must be JSON-serializable");
  }

  return `((__pwPlayerArg) => {
  const __pwPlayerValue = (${expression});
  return typeof __pwPlayerValue === "function" ? __pwPlayerValue(__pwPlayerArg) : __pwPlayerValue;
})(${serializedArg})`;
}

const ALLOWED_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

// Reads a dotted path out of a parsed JSON body, so a caller can assert on
// `data.order.referenceNumber` without pulling the whole document back.
// A reference number read off the page has to be usable by a later step, and in
// an `execute` batch the caller does not see intermediate results until the whole
// batch returns. `{{name}}` is substituted from values captured by earlier steps.
// A forEach row is usually an object, so `{{row.email}}` has to reach into it.
// A literal key still wins, so a bag that already holds "a.b" keeps working.
function lookupCaptured(captured, name) {
  if (name in captured) {
    return { found: true, value: captured[name] };
  }

  if (name.includes(".")) {
    const [head, ...rest] = name.split(".");
    if (head in captured) {
      return { found: true, value: readJsonPath(captured[head], rest.join(".")) };
    }
  }

  return { found: false };
}

function substituteCaptured(value, captured, options = {}, seen = new Set()) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) => {
      const hit = lookupCaptured(captured, name);
      if (!hit.found) {
        throw new ApiError(
          400,
          "UNKNOWN_CAPTURED_VALUE",
          `${match} refers to a value no earlier step captured. Captured so far: ${Object.keys(captured).join(", ") || "(none)"}`,
        );
      }

      const replacement = hit.value;
      // Capturing right after a click often reads the element before the page
      // has filled it in. Substituting "" silently produced things like
      // "/api/orders/" and a confusing 404 instead of naming the real problem.
      if (replacement === null || replacement === undefined || replacement === "") {
        // A condition may be asking whether the value is empty, which is a
        // legitimate question rather than the mistake above.
        if (options.allowEmpty) {
          return "";
        }
        throw new ApiError(
          422,
          "EMPTY_CAPTURED_VALUE",
          `${match} was captured empty. The step that captured it probably ran before the page produced the value — `
          + "assert the expected state first (assertText or waitFor), then capture.",
          { name, captured },
        );
      }

      return typeof replacement === "object" ? JSON.stringify(replacement) : String(replacement);
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => substituteCaptured(entry, captured, options, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteCaptured(entry, captured, options, seen)]),
    );
  }

  return value;
}

// What a step contributes to the captured-value bag.
function pickCapturedValue(action, result, step) {
  if (step.savePath) {
    const source = action === "apiRequest" ? result?.json : result;
    return readJsonPath(source, step.savePath);
  }

  switch (action) {
    case "locatorQuery":
      return result?.value ?? result?.count ?? result?.values;
    case "apiRequest":
      return result?.json ?? result?.text;
    case "assertText":
    case "assertUrl":
      return result?.actual ?? result?.url;
    default:
      return result;
  }
}

function readJsonPath(value, jsonPath) {
  if (!jsonPath) {
    return value;
  }

  let current = value;
  for (const rawKey of String(jsonPath).split(".")) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const key = rawKey.trim();
    const index = Number(key);
    current = Array.isArray(current) && Number.isInteger(index) ? current[index] : current[key];
  }

  return current;
}

// Assertions about the outcome rather than the screen: an HTTP status, a value
// inside a JSON body, a captured reference number, or a downloaded file.
function assertApiResponse(response, step) {
  if (step.status !== undefined && Number(response.status) !== Number(step.status)) {
    throw new ApiError(
      422,
      "API_ASSERTION_FAILED",
      `expected HTTP ${step.status}, got ${response.status} ${response.statusText} for ${response.method} ${response.url}`,
      { status: response.status, expected: Number(step.status) },
    );
  }
  if (step.ok === true && !response.ok) {
    throw new ApiError(
      422,
      "API_ASSERTION_FAILED",
      `expected a 2xx response, got ${response.status} for ${response.method} ${response.url}`,
      { status: response.status },
    );
  }

  if (step.jsonPath !== undefined) {
    if (response.json === undefined) {
      throw new ApiError(422, "API_ASSERTION_FAILED", "response body is not JSON, so jsonPath cannot be read", {
        bodyPreview: truncate(response.text, 300),
      });
    }

    const actual = readJsonPath(response.json, step.jsonPath);
    const expected = step.expected ?? step.value;
    if (expected !== undefined) {
      const matched = typeof expected === "string" || typeof actual === "string"
        ? textMatches(actual, normalizePattern(expected), step.match || "equals")
        : JSON.stringify(actual) === JSON.stringify(expected);
      if (!matched) {
        throw new ApiError(
          422,
          "API_ASSERTION_FAILED",
          `${step.jsonPath} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (${step.match || "equals"})`,
          { jsonPath: step.jsonPath, actual, expected },
        );
      }
    } else if (actual === undefined || actual === null) {
      throw new ApiError(422, "API_ASSERTION_FAILED", `${step.jsonPath} is missing from the response body`, {
        jsonPath: step.jsonPath,
        bodyPreview: truncate(response.text, 300),
      });
    }
  }

  if (step.bodyContains !== undefined && !String(response.text).includes(String(step.bodyContains))) {
    throw new ApiError(422, "API_ASSERTION_FAILED", `response body does not contain ${JSON.stringify(step.bodyContains)}`, {
      bodyPreview: truncate(response.text, 300),
    });
  }
}

function assertCapturedValue(step) {
  const expected = step.expected ?? step.pattern;
  if (expected === undefined) {
    throw new ApiError(400, "INVALID_REQUEST", "assertValue needs expected (or pattern)");
  }
  if (step.value === undefined) {
    throw new ApiError(400, "INVALID_REQUEST", "assertValue needs value, usually a {{captured}} reference");
  }

  if (!textMatches(step.value, normalizePattern(expected), step.match || "equals")) {
    throw new ApiError(
      422,
      "VALUE_ASSERTION_FAILED",
      `captured value was ${JSON.stringify(step.value)}, expected ${JSON.stringify(expected)} (${step.match || "equals"})`,
      { actual: step.value, expected },
    );
  }
}

const DIALOG_ACTIONS = new Set(["accept", "dismiss", "ignore"]);

function normalizeDialogPolicy(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const raw = typeof value === "string" ? { action: value } : value;
  const action = String(raw.action || "").toLowerCase();
  if (!DIALOG_ACTIONS.has(action)) {
    throw new ApiError(
      400,
      "INVALID_DIALOG_POLICY",
      `dialogPolicy.action must be one of accept, dismiss, ignore (got ${raw.action})`,
    );
  }

  return {
    action,
    promptText: typeof raw.promptText === "string" ? raw.promptText : fallback?.promptText ?? "",
  };
}

function countMatches(actual, expected, operator) {
  switch (operator) {
    case "gte":
      return actual >= expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "lt":
      return actual < expected;
    case "eq":
    default:
      return actual === expected;
  }
}

function textMatches(actual, expected, mode = "contains") {
  if (expected instanceof RegExp) {
    return expected.test(actual);
  }

  const normalizedActual = String(actual ?? "");
  const normalizedExpected = String(expected ?? "");
  switch (mode) {
    case "equals":
      return normalizedActual === normalizedExpected;
    case "startsWith":
      return normalizedActual.startsWith(normalizedExpected);
    case "endsWith":
      return normalizedActual.endsWith(normalizedExpected);
    case "contains":
      return normalizedActual.includes(normalizedExpected);
    default:
      throw new ApiError(
        400,
        "INVALID_MATCH_MODE",
        `Unsupported match mode: ${mode}. Use contains, equals, startsWith, or endsWith.`,
      );
  }
}

// Playwright signals "the state never arrived" with a TimeoutError. For an
// assertion that is a failure; for a condition it is simply the answer "no".
function isTimeoutError(error) {
  return error?.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(error?.message || "");
}

async function poll(timeoutMs, fn, onTimeoutMessage) {
  const startedAt = monotonicNow();
  do {
    if (await fn()) {
      return;
    }
    await sleep(200);
  } while (monotonicNow() - startedAt < timeoutMs);

  throw new ApiError(408, "TIMEOUT", onTimeoutMessage);
}

// ---------------------------------------------------------------------------
// Workflow control flow
//
// A batch used to be a flat list: every step ran, in order, always. Real office
// work branches — "if the approval banner is up, click it, otherwise fill the
// form" — and repeats over rows of a dataset, and sometimes has to stop and wait
// for a person. These three needs are what the rest of this section covers.
// ---------------------------------------------------------------------------

// A condition comparing `{{row}}` against a list or a number needs the value
// itself, not its stringification, so a reference on its own passes through raw.
const SINGLE_CAPTURED_REFERENCE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

function resolveConditionValue(spec, captured) {
  if (typeof spec === "string") {
    const single = SINGLE_CAPTURED_REFERENCE.exec(spec);
    if (single) {
      const hit = lookupCaptured(captured, single[1]);
      if (!hit.found) {
        throw new ApiError(
          400,
          "UNKNOWN_CAPTURED_VALUE",
          `${spec} refers to a value no earlier step captured. Captured so far: ${Object.keys(captured).join(", ") || "(none)"}`,
        );
      }
      return hit.value;
    }
  }

  return substituteCaptured(spec, captured, { allowEmpty: true });
}

const VALUE_OPERATORS = [
  "equals", "notEquals", "contains", "notContains", "startsWith", "endsWith",
  "matches", "in", "notIn", "gt", "gte", "lt", "lte", "empty", "notEmpty",
];

function isEmptyValue(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }
  return Array.isArray(value) ? value.length === 0 : false;
}

function compareNumeric(operator, actual, expected, label) {
  const left = Number(actual);
  const right = Number(expected);
  // "17" < "9" is true for strings and false for numbers. Guessing which the
  // caller meant is how a quantity check silently passes on the wrong rows.
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new ApiError(
      400,
      "INVALID_CONDITION",
      `${label}: ${operator} compares numbers, but got ${JSON.stringify(actual)} and ${JSON.stringify(expected)}`,
    );
  }

  switch (operator) {
    case "gt": return left > right;
    case "gte": return left >= right;
    case "lt": return left < right;
    default: return left <= right;
  }
}

// An object substituted into a string becomes JSON, so a text comparison
// against one should see the same thing rather than "[object Object]".
function textualForm(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}

const TEXT_CONDITION_OPERATORS = new Set([
  "equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "matches",
]);

function evaluateValueCondition(when, captured, label) {
  const resolved = resolveConditionValue(when.value, captured);
  const used = VALUE_OPERATORS.filter((operator) => operator in when);
  if (!used.length) {
    throw new ApiError(400, "INVALID_CONDITION", `${label}: value needs one of ${VALUE_OPERATORS.join(", ")}`);
  }
  // Two operators in one condition means one of them is being ignored, and the
  // caller cannot tell which.
  if (used.length > 1) {
    throw new ApiError(400, "INVALID_CONDITION", `${label}: use one operator at a time, got ${used.join(" and ")}`);
  }

  const operator = used[0];
  // `in` needs its array and a numeric comparison needs its number, so only the
  // text operators see the JSON form.
  const isTextOperator = TEXT_CONDITION_OPERATORS.has(operator);
  const actual = isTextOperator ? textualForm(resolved) : resolved;
  const rawExpected = operator === "empty" || operator === "notEmpty"
    ? undefined
    : resolveConditionValue(when[operator], captured);
  const expected = isTextOperator ? textualForm(rawExpected) : rawExpected;

  switch (operator) {
    case "empty":
      return when.empty ? isEmptyValue(actual) : !isEmptyValue(actual);
    case "notEmpty":
      return when.notEmpty ? !isEmptyValue(actual) : isEmptyValue(actual);
    case "equals":
      return textMatches(actual, normalizePattern(expected), when.match || "equals");
    case "notEquals":
      return !textMatches(actual, normalizePattern(expected), when.match || "equals");
    case "contains":
      return textMatches(actual, expected, "contains");
    case "notContains":
      return !textMatches(actual, expected, "contains");
    case "startsWith":
      return textMatches(actual, expected, "startsWith");
    case "endsWith":
      return textMatches(actual, expected, "endsWith");
    case "matches": {
      // Letting `matches: "ORD"` fall back to a substring test would make a typo
      // in the delimiters quietly loosen the condition instead of failing.
      const pattern = parseRegexLiteral(expected);
      if (!pattern) {
        throw new ApiError(
          400,
          "INVALID_CONDITION",
          `${label}: matches needs a regular expression literal such as /^ORD-\\d+$/i, got ${JSON.stringify(expected)}. `
          + "Use contains or equals for plain text.",
        );
      }
      return pattern.test(String(actual ?? ""));
    }
    case "in":
    case "notIn": {
      if (!Array.isArray(expected)) {
        throw new ApiError(400, "INVALID_CONDITION", `${label}: ${operator} needs an array, got ${JSON.stringify(expected)}`);
      }
      const hit = expected.some((entry) => String(entry) === String(actual));
      return operator === "in" ? hit : !hit;
    }
    default:
      return compareNumeric(operator, actual, expected, label);
  }
}

// `probe` answers the page-state conditions. It is passed in so this stays
// testable without a browser, and so a false condition never needs an exception.
async function evaluateCondition(when, captured, probe, label = "when") {
  if (!when || typeof when !== "object" || Array.isArray(when)) {
    throw new ApiError(400, "INVALID_CONDITION", `${label} must be an object`);
  }

  if (Array.isArray(when.all)) {
    for (const [index, entry] of when.all.entries()) {
      if (!(await evaluateCondition(entry, captured, probe, `${label}.all[${index}]`))) {
        return false;
      }
    }
    return true;
  }

  if (Array.isArray(when.any)) {
    for (const [index, entry] of when.any.entries()) {
      if (await evaluateCondition(entry, captured, probe, `${label}.any[${index}]`)) {
        return true;
      }
    }
    return false;
  }

  if (when.not !== undefined) {
    return !(await evaluateCondition(when.not, captured, probe, `${label}.not`));
  }

  if (when.locator || when.url !== undefined || when.loadState) {
    if (!probe) {
      throw new ApiError(400, "INVALID_CONDITION", `${label}: locator, url and loadState conditions need a page`);
    }
    return probe(substituteCaptured(when, captured, { allowEmpty: true }), label);
  }

  if ("value" in when) {
    return evaluateValueCondition(when, captured, label);
  }

  throw new ApiError(
    400,
    "INVALID_CONDITION",
    `${label} needs one of value, locator, url, loadState, all, any, or not`,
  );
}

// Whether a condition is well formed does not depend on any runtime value, so
// it is checked while compiling. A workflow with a malformed condition then
// fails immediately and without a browser, instead of halfway through the run.
function validateConditionShape(when, label) {
  if (!when || typeof when !== "object" || Array.isArray(when)) {
    throw new ApiError(400, "INVALID_CONDITION", `${label} must be an object`);
  }

  if (Array.isArray(when.all) || Array.isArray(when.any)) {
    const key = Array.isArray(when.all) ? "all" : "any";
    if (!when[key].length) {
      throw new ApiError(400, "INVALID_CONDITION", `${label}.${key} must not be empty`);
    }
    when[key].forEach((entry, index) => validateConditionShape(entry, `${label}.${key}[${index}]`));
    return;
  }
  if (when.not !== undefined) {
    validateConditionShape(when.not, `${label}.not`);
    return;
  }
  if (when.locator || when.url !== undefined || when.loadState) {
    return;
  }

  if (!("value" in when)) {
    throw new ApiError(
      400,
      "INVALID_CONDITION",
      `${label} needs one of value, locator, url, loadState, all, any, or not`,
    );
  }

  const used = VALUE_OPERATORS.filter((operator) => operator in when);
  if (!used.length) {
    throw new ApiError(400, "INVALID_CONDITION", `${label}: value needs one of ${VALUE_OPERATORS.join(", ")}`);
  }
  if (used.length > 1) {
    throw new ApiError(400, "INVALID_CONDITION", `${label}: use one operator at a time, got ${used.join(" and ")}`);
  }
  // A pattern built from a {{reference}} can only be checked once it is
  // substituted; a literal one is checkable now.
  if (used[0] === "matches" && typeof when.matches === "string" && !when.matches.includes("{{")
    && !parseRegexLiteral(when.matches)) {
    throw new ApiError(
      400,
      "INVALID_CONDITION",
      `${label}: matches needs a regular expression literal such as /^ORD-\\d+$/i, got ${JSON.stringify(when.matches)}. `
      + "Use contains or equals for plain text.",
    );
  }
}

const CONTROL_FLOW_ACTIONS = new Set(["if", "repeat", "forEach", "while", "break", "continue", "approval"]);
const MAX_WORKFLOW_DEPTH = 8;
const MAX_WORKFLOW_INSTRUCTIONS = 2000;

// The step tree is compiled to a flat instruction list with jumps rather than
// walked recursively. A recursive walker cannot be suspended at an approval gate
// and resumed by a later HTTP request; a program counter plus a frame stack is
// plain JSON, so the whole machine state survives the wait.
function compileWorkflow(steps, options = {}) {
  const program = [];
  const maxDepth = options.maxDepth || MAX_WORKFLOW_DEPTH;
  // break and continue need addresses inside a loop that has not finished
  // compiling, so their jumps are collected here and patched on the way out.
  const loopStack = [];
  let gateCount = 0;

  const compileBlock = (block, prefix, depth, label) => {
    if (!Array.isArray(block) || !block.length) {
      throw new ApiError(400, "INVALID_STEP", `${label} must be a non-empty array of steps`);
    }
    if (depth > maxDepth) {
      throw new ApiError(400, "WORKFLOW_TOO_DEEP", `${label} nests deeper than ${maxDepth} levels`);
    }
    block.forEach((step, index) => compileStep(step, `${prefix}${index}`, depth));
  };

  const compileStep = (step, at, depth) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new ApiError(400, "INVALID_STEP", `step ${at} must be an object`);
    }
    if (program.length > MAX_WORKFLOW_INSTRUCTIONS) {
      throw new ApiError(
        400,
        "WORKFLOW_TOO_LARGE",
        `the workflow compiles to more than ${MAX_WORKFLOW_INSTRUCTIONS} instructions`,
      );
    }

    switch (step.action) {
      case "if": {
        validateConditionShape(step.when, `step ${at}.when`);
        const testAt = program.length;
        program.push({ op: "test", at, when: step.when, ifFalse: -1, hasElse: step.else !== undefined });
        compileBlock(step.then, `${at}.then.`, depth + 1, `step ${at}.then`);
        if (step.else !== undefined) {
          const jumpAt = program.length;
          program.push({ op: "jump", at, target: -1 });
          program[testAt].ifFalse = program.length;
          compileBlock(step.else, `${at}.else.`, depth + 1, `step ${at}.else`);
          program[jumpAt].target = program.length;
        } else {
          program[testAt].ifFalse = program.length;
        }
        return;
      }

      case "repeat":
      case "forEach": {
        if (step.action === "repeat" && step.times === undefined) {
          throw new ApiError(400, "INVALID_STEP", `step ${at}: repeat needs times`);
        }
        if (step.action === "forEach" && step.items === undefined) {
          throw new ApiError(400, "INVALID_STEP", `step ${at}: forEach needs items`);
        }
        // A literal count over budget is knowable now. A {{reference}} is not,
        // and is caught by the same limit when the loop starts.
        const literalTimes = Number(step.times);
        if (step.action === "repeat" && Number.isFinite(literalTimes)) {
          const cap = Math.min(Number(step.maxIterations) || WORKFLOW_LIMITS.maxIterations, WORKFLOW_LIMITS.maxIterations);
          if (literalTimes > cap) {
            throw new ApiError(
              400,
              "LOOP_LIMIT_EXCEEDED",
              `step ${at}: ${literalTimes} iterations exceeds the limit of ${cap}. `
              + "Raise maxIterations for this step, or split the work across runs.",
            );
          }
        }
        program.push({
          op: "loopStart",
          at,
          kind: step.action,
          times: step.times,
          items: step.items,
          as: step.as,
          indexAs: step.indexAs,
          maxIterations: step.maxIterations,
        });
        const testAt = program.length;
        program.push({ op: "loopTest", at, end: -1 });
        const frame = { popFrames: 1, breaks: [], continues: [] };
        loopStack.push(frame);
        compileBlock(step.steps, `${at}.${step.action}.`, depth + 1, `step ${at}.steps`);
        loopStack.pop();
        const backAt = program.length;
        program.push({ op: "loopBack", at, target: testAt });
        program[testAt].end = program.length;
        for (const index of frame.breaks) {
          program[index].target = program.length;
        }
        for (const index of frame.continues) {
          program[index].target = backAt;
        }
        return;
      }

      case "while": {
        validateConditionShape(step.when, `step ${at}.when`);
        // The counter is reset on entry, so an enclosing loop running this while
        // loop a second time gets a fresh budget rather than a spent one.
        const slot = `while@${program.length}`;
        program.push({ op: "whileInit", at, slot });
        const testAt = program.length;
        program.push({ op: "whileTest", at, when: step.when, slot, end: -1, maxIterations: step.maxIterations });
        const frame = { popFrames: 0, breaks: [], continues: [] };
        loopStack.push(frame);
        compileBlock(step.steps, `${at}.while.`, depth + 1, `step ${at}.steps`);
        loopStack.pop();
        program.push({ op: "jump", at, target: testAt });
        program[testAt].end = program.length;
        for (const index of frame.breaks) {
          program[index].target = program.length;
        }
        for (const index of frame.continues) {
          program[index].target = testAt;
        }
        return;
      }

      case "break":
      case "continue": {
        const frame = loopStack[loopStack.length - 1];
        if (!frame) {
          throw new ApiError(
            400,
            "INVALID_STEP",
            `step ${at}: ${step.action} is only valid inside repeat, forEach or while`,
          );
        }
        const isBreak = step.action === "break";
        (isBreak ? frame.breaks : frame.continues).push(program.length);
        program.push({
          op: isBreak ? "loopBreak" : "loopContinue",
          at,
          target: -1,
          popFrames: isBreak ? frame.popFrames : 0,
        });
        return;
      }

      case "approval": {
        if (!step.name || typeof step.name !== "string") {
          throw new ApiError(400, "INVALID_STEP", `step ${at}: approval needs a name`);
        }
        gateCount += 1;
        program.push({ op: "gate", at, gate: step });
        return;
      }

      default:
        program.push({ op: "exec", at, step });
    }
  };

  compileBlock(steps, "", 0, "steps");
  return { program, gateCount };
}

const WORKFLOW_LIMITS = {
  maxIterations: config.maxWorkflowIterations,
  maxSteps: config.maxWorkflowSteps,
  maxDurationMs: config.maxWorkflowDurationMs,
};

// A caller may tighten its own budget but not loosen the deployment's. The same
// narrow-only rule the URL allowlist uses: otherwise every limit here is just a
// suggestion a request can opt out of, and one workflow can hold a session for
// an hour.
function normalizeWorkflowLimits(requested) {
  if (requested === undefined || requested === null) {
    return undefined;
  }
  if (typeof requested !== "object" || Array.isArray(requested)) {
    throw new ApiError(400, "INVALID_REQUEST", "limits must be an object");
  }

  const narrowed = {};
  for (const key of ["maxIterations", "maxSteps", "maxDurationMs"]) {
    if (requested[key] === undefined) {
      continue;
    }
    const value = Number(requested[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ApiError(400, "INVALID_REQUEST", `limits.${key} must be a positive number`);
    }
    narrowed[key] = Math.min(Math.floor(value), WORKFLOW_LIMITS[key]);
  }

  return Object.keys(narrowed).length ? narrowed : undefined;
}

function newWorkflowState(variables = {}) {
  return { pc: 0, captured: { ...variables }, frames: [], counters: {}, executed: 0, sequence: 0 };
}

async function runWorkflow(program, state, hooks, options = {}) {
  const limits = { ...WORKFLOW_LIMITS, ...(options.limits || {}) };
  const results = options.results || [];
  const startedAtMonotonic = monotonicNow();

  const record = (entry) => {
    results.push(cleanObject({ index: state.sequence, ...entry }));
    state.sequence += 1;
  };

  while (state.pc < program.length) {
    // The batch holds the session lock, so a workflow that loops for an hour
    // would make the session look hung to everyone else.
    if (elapsedMs(startedAtMonotonic) > limits.maxDurationMs) {
      throw new ApiError(408, "WORKFLOW_TIMEOUT", `the workflow ran longer than ${limits.maxDurationMs}ms`);
    }

    const instruction = program[state.pc];
    switch (instruction.op) {
      case "exec": {
        state.executed += 1;
        if (state.executed > limits.maxSteps) {
          throw new ApiError(
            400,
            "WORKFLOW_STEP_BUDGET_EXCEEDED",
            `the workflow ran more than ${limits.maxSteps} steps; check the loop bounds`,
          );
        }
        // Declared outside the try so the catch can still name the step that
        // failed; substitution itself can throw on an unknown {{reference}}.
        let step = instruction.step;
        try {
          step = substituteCaptured(instruction.step, state.captured);
          const result = await hooks.exec(step, instruction.at);
          if (step.saveAs) {
            state.captured[step.saveAs] = pickCapturedValue(step.action, result, step);
          }
          record({ path: instruction.at, action: step.action, status: "ok", saveAs: step.saveAs, result });
        } catch (error) {
          const apiError = toApiError(error);
          record({
            path: instruction.at,
            action: step.action,
            status: "error",
            error: { code: apiError.code, message: apiError.message },
            artifacts: apiError.artifacts,
          });
          if (!options.continueOnError) {
            apiError.details = {
              ...(apiError.details || {}),
              failedStepIndex: state.sequence - 1,
              failedStepPath: instruction.at,
              results,
            };
            throw apiError;
          }
        }
        state.pc += 1;
        break;
      }

      case "test": {
        // A malformed condition is a bad request, not a step failure, so
        // continueOnError must not quietly skip a whole branch over a typo.
        const matched = await evaluateCondition(
          instruction.when,
          state.captured,
          hooks.probe,
          `step ${instruction.at}.when`,
        );
        record({
          path: instruction.at,
          action: "if",
          status: "ok",
          result: { matched, branch: matched ? "then" : (instruction.hasElse ? "else" : "skipped") },
        });
        state.pc = matched ? state.pc + 1 : instruction.ifFalse;
        break;
      }

      case "jump":
        state.pc = instruction.target;
        break;

      case "loopStart": {
        let items = null;
        let count;
        if (instruction.kind === "repeat") {
          count = Number(resolveConditionValue(instruction.times, state.captured));
        } else {
          const resolved = resolveConditionValue(instruction.items, state.captured);
          items = typeof resolved === "string" ? parseJsonArray(resolved, instruction.at) : resolved;
          if (!Array.isArray(items)) {
            throw new ApiError(
              400,
              "INVALID_STEP",
              `step ${instruction.at}: forEach items must be an array, got ${JSON.stringify(resolved)}`,
            );
          }
          count = items.length;
        }

        if (!Number.isInteger(count) || count < 0) {
          throw new ApiError(
            400,
            "INVALID_STEP",
            `step ${instruction.at}: iteration count must be a non-negative whole number, got ${JSON.stringify(count)}`,
          );
        }
        const cap = Math.min(Number(instruction.maxIterations) || limits.maxIterations, limits.maxIterations);
        // Truncating silently would make a 10,000-row dataset look like it ran
        // in full, so an over-budget loop is refused instead.
        if (count > cap) {
          throw new ApiError(
            400,
            "LOOP_LIMIT_EXCEEDED",
            `step ${instruction.at}: ${count} iterations exceeds the limit of ${cap}. `
            + "Raise maxIterations for this step, or split the work across runs.",
          );
        }

        state.frames.push({
          at: instruction.at,
          kind: instruction.kind,
          i: 0,
          total: count,
          items,
          as: instruction.as,
          indexAs: instruction.indexAs,
        });
        state.pc += 1;
        break;
      }

      case "loopTest": {
        const frame = state.frames[state.frames.length - 1];
        if (frame.i >= frame.total) {
          state.frames.pop();
          record({ path: frame.at, action: frame.kind, status: "ok", result: { iterations: frame.i } });
          state.pc = instruction.end;
          break;
        }
        if (frame.as) {
          state.captured[frame.as] = frame.kind === "forEach" ? frame.items[frame.i] : frame.i;
        }
        if (frame.indexAs) {
          state.captured[frame.indexAs] = frame.i;
        }
        state.pc += 1;
        break;
      }

      case "loopBack":
        state.frames[state.frames.length - 1].i += 1;
        state.pc = instruction.target;
        break;

      case "whileInit":
        state.counters[instruction.slot] = 0;
        state.pc += 1;
        break;

      case "whileTest": {
        const cap = Math.min(Number(instruction.maxIterations) || limits.maxIterations, limits.maxIterations);
        const done = state.counters[instruction.slot] ?? 0;
        if (done >= cap) {
          // The condition never went false, which means the page never reached
          // the state the workflow was waiting for. Leaving the loop quietly
          // would report success for work that did not happen.
          throw new ApiError(
            408,
            "LOOP_LIMIT_EXCEEDED",
            `step ${instruction.at}: while ran ${done} iterations without its condition going false`,
          );
        }
        const matched = await evaluateCondition(
          instruction.when,
          state.captured,
          hooks.probe,
          `step ${instruction.at}.when`,
        );
        if (!matched) {
          record({ path: instruction.at, action: "while", status: "ok", result: { iterations: done } });
          state.pc = instruction.end;
          break;
        }
        state.counters[instruction.slot] = done + 1;
        state.pc += 1;
        break;
      }

      case "loopBreak": {
        for (let popped = 0; popped < instruction.popFrames; popped += 1) {
          state.frames.pop();
        }
        record({ path: instruction.at, action: "break", status: "ok" });
        state.pc = instruction.target;
        break;
      }

      case "loopContinue":
        record({ path: instruction.at, action: "continue", status: "ok" });
        state.pc = instruction.target;
        break;

      case "gate":
        // Returning here releases the session lock. Waiting for a person while
        // holding it would block every other request for this session.
        return { status: "awaiting_approval", gateAt: state.pc, gate: instruction.gate, results };

      default:
        throw new ApiError(500, "INVALID_INSTRUCTION", `Unknown workflow instruction ${instruction.op}`);
    }
  }

  return { status: "completed", results };
}

function parseJsonArray(value, at) {
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiError(400, "INVALID_STEP", `step ${at}: forEach items is not a JSON array: ${truncate(value, 120)}`);
  }
}

class SessionManager {
  constructor(options) {
    this.options = {
      ...options,
      defaultDialogPolicy: normalizeDialogPolicy(
        { action: options.defaultDialogAction, promptText: options.defaultDialogPromptText },
        { action: "dismiss", promptText: "" },
      ),
    };
    this.sessions = new Map();
    // Artifacts outlive their session: the files stayed on disk but the only
    // index that could resolve an artifactId was thrown away on close, so
    // evidence collected during a run became unreachable the moment the
    // session ended.
    this.artifactIndex = new Map();
    // Workflows suspended at an approval gate, keyed by gateId. In memory only:
    // the browser page the continuation needs does not survive a restart either.
    this.pendingApprovals = new Map();
    this.pageLookup = new WeakMap();
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        console.error("session cleanup failed", error);
      });
    }, this.options.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async shutdown() {
    clearInterval(this.cleanupTimer);
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        await this.closeSession(sessionId, "shutdown");
      } catch (error) {
        console.error(`failed to close session ${sessionId}`, error);
      }
    }
  }

  serializeSession(session) {
    return {
      sessionId: session.sessionId,
      browserType: session.browserType,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      contextIds: [...session.contexts.keys()],
      pageIds: [...session.pages.keys()],
      artifactCount: session.artifacts.size,
      downloadCount: session.downloads.length,
      actionCount: session.actions.length,
    };
  }

  serializeContext(record) {
    return {
      contextId: record.contextId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pageIds: [...record.pageIds],
      routeIds: [...record.routes.keys()],
      tracing: record.tracing,
      dialogPolicy: record.dialogPolicy,
      blockedRequests: record.blockedRequests || 0,
      options: record.options,
    };
  }

  async serializePage(record) {
    let title = null;
    if (!record.page.isClosed()) {
      title = await record.page.title().catch(() => null);
    }

    return {
      pageId: record.pageId,
      sessionId: record.sessionId,
      contextId: record.contextId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      url: record.page.isClosed() ? record.lastUrl : record.page.url(),
      title,
      closed: record.page.isClosed(),
      dialogPolicy: record.dialogPolicy,
      lastDialog: record.lastDialog,
    };
  }

  serializeArtifact(sessionId, artifact) {
    return {
      artifactId: artifact.artifactId,
      sessionId,
      contextId: artifact.contextId,
      pageId: artifact.pageId,
      type: artifact.type,
      fileName: artifact.fileName,
      absolutePath: artifact.absolutePath,
      createdAt: artifact.createdAt,
      sizeBytes: artifact.sizeBytes,
      downloadPath: `${this.options.apiBasePath}/sessions/${sessionId}/artifacts/${artifact.artifactId}`,
      metadata: artifact.metadata,
    };
  }

  touch(session, ttlMs = session.ttlMs) {
    session.updatedAt = toIso();
    session.expiresAt = toIso(Date.now() + ttlMs);
  }

  async withLock(sessionId, handler) {
    const session = this.getLiveSession(sessionId);
    const previous = session.queue || Promise.resolve();
    let release;
    session.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await handler(session);
    } finally {
      release();
    }
  }

  // Steps dispatched from `execute` already run inside the session lock, so they
  // pass that session through instead of queueing behind themselves.
  runLocked(sessionId, lockedSession, handler) {
    return lockedSession ? handler(lockedSession) : this.withLock(sessionId, handler);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }

    return session;
  }

  // A crashed browser leaves the record in place until the TTL expires; without
  // this guard every later call fails with an opaque Playwright message.
  getLiveSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session.status === "disconnected" || !session.browser.isConnected()) {
      throw new ApiError(
        409,
        "SESSION_DISCONNECTED",
        `Browser for session ${sessionId} is no longer connected. Create a new session.`,
      );
    }

    return session;
  }

  getContextRecord(session, contextId) {
    const context = session.contexts.get(contextId);
    if (!context) {
      throw new ApiError(404, "CONTEXT_NOT_FOUND", `Context not found: ${contextId}`);
    }

    return context;
  }

  getPageRecord(session, pageId) {
    const page = session.pages.get(pageId);
    if (!page) {
      throw new ApiError(404, "PAGE_NOT_FOUND", `Page not found: ${pageId}`);
    }

    return page;
  }

  logAction(session, action) {
    session.actionSeq = (session.actionSeq ?? 0) + 1;
    session.actions.push({
      actionId: `act_${session.actionSeq}`,
      ts: toIso(),
      ...action,
    });
    if (session.actions.length > this.options.maxActionLogEntries) {
      session.actions.splice(0, session.actions.length - this.options.maxActionLogEntries);
    }
  }

  logEvent(session, event) {
    session.eventSeq = (session.eventSeq ?? 0) + 1;
    session.events.push({
      seq: session.eventSeq,
      ts: toIso(),
      ...event,
    });
    if (session.events.length > this.options.maxEventLogEntries) {
      session.events.splice(0, session.events.length - this.options.maxEventLogEntries);
    }
  }

  // Which browser events are worth surfacing next to the action that triggered
  // them. A console error or a failed request during a click is usually the
  // reason the next assertion fails.
  static classifyEvent(event) {
    if (event.type === "pageerror") {
      return "error";
    }
    if (event.type === "console" && ["error", "warning"].includes(event.level)) {
      return event.level === "error" ? "error" : "warning";
    }
    if (event.type === "response" && Number(event.status) >= 400) {
      return "error";
    }
    if (event.type === "dialog" || event.type === "dialog.error") {
      return "notice";
    }

    return null;
  }

  // Shares isAllowedHost with the run network guard so a session and a script
  // run cannot disagree about what the policy permits.
  isAllowedUrl(url) {
    if (!this.options.urlAllowlist.length) {
      return true;
    }

    try {
      return isAllowedHost(new URL(url).hostname, this.options.urlAllowlist);
    } catch {
      return false;
    }
  }

  assertAllowedUrl(url) {
    if (!this.options.urlAllowlist.length) {
      return;
    }

    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new ApiError(400, "INVALID_URL", `url must be absolute when URL_ALLOWLIST is set: ${url}`);
    }

    if (!this.isAllowedUrl(url)) {
      throw new ApiError(403, "URL_NOT_ALLOWED", `URL host is not in allowlist: ${new URL(url).hostname}`);
    }
  }

  // Checking only the goto argument let a redirect, an iframe, or any in-page
  // request reach a host the operator never allowed. This enforces the
  // allowlist on every request the context makes.
  //
  // Playwright matches routes in reverse registration order, so the guard is
  // re-registered after each user route to stay first, and falls through with
  // route.fallback() when the request is allowed.
  async installUrlGuard(contextRecord) {
    if (!this.options.urlAllowlist.length) {
      return;
    }

    const previous = contextRecord.urlGuard;
    const guard = async (route, request) => {
      if (this.isAllowedUrl(request.url())) {
        await route.fallback();
        return;
      }

      contextRecord.blockedRequests = (contextRecord.blockedRequests || 0) + 1;
      await route.abort("blockedbyclient");
    };

    // Failing to install must not fail open: an unguarded context would let
    // every request through while the operator believes the allowlist applies.
    try {
      await contextRecord.context.route("**/*", guard);
    } catch (error) {
      throw new ApiError(
        500,
        "URL_GUARD_INSTALL_FAILED",
        `Could not enforce URL_ALLOWLIST on context ${contextRecord.contextId}: ${error.message}`,
      );
    }

    contextRecord.urlGuard = guard;
    if (previous) {
      await contextRecord.context.unroute("**/*", previous).catch(() => undefined);
    }
  }

  // A session owns a real browser process, so an unbounded count is a direct
  // path to exhausting the container.
  async createSession(request = {}) {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new ApiError(
        429,
        "SESSION_LIMIT_EXCEEDED",
        `Maximum sessions reached (${this.options.maxSessions}). Close an idle session first.`,
      );
    }

    const browserType = request.browserType || this.options.defaultBrowserType;
    const launcher = browsers[browserType];
    if (!launcher) {
      throw new ApiError(400, "INVALID_BROWSER", `Unsupported browser type: ${browserType}`);
    }

    const sessionId = createId("sess");
    const userArgs = [...this.options.launchArgs, ...(request.launchArgs || [])];
    // In Docker, Playwright 1.58+ selects the lightweight "chromium-headless-shell"
    // binary for headless mode by default. That binary lacks full page functionality
    // (goto/evaluate/screenshot can fail). Force the full Chromium binary via
    // channel="chromium" so all page operations work reliably in containers.
    // Also inject --disable-gpu because full Chromium headless needs a GPU compositor
    // that is unavailable in containers, causing blank screenshots and videos.
    const effectiveChannel = request.channel
      || (isDocker && browserType === "chromium" ? "chromium" : undefined);
    if (isDocker && browserType === "chromium") {
      for (const flag of ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]) {
        if (!userArgs.includes(flag)) {
          userArgs.push(flag);
        }
      }
    }
    const browser = await launcher.launch(
      cleanObject({
        headless: request.headless ?? this.options.defaultHeadless,
        slowMo: request.slowMo,
        channel: effectiveChannel,
        proxy: request.proxy,
        args: userArgs,
      }),
    );

    const session = {
      sessionId,
      browserType,
      browser,
      status: "active",
      ttlMs: request.ttlMs || this.options.sessionTtlMs,
      createdAt: toIso(),
      updatedAt: toIso(),
      expiresAt: toIso(Date.now() + (request.ttlMs || this.options.sessionTtlMs)),
      contexts: new Map(),
      pages: new Map(),
      artifacts: new Map(),
      downloads: [],
      actions: [],
      actionSeq: 0,
      events: [],
      eventSeq: 0,
      queue: Promise.resolve(),
    };

    browser.on("disconnected", () => {
      session.status = "disconnected";
      session.updatedAt = toIso();
    });

    this.sessions.set(sessionId, session);
    await ensureDir(path.join(this.options.artifactsDir, sessionId));
    this.logAction(session, {
      type: "session.create",
      status: "ok",
      input: request,
    });
    console.log(`[session] created sessionId=${sessionId} browser=${browserType} channel=${effectiveChannel || "default"}`);
    return this.serializeSession(session);
  }

  async keepAlive(sessionId, ttlMs) {
    return this.withLock(sessionId, async (session) => {
      this.touch(session, ttlMs || session.ttlMs);
      return this.serializeSession(session);
    });
  }

  async closeSession(sessionId, reason = "closed") {
    const session = this.getSession(sessionId);
    this.sessions.delete(sessionId);
    this.discardApprovals(sessionId, reason);
    await session.browser.close().catch(() => undefined);
    session.status = reason;
    session.updatedAt = toIso();
    if (this.options.purgeSessionArtifactsOnClose) {
      await removeDir(path.join(this.options.artifactsDir, sessionId));
      this.forgetSessionArtifacts(sessionId);
    }

    return {
      sessionId,
      status: reason,
      artifactsPurged: Boolean(this.options.purgeSessionArtifactsOnClose),
    };
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => this.serializeSession(session));
  }

  async cleanupExpiredSessions() {
    const now = Date.now();
    const expired = [...this.sessions.values()].filter((session) => Date.parse(session.expiresAt) <= now);
    for (const session of expired) {
      await this.closeSession(session.sessionId, "expired");
    }
  }

  attachContextListeners(session, contextRecord) {
    contextRecord.context.on("page", (page) => {
      this.ensurePageRecord(session, contextRecord, page, "popup");
    });
  }

  attachPageListeners(session, pageRecord) {
    const page = pageRecord.page;
    page.on("console", (message) => {
      this.logEvent(session, {
        type: "console",
        pageId: pageRecord.pageId,
        level: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      this.logEvent(session, {
        type: "pageerror",
        pageId: pageRecord.pageId,
        message: error.message,
      });
    });
    page.on("request", (request) => {
      this.logEvent(session, {
        type: "request",
        pageId: pageRecord.pageId,
        method: request.method(),
        url: request.url(),
      });
    });
    page.on("response", (response) => {
      this.logEvent(session, {
        type: "response",
        pageId: pageRecord.pageId,
        status: response.status(),
        url: response.url(),
      });
    });
    // Playwright auto-dismisses dialogs only while no listener is attached.
    // Attaching one to log them made every alert/confirm/prompt block the action
    // that opened it until it timed out, so the listener has to resolve it.
    page.on("dialog", (dialog) => {
      const policy = this.resolveDialogPolicy(session, pageRecord);
      const record = {
        ts: toIso(),
        dialogType: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        handledWith: policy.action,
      };
      pageRecord.lastDialog = record;
      this.logEvent(session, { type: "dialog", pageId: pageRecord.pageId, ...record });

      if (policy.action === "ignore") {
        return;
      }

      const settle = policy.action === "accept"
        ? dialog.accept(policy.promptText ?? "")
        : dialog.dismiss();
      settle.catch((error) => {
        this.logEvent(session, {
          type: "dialog.error",
          pageId: pageRecord.pageId,
          message: error.message,
        });
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        pageRecord.lastUrl = frame.url();
      }
    });
    // acceptDownloads defaults to true, but with no listener Playwright kept the
    // file in a temp directory and deleted it when the context closed, so a
    // scenario that downloads a document had no way to check what it received.
    page.on("download", (download) => {
      this.captureDownload(session, pageRecord, download).catch((error) => {
        this.logEvent(session, {
          type: "download.error",
          pageId: pageRecord.pageId,
          message: error.message,
        });
      });
    });
    page.on("close", () => {
      session.pages.delete(pageRecord.pageId);
      pageRecord.lastUrl = page.url();
      this.pageLookup.delete(page);
      const contextRecord = session.contexts.get(pageRecord.contextId);
      contextRecord?.pageIds.delete(pageRecord.pageId);
      this.logEvent(session, {
        type: "page.closed",
        pageId: pageRecord.pageId,
      });
    });
  }

  // Page policy wins over context policy, which wins over the server default.
  resolveDialogPolicy(session, pageRecord) {
    const contextRecord = session.contexts.get(pageRecord.contextId);
    return pageRecord.dialogPolicy
      || contextRecord?.dialogPolicy
      || this.options.defaultDialogPolicy;
  }

  async setDialogPolicy(sessionId, pageId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const pageRecord = this.getPageRecord(session, pageId);
      pageRecord.dialogPolicy = normalizeDialogPolicy(
        request.dialogPolicy ?? request,
        this.options.defaultDialogPolicy,
      );
      pageRecord.updatedAt = toIso();
      this.touch(session);
      return { pageId, dialogPolicy: pageRecord.dialogPolicy };
    });
  }

  ensurePageRecord(session, contextRecord, page, source) {
    const existingId = this.pageLookup.get(page);
    if (existingId && session.pages.has(existingId)) {
      return session.pages.get(existingId);
    }

    const pageId = createId("page");
    const pageRecord = {
      pageId,
      page,
      sessionId: session.sessionId,
      contextId: contextRecord.contextId,
      createdAt: toIso(),
      updatedAt: toIso(),
      lastUrl: page.url(),
      dialogPolicy: null,
      lastDialog: null,
    };
    session.pages.set(pageId, pageRecord);
    contextRecord.pageIds.add(pageId);
    this.pageLookup.set(page, pageId);
    this.attachPageListeners(session, pageRecord);
    this.logEvent(session, {
      type: "page.opened",
      pageId,
      contextId: contextRecord.contextId,
      source,
    });
    return pageRecord;
  }

  async createContext(sessionId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      if (session.contexts.size >= this.options.maxContextsPerSession) {
        throw new ApiError(409, "CONTEXT_LIMIT_EXCEEDED", "Maximum contexts per session exceeded");
      }

      const contextId = createId("ctx");
      const baseOptions = cleanObject({
        acceptDownloads: request.acceptDownloads ?? true,
        baseURL: request.baseURL,
        bypassCSP: request.bypassCSP,
        colorScheme: request.colorScheme,
        extraHTTPHeaders: request.extraHTTPHeaders,
        geolocation: request.geolocation,
        hasTouch: request.hasTouch,
        ignoreHTTPSErrors: request.ignoreHTTPSErrors,
        javaScriptEnabled: request.javaScriptEnabled,
        locale: request.locale,
        offline: request.offline,
        reducedMotion: request.reducedMotion,
        serviceWorkers: request.serviceWorkers,
        storageState: request.storageState,
        timezoneId: request.timezoneId,
        userAgent: request.userAgent,
        viewport: request.viewport,
      });

      if (request.recordVideo) {
        baseOptions.recordVideo = cleanObject({
          dir: path.join(this.options.artifactsDir, session.sessionId, "videos"),
          size: request.recordVideo.size,
        });
      }

      const dialogPolicy = normalizeDialogPolicy(request.dialogPolicy, null);
      const context = await session.browser.newContext(baseOptions);
      const contextRecord = {
        contextId,
        sessionId,
        context,
        createdAt: toIso(),
        updatedAt: toIso(),
        pageIds: new Set(),
        routes: new Map(),
        options: baseOptions,
        dialogPolicy,
        tracing: false,
      };

      this.attachContextListeners(session, contextRecord);
      await this.installUrlGuard(contextRecord);
      session.contexts.set(contextId, contextRecord);
      this.touch(session);

      if (Array.isArray(request.permissions) && request.permissions.length) {
        await context.grantPermissions(request.permissions, { origin: request.permissionsOrigin });
      }

      this.logAction(session, {
        type: "context.create",
        status: "ok",
        contextId,
        input: request,
      });
      return this.serializeContext(contextRecord);
    });
  }

  async getContext(sessionId, contextId) {
    const session = this.getSession(sessionId);
    return this.serializeContext(this.getContextRecord(session, contextId));
  }

  async closeContext(sessionId, contextId) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      // Collect video artifacts from all pages before closing context
      const videos = [];
      for (const pageId of contextRecord.pageIds) {
        const pageRecord = session.pages.get(pageId);
        if (pageRecord) {
          const v = await this.collectVideoArtifact(session, pageRecord).catch(() => null);
          if (v) videos.push(v);
        }
      }
      await contextRecord.context.close();
      session.contexts.delete(contextId);
      this.touch(session);
      this.logAction(session, {
        type: "context.close",
        status: "ok",
        contextId,
      });
      return {
        contextId,
        status: "closed",
        ...(videos.length ? { videos } : {}),
      };
    });
  }

  async createPage(sessionId, contextId) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      if (session.pages.size >= this.options.maxPagesPerSession) {
        throw new ApiError(409, "PAGE_LIMIT_EXCEEDED", "Maximum pages per session exceeded");
      }
      const page = await contextRecord.context.newPage();
      const pageRecord = this.ensurePageRecord(session, contextRecord, page, "api");
      this.touch(session);
      return this.serializePage(pageRecord);
    });
  }

  async getPage(sessionId, pageId) {
    const session = this.getSession(sessionId);
    return this.serializePage(this.getPageRecord(session, pageId));
  }

  async closePage(sessionId, pageId) {
    return this.withLock(sessionId, async (session) => {
      const pageRecord = this.getPageRecord(session, pageId);
      const page = pageRecord.page;
      await page.close();
      // Collect video artifact if video recording was active
      const videoArtifact = await this.collectVideoArtifact(session, pageRecord).catch(() => null);
      this.touch(session);
      return {
        pageId,
        status: "closed",
        ...(videoArtifact ? { video: videoArtifact } : {}),
      };
    });
  }

  async captureDownload(session, pageRecord, download) {
    const suggestedFilename = download.suggestedFilename();
    this.logEvent(session, {
      type: "download.started",
      pageId: pageRecord.pageId,
      fileName: suggestedFilename,
      url: download.url(),
    });

    // Resolves once the transfer finishes; null means it failed or was cancelled.
    const downloadPath = await download.path();
    if (!downloadPath) {
      const failure = await download.failure();
      this.logEvent(session, {
        type: "download.failed",
        pageId: pageRecord.pageId,
        fileName: suggestedFilename,
        message: failure || "download did not complete",
      });
      return null;
    }

    const stats = await statOrNull(downloadPath);
    if (stats && stats.size > this.options.maxDownloadBytes) {
      this.logEvent(session, {
        type: "download.skipped",
        pageId: pageRecord.pageId,
        fileName: suggestedFilename,
        message: `exceeds MAX_DOWNLOAD_BYTES (${stats.size} > ${this.options.maxDownloadBytes})`,
      });
      return null;
    }

    const artifact = await this.saveArtifact(session, {
      contextId: pageRecord.contextId,
      pageId: pageRecord.pageId,
      type: "download",
      extension: (path.extname(suggestedFilename).replace(".", "") || "bin").toLowerCase(),
      buffer: await fsPromises.readFile(downloadPath),
      metadata: {
        suggestedFilename,
        url: download.url(),
      },
    });

    const record = {
      downloadId: artifact.artifactId,
      fileName: suggestedFilename,
      url: download.url(),
      sizeBytes: artifact.sizeBytes,
      pageId: pageRecord.pageId,
      contextId: pageRecord.contextId,
      completedAt: toIso(),
      artifact,
    };
    session.downloads.push(record);
    if (session.downloads.length > this.options.maxActionLogEntries) {
      session.downloads.splice(0, session.downloads.length - this.options.maxActionLogEntries);
    }

    this.logEvent(session, {
      type: "download.completed",
      pageId: pageRecord.pageId,
      fileName: suggestedFilename,
      downloadId: record.downloadId,
      sizeBytes: record.sizeBytes,
    });
    console.log(`[session] download captured ${suggestedFilename} ${record.sizeBytes}B`);
    return record;
  }

  // Waits for a download to arrive, then checks the file itself - a click that
  // "worked" but produced an empty or wrong file is not a completed task.
  async assertDownload(session, step = {}) {
    const timeoutMs = step.timeoutMs ?? 15_000;
    const matches = (record) => {
      if (step.fileName && !textMatches(record.fileName, normalizePattern(step.fileName), step.match || "contains")) {
        return false;
      }
      return true;
    };

    const seenBefore = step.sinceIndex ?? 0;
    let record = null;
    await poll(
      timeoutMs,
      async () => {
        record = session.downloads.slice(seenBefore).reverse().find(matches) || null;
        return Boolean(record);
      },
      step.fileName
        ? `no download matching ${JSON.stringify(step.fileName)} arrived within ${timeoutMs}ms`
        : `no download arrived within ${timeoutMs}ms`,
    );

    if (step.minBytes !== undefined && record.sizeBytes < Number(step.minBytes)) {
      throw new ApiError(
        422,
        "DOWNLOAD_ASSERTION_FAILED",
        `${record.fileName} is ${record.sizeBytes} bytes, expected at least ${step.minBytes}`,
        { downloadId: record.downloadId, sizeBytes: record.sizeBytes },
      );
    }

    let text;
    if (step.contains !== undefined || step.jsonPath !== undefined) {
      const buffer = await fsPromises.readFile(record.artifact.absolutePath);
      text = buffer.subarray(0, this.options.maxApiResponseBodyBytes).toString("utf8");
    }

    if (step.contains !== undefined && !text.includes(String(step.contains))) {
      throw new ApiError(
        422,
        "DOWNLOAD_ASSERTION_FAILED",
        `${record.fileName} does not contain ${JSON.stringify(step.contains)}`,
        { downloadId: record.downloadId, preview: truncate(text, 300) },
      );
    }

    if (step.jsonPath !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(422, "DOWNLOAD_ASSERTION_FAILED", `${record.fileName} is not JSON`, {
          downloadId: record.downloadId,
          preview: truncate(text, 300),
        });
      }
      const actual = readJsonPath(parsed, step.jsonPath);
      const expected = step.expected ?? step.value;
      if (expected !== undefined && !textMatches(actual, normalizePattern(expected), step.match || "equals")) {
        throw new ApiError(
          422,
          "DOWNLOAD_ASSERTION_FAILED",
          `${step.jsonPath} in ${record.fileName} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
          { downloadId: record.downloadId, actual, expected },
        );
      }
    }

    return {
      downloadId: record.downloadId,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      url: record.url,
      downloadPath: record.artifact.downloadPath,
      success: true,
    };
  }

  listDownloads(sessionId) {
    const session = this.getSession(sessionId);
    return {
      sessionId,
      downloads: session.downloads.map((record) => ({
        downloadId: record.downloadId,
        fileName: record.fileName,
        url: record.url,
        sizeBytes: record.sizeBytes,
        pageId: record.pageId,
        completedAt: record.completedAt,
        downloadPath: record.artifact.downloadPath,
      })),
    };
  }

  async collectVideoArtifact(session, pageRecord) {
    try {
      const video = pageRecord.page.video();
      if (!video) return null;
      const videoPath = await video.path();
      if (!videoPath) return null;
      const stats = await fsPromises.stat(videoPath).catch(() => null);
      if (!stats || stats.size === 0) return null;
      const buffer = await fsPromises.readFile(videoPath);
      const artifact = await this.saveArtifact(session, {
        contextId: pageRecord.contextId,
        pageId: pageRecord.pageId,
        type: "video",
        extension: "webm",
        buffer,
        metadata: { originalPath: videoPath },
      });
      console.log(`[session] video collected pageId=${pageRecord.pageId} size=${stats.size}`);
      return artifact;
    } catch {
      return null;
    }
  }

  async saveArtifact(session, request) {
    const artifactId = createId("artifact");
    const sessionDir = path.join(this.options.artifactsDir, session.sessionId);
    await ensureDir(sessionDir);
    const fileName = `${artifactId}-${safeFilename(request.type)}.${request.extension}`;
    const filePath = path.join(sessionDir, fileName);

    if (request.buffer) {
      await fsPromises.writeFile(filePath, request.buffer);
    } else {
      await fsPromises.writeFile(filePath, request.content, "utf8");
    }

    const stats = await fsPromises.stat(filePath);
    const artifact = {
      artifactId,
      contextId: request.contextId,
      pageId: request.pageId,
      type: request.type,
      fileName,
      absolutePath: filePath,
      createdAt: toIso(),
      sizeBytes: stats.size,
      metadata: request.metadata,
    };
    session.artifacts.set(artifactId, artifact);
    this.indexArtifact(session.sessionId, artifact);
    return this.serializeArtifact(session.sessionId, artifact);
  }

  indexArtifact(sessionId, artifact) {
    this.artifactIndex.set(artifact.artifactId, { ...artifact, sessionId });
    const excess = this.artifactIndex.size - this.options.maxRetainedArtifacts;
    if (excess > 0) {
      // Map preserves insertion order, so the oldest keys come first.
      for (const key of [...this.artifactIndex.keys()].slice(0, excess)) {
        this.artifactIndex.delete(key);
      }
    }
  }

  forgetSessionArtifacts(sessionId) {
    for (const [artifactId, artifact] of this.artifactIndex) {
      if (artifact.sessionId === sessionId) {
        this.artifactIndex.delete(artifactId);
      }
    }
  }

  // Capturing a full-page screenshot plus the DOM for every rejected request
  // filled the artifacts directory with noise, so caller input errors (4xx) are
  // skipped - only genuine automation failures are worth an artifact.
  async captureFailureArtifacts(session, pageRecord, actionType) {
    const artifacts = {};
    if (!this.options.captureFailureArtifacts || pageRecord.page.isClosed()) {
      return artifacts;
    }

    try {
      const screenshot = await pageRecord.page.screenshot({
        fullPage: true,
        type: "png",
      });
      artifacts.screenshot = await this.saveArtifact(session, {
        contextId: pageRecord.contextId,
        pageId: pageRecord.pageId,
        type: "error-screenshot",
        extension: "png",
        buffer: screenshot,
        metadata: { actionType },
      });
    } catch {
      // ignore artifact capture failures
    }

    try {
      const html = await pageRecord.page.content();
      artifacts.dom = await this.saveArtifact(session, {
        contextId: pageRecord.contextId,
        pageId: pageRecord.pageId,
        type: "error-dom",
        extension: "html",
        content: html,
        metadata: { actionType },
      });
    } catch {
      // ignore artifact capture failures
    }

    return artifacts;
  }

  async exportStorageState(sessionId, contextId) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      const storageState = await contextRecord.context.storageState();
      const artifact = await this.saveArtifact(session, {
        contextId,
        type: "storage-state",
        extension: "json",
        content: JSON.stringify(storageState, null, 2),
        metadata: {
          export: true,
        },
      });
      this.logAction(session, {
        type: "context.storage.export",
        status: "ok",
        contextId,
      });
      return {
        contextId,
        storageState,
        artifact,
      };
    });
  }

  async importStorageState(sessionId, contextId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      let storageState = request.storageState;
      if (!storageState && request.storageStateRef) {
        const storagePath = resolveWithin(this.options.storageStateDir, request.storageStateRef, "storageStateRef");
        if (!(await fileExists(storagePath))) {
          throw new ApiError(404, "STORAGE_STATE_NOT_FOUND", `Storage state not found: ${request.storageStateRef}`);
        }
        storageState = await readJsonFile(storagePath);
      }
      if (!storageState) {
        throw new ApiError(400, "INVALID_REQUEST", "storageState or storageStateRef is required");
      }
      if (typeof storageState !== "object" || Array.isArray(storageState)
        || (!Array.isArray(storageState.cookies) && !Array.isArray(storageState.origins))) {
        throw new ApiError(
          400,
          "INVALID_STORAGE_STATE",
          "storageState must be a Playwright storage state object with a cookies and/or origins array",
        );
      }

      const oldContext = contextRecord.context;
      const recreatedOptions = {
        ...contextRecord.options,
        storageState,
      };
      const pageIds = [...contextRecord.pageIds];
      await oldContext.close();
      const nextContext = await session.browser.newContext(recreatedOptions);
      contextRecord.context = nextContext;
      contextRecord.pageIds = new Set();
      contextRecord.routes = new Map();
      contextRecord.options = recreatedOptions;
      contextRecord.updatedAt = toIso();
      contextRecord.tracing = false;
      await this.installUrlGuard(contextRecord);
      this.attachContextListeners(session, contextRecord);
      this.touch(session);
      this.logAction(session, {
        type: "context.storage.import",
        status: "ok",
        contextId,
      });
      return {
        contextId,
        replacedPages: pageIds,
        context: this.serializeContext(contextRecord),
      };
    });
  }

  async addRoute(sessionId, contextId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      if (!request.url) {
        throw new ApiError(400, "INVALID_REQUEST", "url is required");
      }
      const routeId = createId("route");
      const behaviorPath = request.behavior?.path;
      const fulfillPath = behaviorPath
        ? resolveWithin(this.options.routeFixturesDir, behaviorPath, "behavior.path")
        : undefined;
      if (fulfillPath && !(await fileExists(fulfillPath))) {
        throw new ApiError(404, "FIXTURE_NOT_FOUND", `Route fixture not found: ${behaviorPath}`);
      }

      const handler = async (route) => {
        const behavior = request.behavior || { action: "continue" };
        switch (behavior.action) {
          case "abort":
            await route.abort(behavior.errorCode);
            break;
          case "fulfill":
            await route.fulfill(cleanObject({
              body: behavior.body,
              contentType: behavior.contentType,
              headers: behavior.headers,
              json: behavior.json,
              // route.fulfill({ path }) reads a file off the server's disk and
              // serves it into the page, so it is confined to the fixtures root.
              path: fulfillPath,
              status: behavior.status,
            }));
            break;
          case "continue":
          default:
            await route.continue(cleanObject({
              headers: behavior.headers,
              method: behavior.method,
              postData: behavior.postData,
              url: behavior.overrideUrl,
            }));
            break;
        }
      };
      await contextRecord.context.route(request.url, handler, { times: request.times });
      // Keep the allowlist guard as the most recently added route so it still
      // sees every request first.
      await this.installUrlGuard(contextRecord);
      contextRecord.routes.set(routeId, {
        url: request.url,
        handler,
        request,
      });
      contextRecord.updatedAt = toIso();
      this.touch(session);
      return {
        routeId,
        contextId,
      };
    });
  }

  async removeRoute(sessionId, contextId, routeId) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      const routeRecord = contextRecord.routes.get(routeId);
      if (!routeRecord) {
        throw new ApiError(404, "ROUTE_NOT_FOUND", `Route not found: ${routeId}`);
      }
      await contextRecord.context.unroute(routeRecord.url, routeRecord.handler);
      contextRecord.routes.delete(routeId);
      contextRecord.updatedAt = toIso();
      this.touch(session);
      return {
        routeId,
        status: "removed",
      };
    });
  }

  async setCookies(sessionId, contextId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      await contextRecord.context.addCookies(request.cookies || []);
      this.touch(session);
      return {
        contextId,
        cookies: await contextRecord.context.cookies(request.urls),
      };
    });
  }

  async getCookies(sessionId, contextId, request = {}) {
    const session = this.getSession(sessionId);
    const contextRecord = this.getContextRecord(session, contextId);
    return {
      contextId,
      cookies: await contextRecord.context.cookies(request.urls),
    };
  }

  async grantPermissions(sessionId, contextId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      await contextRecord.context.grantPermissions(request.permissions || [], {
        origin: request.origin,
      });
      this.touch(session);
      return {
        contextId,
        permissions: request.permissions || [],
        origin: request.origin,
      };
    });
  }

  // "The button turned green" is not the same as "the record exists". This issues
  // a request through the context's own APIRequestContext, so it carries the
  // session's cookies and headers and can confirm the business outcome the UI
  // claims to have produced.
  async apiRequest(sessionId, contextId, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      const method = String(request.method || "GET").toUpperCase();
      if (!ALLOWED_API_METHODS.has(method)) {
        throw new ApiError(400, "INVALID_REQUEST", `method must be one of ${[...ALLOWED_API_METHODS].join(", ")}`);
      }
      if (!request.url) {
        throw new ApiError(400, "INVALID_REQUEST", "url is required");
      }

      // Resolve against the context baseURL so a relative path works, then apply
      // the same allowlist the browser is held to.
      let url;
      try {
        url = new URL(request.url, contextRecord.options?.baseURL || undefined).toString();
      } catch {
        throw new ApiError(400, "INVALID_URL", `url could not be resolved: ${request.url}`);
      }
      this.assertAllowedUrl(url);

      const startedAt = monotonicNow();
      const startedAtWall = Date.now();
      const fromEventSeq = (session.eventSeq ?? 0) + 1;
      let response;
      try {
        response = await contextRecord.context.request.fetch(url, cleanObject({
          method,
          headers: request.headers,
          params: request.params,
          data: request.data,
          form: request.form,
          timeout: request.timeoutMs ?? this.options.apiRequestTimeoutMs,
          ignoreHTTPSErrors: request.ignoreHTTPSErrors,
          maxRedirects: request.maxRedirects,
        }));
      } catch (error) {
        const elapsed = elapsedMs(startedAt);
        this.logAction(session, {
          type: "api.request",
          status: "error",
          contextId,
          startedAt: toIso(startedAtWall),
          durationMs: elapsed,
          fromEventSeq,
          toEventSeq: session.eventSeq ?? 0,
          input: { method, url },
          error: error.message,
        });
        throw toApiError(error, {
          statusCode: /Timeout/i.test(error.message) ? 408 : 502,
          code: /Timeout/i.test(error.message) ? "TIMEOUT" : "API_REQUEST_FAILED",
          details: { sessionId, contextId, method, url },
        });
      }

      const elapsed = elapsedMs(startedAt);
      const bodyBuffer = await response.body().catch(() => Buffer.alloc(0));
      const truncated = bodyBuffer.length > this.options.maxApiResponseBodyBytes;
      const text = bodyBuffer.subarray(0, this.options.maxApiResponseBodyBytes).toString("utf8");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }

      // Keep the full body as evidence even when the inline copy is truncated.
      const artifact = await this.saveArtifact(session, {
        contextId,
        type: "api-response",
        extension: json !== undefined ? "json" : "txt",
        buffer: bodyBuffer,
        metadata: { method, url, status: response.status() },
      });

      const result = {
        method,
        url,
        status: response.status(),
        statusText: response.statusText(),
        ok: response.ok(),
        headers: response.headers(),
        durationMs: elapsed,
        bodyBytes: bodyBuffer.length,
        truncated,
        text,
        json,
        artifact,
      };

      this.logAction(session, {
        type: "api.request",
        status: response.ok() ? "ok" : "error",
        contextId,
        startedAt: toIso(startedAtWall),
        durationMs: elapsed,
        fromEventSeq,
        toEventSeq: session.eventSeq ?? 0,
        url,
        input: { method, url },
        output: summarize({ status: result.status, bodyBytes: result.bodyBytes }),
        artifactIds: [artifact.artifactId],
        error: response.ok() ? undefined : `HTTP ${response.status()} ${response.statusText()}`,
      });

      return result;
    });
  }

  async setHeaders(sessionId, contextId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, contextId);
      await contextRecord.context.setExtraHTTPHeaders(request.headers || {});
      contextRecord.options.extraHTTPHeaders = request.headers || {};
      contextRecord.updatedAt = toIso();
      this.touch(session);
      return {
        contextId,
        headers: request.headers || {},
      };
    });
  }

  async runPageCommandLocked(session, pageId, type, input, executor) {
    const pageRecord = this.getPageRecord(session, pageId);
    const startedAt = Date.now();
    const startedAtMonotonic = monotonicNow();
    // Claim the event range this action is responsible for.
    const fromEventSeq = (session.eventSeq ?? 0) + 1;
    console.log(`[session] ${type} start sessionId=${session.sessionId} pageId=${pageId}`);
    try {
      const result = await executor(pageRecord);
      const elapsed = elapsedMs(startedAtMonotonic);
      pageRecord.updatedAt = toIso();
      this.touch(session);
      this.logAction(session, {
        type,
        status: "ok",
        pageId,
        contextId: pageRecord.contextId,
        startedAt: toIso(startedAt),
        durationMs: elapsed,
        fromEventSeq,
        toEventSeq: session.eventSeq ?? 0,
        url: pageRecord.page.isClosed() ? pageRecord.lastUrl : pageRecord.page.url(),
        input,
        output: summarize(result),
      });
      console.log(`[session] ${type} ok ${elapsed}ms`);
      return result;
    } catch (error) {
      const elapsed = elapsedMs(startedAtMonotonic);
      console.error(`[session] ${type} error ${elapsed}ms — ${error.message}`);
      // A rejected request body says nothing about the page, so no artifact.
      // Timeouts and genuine automation failures are exactly when a screenshot
      // and DOM dump are worth keeping.
      const isBadRequest = error instanceof ApiError && BAD_REQUEST_STATUS_CODES.has(error.statusCode);
      const artifacts = isBadRequest ? {} : await this.captureFailureArtifacts(session, pageRecord, type);
      this.logAction(session, {
        type,
        status: "error",
        pageId,
        contextId: pageRecord.contextId,
        startedAt: toIso(startedAt),
        durationMs: elapsed,
        fromEventSeq,
        toEventSeq: session.eventSeq ?? 0,
        url: pageRecord.page.isClosed() ? pageRecord.lastUrl : pageRecord.page.url(),
        input,
        error: error.message,
        // Linked so a timeline can show the before/after screen without
        // re-deriving which artifacts belong to which step.
        artifactIds: Object.values(artifacts).map((artifact) => artifact?.artifactId).filter(Boolean),
      });
      // Playwright's own wording for this is "strict mode violation", which says
      // nothing about the fix. The locator is ambiguous; the caller needs to
      // narrow it or say which match they meant.
      const ambiguous = /strict mode violation/i.test(error?.message || "");
      if (ambiguous) {
        const matched = /resolved to (\d+) element/i.exec(error.message)?.[1];
        throw new ApiError(
          400,
          "AMBIGUOUS_LOCATOR",
          `The locator matches ${matched || "several"} elements. Narrow it, or add first, last, or nth to say which one you mean.`,
          {
            sessionId: session.sessionId,
            pageId,
            locator: input?.locator ?? input?.source ?? null,
            matchCount: matched ? Number(matched) : undefined,
          },
        );
      }

      // A Playwright timeout is a failed expectation, not a server fault.
      const isTimeout = isTimeoutError(error);
      throw toApiError(error, {
        statusCode: error instanceof ApiError ? error.statusCode : (isTimeout ? 408 : 500),
        code: error instanceof ApiError ? error.code : (isTimeout ? "TIMEOUT" : "PLAYWRIGHT_ACTION_ERROR"),
        details: {
          sessionId: session.sessionId,
          pageId,
          contextId: pageRecord.contextId,
          lastUrl: pageRecord.page.url(),
        },
        artifacts,
      });
    }
  }

  async navigate(sessionId, pageId, action, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      return this.runPageCommandLocked(session, pageId, `page.${action}`, request, async (pageRecord) => {
        switch (action) {
          case "goto": {
            if (!request.url) {
              throw new ApiError(400, "INVALID_REQUEST", "url is required");
            }
            this.assertAllowedUrl(request.url);
            const response = await pageRecord.page.goto(request.url, {
              timeout: request.timeoutMs,
              waitUntil: request.waitUntil,
            });
            return {
              pageId,
              url: pageRecord.page.url(),
              status: response?.status() ?? null,
            };
          }
          case "reload": {
            const response = await pageRecord.page.reload({
              timeout: request.timeoutMs,
              waitUntil: request.waitUntil,
            });
            return {
              pageId,
              url: pageRecord.page.url(),
              status: response?.status() ?? null,
            };
          }
          case "goBack": {
            const response = await pageRecord.page.goBack({
              timeout: request.timeoutMs,
              waitUntil: request.waitUntil,
            });
            return {
              pageId,
              url: pageRecord.page.url(),
              status: response?.status() ?? null,
            };
          }
          case "goForward": {
            const response = await pageRecord.page.goForward({
              timeout: request.timeoutMs,
              waitUntil: request.waitUntil,
            });
            return {
              pageId,
              url: pageRecord.page.url(),
              status: response?.status() ?? null,
            };
          }
          default:
            throw new ApiError(400, "INVALID_NAVIGATION_ACTION", `Unsupported navigation action: ${action}`);
        }
      });
    });
  }

  async pageAction(sessionId, pageId, action, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      return this.runPageCommandLocked(session, pageId, `page.${action}`, request, async (pageRecord) => {
        const page = pageRecord.page;
        switch (action) {
          case "click":
            await resolveLocator(page, request.locator).click(cleanObject({
              button: request.button,
              clickCount: request.clickCount,
              delay: request.delay,
              force: request.force,
              modifiers: request.modifiers,
              position: request.position,
              timeout: request.timeoutMs,
            }));
            return this.serializePage(pageRecord);
          case "fill":
            await resolveLocator(page, request.locator).fill(request.value ?? "", {
              force: request.force,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "press":
            if (typeof request.key !== "string" || !request.key) {
              throw new ApiError(400, "INVALID_REQUEST", "key is required for press (for example \"Enter\")");
            }
            await resolveLocator(page, request.locator).press(request.key, {
              delay: request.delay,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "selectOption": {
            const optionTarget = request.values ?? request.value ?? request.options;
            if (optionTarget === undefined || optionTarget === null) {
              throw new ApiError(400, "INVALID_REQUEST", "values, value, or options is required for selectOption");
            }
            const selected = await resolveLocator(page, request.locator).selectOption(
              optionTarget,
              { timeout: request.timeoutMs },
            );
            return {
              pageId,
              selected,
            };
          }
          case "hover":
            await resolveLocator(page, request.locator).hover({
              force: request.force,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "drag":
            if (!request.source || !request.target) {
              throw new ApiError(400, "INVALID_REQUEST", "source and target locators are required for drag");
            }
            await resolveLocator(page, request.source).dragTo(resolveLocator(page, request.target), {
              force: request.force,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "evaluate":
            if (!this.options.enableEvaluate) {
              throw new ApiError(403, "EVALUATE_DISABLED", "page.evaluate is disabled by configuration");
            }
            if (typeof request.expression !== "string" || !request.expression.trim()) {
              throw new ApiError(400, "INVALID_REQUEST", "expression (string) is required");
            }
            return {
              pageId,
              result: await page.evaluate(buildEvaluateExpression(request.expression, request.arg)),
            };
          case "locatorQuery": {
            const locator = resolveLocator(page, request.locator);
            switch (request.operation || "count") {
              case "count":
                return { pageId, count: await locator.count() };
              case "allTextContents":
                return { pageId, values: await locator.allTextContents() };
              case "textContent":
                return { pageId, value: await locator.first().textContent() };
              case "innerText":
                return { pageId, value: await locator.first().innerText() };
              case "isVisible":
                return { pageId, value: await locator.first().isVisible() };
              default:
                throw new ApiError(400, "INVALID_OPERATION", `Unsupported locator query operation: ${request.operation}`);
            }
          }
          default:
            throw new ApiError(400, "INVALID_PAGE_ACTION", `Unsupported page action: ${action}`);
        }
      });
    });
  }

  async pageAssert(sessionId, pageId, action, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      return this.runPageCommandLocked(session, pageId, `assert.${action}`, request, async (pageRecord) => {
        const page = pageRecord.page;
        const timeoutMs = request.timeoutMs || 5000;
        switch (action) {
          case "visible":
            await resolveLocator(page, request.locator).waitFor({
              state: "visible",
              timeout: timeoutMs,
            });
            return { pageId, success: true };
          case "text": {
            const expected = normalizePattern(request.expected ?? request.value);
            if (expected === undefined || expected === null) {
              throw new ApiError(400, "INVALID_REQUEST", "expected (or value) is required for the text assertion");
            }
            await poll(
              timeoutMs,
              async () => {
                const actual = (await resolveLocator(page, request.locator).first().textContent()) ?? "";
                return textMatches(actual, expected, request.match || "contains");
              },
              "Text assertion timed out",
            );
            return { pageId, success: true };
          }
          case "url": {
            const expected = normalizePattern(request.expected ?? request.value ?? request.url);
            if (expected === undefined || expected === null) {
              throw new ApiError(400, "INVALID_REQUEST", "expected (or value/url) is required for the url assertion");
            }
            if (expected instanceof RegExp) {
              await page.waitForURL(expected, { timeout: timeoutMs });
            } else {
              await poll(
                timeoutMs,
                async () => textMatches(page.url(), expected, request.match || "equals"),
                "URL assertion timed out",
              );
            }
            return { pageId, success: true, url: page.url() };
          }
          case "count": {
            const expected = Number(request.expected ?? request.value);
            if (!Number.isFinite(expected)) {
              throw new ApiError(400, "INVALID_REQUEST", "expected (or value) must be a number for the count assertion");
            }
            await poll(
              timeoutMs,
              async () => {
                const count = await resolveLocator(page, request.locator).count();
                return countMatches(count, expected, request.operator || "eq");
              },
              "Count assertion timed out",
            );
            return { pageId, success: true };
          }
          default:
            throw new ApiError(400, "INVALID_ASSERTION", `Unsupported assertion: ${action}`);
        }
      });
    });
  }

  async waitFor(sessionId, pageId, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      return this.runPageCommandLocked(session, pageId, "page.waitFor", request, async (pageRecord) => {
        const page = pageRecord.page;
        const timeoutMs = request.timeoutMs || 5000;
        if (request.loadState) {
          await page.waitForLoadState(request.loadState, { timeout: timeoutMs });
        } else if (request.url) {
          await page.waitForURL(normalizePattern(request.url), { timeout: timeoutMs });
        } else if (request.locator) {
          await resolveLocator(page, request.locator).waitFor({
            state: request.state || "visible",
            timeout: timeoutMs,
          });
        } else if (request.text) {
          await page.getByText(request.text, { exact: request.exact }).first().waitFor({
            state: "visible",
            timeout: timeoutMs,
          });
        } else if (request.textGone) {
          await poll(
            timeoutMs,
            async () => !(await page.content()).includes(request.textGone),
            "Text did not disappear in time",
          );
        } else if (Number.isFinite(Number(request.sleepMs))) {
          await sleep(Math.max(0, Number(request.sleepMs)));
        } else {
          // Silently sleeping for the timeout hid typos in the request body.
          throw new ApiError(
            400,
            "INVALID_REQUEST",
            "one of loadState, url, locator, text, textGone, or sleepMs is required",
          );
        }
        return {
          pageId,
          success: true,
          url: page.url(),
        };
      });
    });
  }

  async inspectPage(sessionId, pageId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      return this.runPageCommandLocked(session, pageId, "page.inspect", request, async (pageRecord) => {
        const maxElements = Math.min(Math.max(Number(request.maxElements) || 40, 1), 200);
        const maxTextLength = Math.min(Math.max(Number(request.maxTextLength) || 140, 20), 400);
        await pageRecord.page.waitForLoadState("domcontentloaded").catch(() => undefined);
        const verifyLocators = request.verifyLocators !== false;
        const maxVerifiedCandidates = Math.min(Math.max(Number(request.maxVerifiedCandidates) || 3, 1), 6);
        const snapshot = await pageRecord.page.evaluate(({ maxElements: limit, maxTextLength: textLimit }) => {
          const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, textLimit);
          // A child-index chain identifies a node without mutating the page, so
          // an ambiguous locator can be resolved to a concrete nth later.
          const domPath = (element) => {
            const parts = [];
            for (let node = element; node && node.parentNode; node = node.parentNode) {
              parts.unshift([...node.parentNode.childNodes].indexOf(node));
            }
            return parts.join("/");
          };
          const isVisible = (element) => {
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const implicitRole = (element) => {
            const tag = element.tagName.toLowerCase();
            const type = element.getAttribute("type") || "";
            if (tag === "button") return "button";
            if (tag === "a" && element.getAttribute("href")) return "link";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (tag === "input") {
              if (["button", "submit", "reset"].includes(type)) return "button";
              if (type === "checkbox") return "checkbox";
              if (type === "radio") return "radio";
              return "textbox";
            }
            return null;
          };
          const getLabel = (element) => {
            if (element.labels && element.labels.length) {
              return normalize(element.labels[0].innerText || element.labels[0].textContent);
            }
            const ariaLabel = element.getAttribute("aria-label");
            if (ariaLabel) {
              return normalize(ariaLabel);
            }
            const labelledBy = element.getAttribute("aria-labelledby");
            if (labelledBy) {
              const labelNode = document.getElementById(labelledBy.split(/\s+/)[0]);
              if (labelNode) {
                return normalize(labelNode.innerText || labelNode.textContent);
              }
            }
            return "";
          };
          const getName = (element) => normalize(
            element.getAttribute("aria-label")
            || element.innerText
            || element.textContent
            || element.getAttribute("value")
            || element.getAttribute("title")
            || "",
          );
          const toLocatorCandidates = (element) => {
            const candidates = [];
            const testId = element.getAttribute("data-testid");
            const label = getLabel(element);
            const role = element.getAttribute("role") || implicitRole(element);
            const name = getName(element);
            const placeholder = normalize(element.getAttribute("placeholder"));
            const title = normalize(element.getAttribute("title"));
            const altText = normalize(element.getAttribute("alt"));
            const id = normalize(element.id);
            const text = normalize(element.innerText || element.textContent);

            if (testId) candidates.push({ strategy: "testId", locator: { testId }, confidence: 1 });
            if (label) candidates.push({ strategy: "label", locator: { label }, confidence: 0.98 });
            if (role && name) candidates.push({ strategy: "role", locator: { role, name }, confidence: 0.95 });
            if (placeholder) candidates.push({ strategy: "placeholder", locator: { placeholder }, confidence: 0.92 });
            if (title) candidates.push({ strategy: "title", locator: { title }, confidence: 0.86 });
            if (altText) candidates.push({ strategy: "altText", locator: { altText }, confidence: 0.84 });
            if (text && ["button", "a"].includes(element.tagName.toLowerCase())) {
              candidates.push({ strategy: "text", locator: { text }, confidence: 0.8 });
            }
            // `#123abc` is not a valid CSS selector even though it is a valid
            // id, so the attribute form is used instead.
            if (id) candidates.push({ strategy: "css", locator: { css: `[id="${id.replaceAll('"', '\\"')}"]` }, confidence: 0.45 });

            return candidates;
          };

          const interactiveElements = [];
          const selector = "button, a, input, textarea, select, [role], [data-testid], [aria-label], [placeholder], [contenteditable='true']";
          for (const element of document.querySelectorAll(selector)) {
            if (!isVisible(element)) {
              continue;
            }

            const role = element.getAttribute("role") || implicitRole(element);
            const label = getLabel(element);
            const text = normalize(element.innerText || element.textContent);
            const candidates = toLocatorCandidates(element);
            interactiveElements.push({
              domPath: domPath(element),
              tagName: element.tagName.toLowerCase(),
              inputType: normalize(element.getAttribute("type")),
              role,
              id: normalize(element.id),
              name: normalize(element.getAttribute("name")),
              testId: normalize(element.getAttribute("data-testid")),
              label,
              text,
              placeholder: normalize(element.getAttribute("placeholder")),
              title: normalize(element.getAttribute("title")),
              href: normalize(element.getAttribute("href")),
              locatorCandidates: candidates,
              bestLocator: candidates[0]?.locator || null,
            });

            if (interactiveElements.length >= limit) {
              break;
            }
          }

          const headings = [...document.querySelectorAll("h1, h2, h3")]
            .map((heading) => normalize(heading.innerText || heading.textContent))
            .filter(Boolean)
            .slice(0, 20);

          const visibleText = [...document.querySelectorAll("main, section, article, body")]
            .flatMap((node) => normalize(node.innerText || node.textContent).split(/(?<=\.)\s+/))
            .map((entry) => normalize(entry))
            .filter(Boolean)
            .slice(0, 20);

          return {
            title: document.title,
            url: window.location.href,
            headings,
            visibleText,
            interactiveElements,
          };
        }, { maxElements, maxTextLength });

        const verification = verifyLocators
          ? await this.verifyLocatorCandidates(pageRecord.page, snapshot.interactiveElements, maxVerifiedCandidates)
          : null;

        return {
          pageId,
          sessionId,
          url: pageRecord.page.url(),
          title: await pageRecord.page.title().catch(() => null),
          ...snapshot,
          locatorVerification: verification,
        };
      });
    });
  }

  // The in-page pass can only guess: it scored candidates by strategy
  // (testId 1.0, label 0.98, ...) without ever checking that the locator
  // actually resolves to that one element. A confident-looking role+name can
  // match six buttons, which is how an agent ends up clicking the wrong one.
  // This resolves each candidate with Playwright's own engine and reports the
  // real match count.
  async verifyLocatorCandidates(page, elements, maxVerifiedCandidates) {
    const summary = { verified: 0, unique: 0, ambiguous: 0, notFound: 0, refined: 0, errors: 0 };

    const countFor = async (locator) => {
      try {
        // count() resolves immediately; it does not auto-wait.
        return await resolveLocator(page, locator).count();
      } catch {
        summary.errors += 1;
        return null;
      }
    };

    for (const element of elements) {
      const candidates = Array.isArray(element.locatorCandidates) ? element.locatorCandidates : [];
      let chosen = null;

      for (const candidate of candidates.slice(0, maxVerifiedCandidates)) {
        const matchCount = await countFor(candidate.locator);
        candidate.matchCount = matchCount;
        candidate.unique = matchCount === 1;
        if (matchCount === null) {
          candidate.verifiedConfidence = 0;
          candidate.note = "locator could not be evaluated";
        } else if (matchCount === 1) {
          candidate.verifiedConfidence = candidate.confidence;
        } else if (matchCount === 0) {
          candidate.verifiedConfidence = 0;
          candidate.note = "matches nothing";
        } else {
          // Ambiguity is the failure mode that matters, so it costs more than a
          // weaker-but-unique strategy.
          candidate.verifiedConfidence = Number((candidate.confidence / (matchCount + 1)).toFixed(3));
          candidate.note = `matches ${matchCount} elements`;

          if (element.text) {
            const refined = { ...candidate.locator, hasText: element.text };
            const refinedCount = await countFor(refined);
            if (refinedCount === 1) {
              candidate.refinedLocator = refined;
              candidate.note += "; narrowed by hasText";
              summary.refined += 1;
            }
          }

          // Identical siblings cannot be told apart by text, so fall back to a
          // concrete index. This keeps the element addressable instead of
          // leaving the caller with a locator that hits the wrong node.
          if (!candidate.refinedLocator && element.domPath && matchCount <= 50) {
            const index = await this.findLocatorIndex(page, candidate.locator, element.domPath);
            if (index !== null) {
              candidate.refinedLocator = { ...candidate.locator, nth: index };
              candidate.note += `; use nth ${index}`;
              summary.refined += 1;
            }
          }
        }

        summary.verified += 1;
        if (candidate.unique) {
          // A naturally unique locator beats any index-based fallback, so stop
          // here; an nth is positional and breaks when the page reorders.
          chosen = candidate.locator;
          break;
        }
      }

      if (!chosen) {
        const refined = candidates.find((candidate) => candidate.refinedLocator);
        chosen = refined?.refinedLocator || null;
      }

      element.locatorCandidates = [...candidates].sort(
        (left, right) => (right.verifiedConfidence ?? right.confidence) - (left.verifiedConfidence ?? left.confidence),
      );
      element.bestLocator = chosen || element.locatorCandidates[0]?.locator || null;
      element.locatorUnique = Boolean(chosen);

      const verifiedCandidates = element.locatorCandidates.filter((entry) => entry.matchCount !== undefined);
      if (chosen) {
        element.locatorStatus = "unique";
        summary.unique += 1;
      } else if (verifiedCandidates.some((entry) => (entry.matchCount ?? 0) > 1)) {
        element.locatorStatus = "ambiguous";
        summary.ambiguous += 1;
      } else {
        element.locatorStatus = "not-found";
        summary.notFound += 1;
      }

      if (chosen) {
        element.enabled = await resolveLocator(page, chosen).isEnabled().catch(() => null);
      }

      delete element.domPath;
    }

    return {
      ...summary,
      guidance: summary.ambiguous
        ? "Prefer candidates with locatorStatus \"unique\". For an ambiguous element use refinedLocator, or add hasText or nth yourself."
        : "Every inspected element resolved to exactly one node.",
    };
  }

  // One round trip: ask every matched node for its own path and find ours.
  async findLocatorIndex(page, locator, domPath) {
    try {
      const paths = await resolveLocator(page, locator).evaluateAll((nodes) => nodes.map((node) => {
        const parts = [];
        for (let current = node; current && current.parentNode; current = current.parentNode) {
          parts.unshift([...current.parentNode.childNodes].indexOf(current));
        }
        return parts.join("/");
      }));
      const index = paths.indexOf(domPath);
      return index >= 0 ? index : null;
    } catch {
      return null;
    }
  }

  async screenshot(sessionId, pageId, request = {}, lockedSession = null) {
    return this.runLocked(sessionId, lockedSession, async (session) => {
      return this.runPageCommandLocked(session, pageId, "page.screenshot", request, async (pageRecord) => {
        const extension = request.type || "png";
        await pageRecord.page.waitForLoadState("domcontentloaded").catch(() => undefined);
        const buffer = await pageRecord.page.screenshot(cleanObject({
          fullPage: request.fullPage ?? true,
          timeout: request.timeoutMs || 30000,
          omitBackground: request.omitBackground,
          quality: request.quality,
          type: extension,
        }));
        const artifact = await this.saveArtifact(session, {
          contextId: pageRecord.contextId,
          pageId,
          type: "screenshot",
          extension,
          buffer,
          metadata: request,
        });
        return {
          pageId,
          artifact,
        };
      });
    });
  }

  async pdf(sessionId, pageId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      if (session.browserType !== "chromium") {
        throw new ApiError(400, "PDF_UNSUPPORTED", "PDF is only supported for chromium sessions");
      }
      return this.runPageCommandLocked(session, pageId, "page.pdf", request, async (pageRecord) => {
        const buffer = await pageRecord.page.pdf(cleanObject({
          format: request.format,
          landscape: request.landscape,
          margin: request.margin,
          printBackground: request.printBackground ?? true,
          scale: request.scale,
        }));
        const artifact = await this.saveArtifact(session, {
          contextId: pageRecord.contextId,
          pageId,
          type: "pdf",
          extension: "pdf",
          buffer,
          metadata: request,
        });
        return {
          pageId,
          artifact,
        };
      });
    });
  }

  async startTrace(sessionId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, request.contextId);
      if (contextRecord.tracing) {
        throw new ApiError(409, "TRACE_ALREADY_STARTED", `Tracing is already active for context ${contextRecord.contextId}`);
      }
      await contextRecord.context.tracing.start({
        name: request.name,
        screenshots: request.screenshots ?? true,
        snapshots: request.snapshots ?? true,
        sources: request.sources ?? true,
        title: request.title,
      });
      contextRecord.tracing = true;
      contextRecord.updatedAt = toIso();
      this.touch(session);
      return {
        contextId: contextRecord.contextId,
        tracing: true,
      };
    });
  }

  async stopTrace(sessionId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      const contextRecord = this.getContextRecord(session, request.contextId);
      if (!contextRecord.tracing) {
        throw new ApiError(409, "TRACE_NOT_STARTED", `Tracing was never started for context ${contextRecord.contextId}`);
      }
      const traceId = createId("trace");
      const tracePath = path.join(this.options.artifactsDir, session.sessionId, `${traceId}.zip`);
      await contextRecord.context.tracing.stop({ path: tracePath });
      contextRecord.tracing = false;
      contextRecord.updatedAt = toIso();
      this.touch(session);
      const stats = await fsPromises.stat(tracePath);
      const artifact = {
        artifactId: traceId,
        contextId: contextRecord.contextId,
        pageId: null,
        type: "trace",
        fileName: path.basename(tracePath),
        absolutePath: tracePath,
        createdAt: toIso(),
        sizeBytes: stats.size,
        metadata: request,
      };
      session.artifacts.set(traceId, artifact);
      this.indexArtifact(session.sessionId, artifact);
      return {
        contextId: contextRecord.contextId,
        tracing: false,
        artifact: this.serializeArtifact(session.sessionId, artifact),
      };
    });
  }

  async runStepLocked(session, pageId, step) {
    switch (step.action) {
      case "apiRequest": {
        // Default to the page's own context so the request carries its cookies.
        const contextId = step.contextId || this.getPageRecord(session, pageId).contextId;
        return this.apiRequest(session.sessionId, contextId, step, session);
      }
      case "assertApiResponse": {
        const contextId = step.contextId || this.getPageRecord(session, pageId).contextId;
        const response = await this.apiRequest(session.sessionId, contextId, step, session);
        assertApiResponse(response, step);
        return response;
      }
      case "assertValue":
        assertCapturedValue(step);
        return { value: step.value, success: true };
      case "assertDownload":
        return this.assertDownload(session, step);
      case "goto":
      case "reload":
      case "goBack":
      case "goForward":
        return this.navigate(session.sessionId, pageId, step.action, step, session);
      case "click":
      case "fill":
      case "press":
      case "selectOption":
      case "hover":
      case "drag":
      case "evaluate":
      case "locatorQuery":
        return this.pageAction(session.sessionId, pageId, step.action, step, session);
      case "assertVisible":
        return this.pageAssert(session.sessionId, pageId, "visible", step, session);
      case "assertText":
        return this.pageAssert(session.sessionId, pageId, "text", step, session);
      case "assertUrl":
        return this.pageAssert(session.sessionId, pageId, "url", step, session);
      case "assertCount":
        return this.pageAssert(session.sessionId, pageId, "count", step, session);
      case "waitFor":
        return this.waitFor(session.sessionId, pageId, step, session);
      case "screenshot":
        return this.screenshot(session.sessionId, pageId, step, session);
      default:
        // A control-flow action is handled by the compiler, never dispatched as
        // a page command. Reaching here means a caller bypassed compileWorkflow.
        if (CONTROL_FLOW_ACTIONS.has(step.action)) {
          throw new ApiError(
            400,
            "INVALID_STEP",
            `${step.action} is a control-flow action and only works inside an execute workflow`,
          );
        }
        throw new ApiError(400, "INVALID_STEP", `Unsupported execute step: ${step.action}`);
    }
  }

  // Answers the page-state half of a condition. A condition is a question, so
  // "the element is not visible" has to come back as false; only a locator the
  // page cannot even evaluate is an error. Conflating the two would turn every
  // untaken branch into a failed workflow.
  async probeCondition(session, pageId, spec, label) {
    const outcome = await this.runPageCommandLocked(
      session,
      pageId,
      "condition.probe",
      { label, ...spec },
      async (pageRecord) => {
        const page = pageRecord.page;
        const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 2000, 0), 30000);

        if (spec.locator) {
          const locator = resolveLocator(page, spec.locator);
          if (spec.count !== undefined) {
            const count = await locator.count();
            return { matched: countMatches(count, Number(spec.count), spec.operator || "eq"), count };
          }
          if (spec.text !== undefined) {
            const actual = (await locator.first().textContent().catch(() => null)) ?? "";
            return {
              matched: textMatches(actual, normalizePattern(spec.text), spec.match || "contains"),
              actual: truncate(actual, 200),
            };
          }
          try {
            await locator.waitFor({ state: spec.state || "visible", timeout: timeoutMs });
            return { matched: true };
          } catch (error) {
            if (isTimeoutError(error)) {
              return { matched: false };
            }
            throw error;
          }
        }

        if (spec.url !== undefined) {
          return { matched: textMatches(page.url(), normalizePattern(spec.url), spec.match || "contains"), actual: page.url() };
        }

        try {
          await page.waitForLoadState(spec.loadState, { timeout: timeoutMs });
          return { matched: true };
        } catch (error) {
          if (isTimeoutError(error)) {
            return { matched: false };
          }
          throw error;
        }
      },
    );

    return outcome.matched;
  }

  // The whole batch runs under a single session lock so a concurrent request
  // cannot navigate the page out from under step N+1.
  async execute(sessionId, request = {}) {
    if (!Array.isArray(request.steps) || !request.steps.length) {
      throw new ApiError(400, "INVALID_REQUEST", "steps must be a non-empty array");
    }
    if (!request.pageId) {
      throw new ApiError(400, "INVALID_REQUEST", "pageId is required");
    }

    // Compiled before the lock is taken: a malformed workflow should be a 400
    // without touching the browser.
    const { program, gateCount } = compileWorkflow(request.steps);
    const state = newWorkflowState(request.variables || {});

    return this.withLock(sessionId, async (session) => {
      this.getPageRecord(session, request.pageId);
      return this.driveWorkflow(session, {
        pageId: request.pageId,
        program,
        state,
        gateCount,
        continueOnError: Boolean(request.continueOnError),
        limits: normalizeWorkflowLimits(request.limits),
        stepCount: request.steps.length,
        results: [],
      });
    });
  }

  // Shared by execute and resume so both paths report the same shape and both
  // suspend the same way.
  async driveWorkflow(session, context) {
    const hooks = {
      exec: (step) => this.runStepLocked(session, context.pageId, step),
      probe: (spec, label) => this.probeCondition(session, context.pageId, spec, label),
    };

    const outcome = await runWorkflow(context.program, context.state, hooks, {
      results: context.results,
      continueOnError: context.continueOnError,
      limits: context.limits,
    });

    const base = {
      pageId: context.pageId,
      status: outcome.status,
      stepCount: context.stepCount,
      executedCount: context.state.executed,
      failedCount: context.results.filter((entry) => entry.status === "error").length,
      captured: context.state.captured,
      results: context.results,
    };

    if (outcome.status !== "awaiting_approval") {
      return base;
    }

    const approval = this.suspendForApproval(session, context, outcome);
    return { ...base, approval };
  }

  // A gate pauses the workflow and hands the decision to a person. The machine
  // state is kept here, not in the request, so a caller cannot resume from a
  // program counter it made up.
  suspendForApproval(session, context, outcome) {
    this.pruneApprovals();
    // Each suspended workflow keeps its whole program, captured values and
    // results in memory, and one session can suspend many. Without a cap, a
    // caller that never decides anything grows the server without bound.
    if (this.pendingApprovals.size >= this.options.maxPendingApprovals) {
      throw new ApiError(
        429,
        "APPROVAL_LIMIT_EXCEEDED",
        `${this.pendingApprovals.size} workflows are already waiting for approval (MAX_PENDING_APPROVALS). `
        + "Decide or let the pending ones expire first.",
      );
    }
    const gate = outcome.gate;
    const gateId = createId("gate");
    const timeoutMs = Math.min(Math.max(Number(gate.timeoutMs) || config.approvalTimeoutMs, 60000), 86400000);
    const approvers = Array.isArray(gate.approvers) ? gate.approvers.map(String) : null;
    const record = {
      gateId,
      sessionId: session.sessionId,
      pageId: context.pageId,
      name: gate.name,
      message: gate.message ?? null,
      approvers,
      saveAs: gate.saveAs || gate.name,
      onReject: gate.onReject === "continue" ? "continue" : "stop",
      createdAt: toIso(),
      expiresAt: toIso(Date.now() + timeoutMs),
      status: "pending",
      decision: null,
      decidedBy: null,
      decidedAt: null,
      comment: null,
      path: outcome.gateAt !== undefined ? context.program[outcome.gateAt]?.at : undefined,
      // The continuation: program, counter, captured bag and loop frames.
      program: context.program,
      state: context.state,
      gateCount: context.gateCount,
      continueOnError: context.continueOnError,
      limits: context.limits,
      stepCount: context.stepCount,
      results: context.results,
    };
    this.pendingApprovals.set(gateId, record);
    this.touch(session);
    console.log(`[approval] waiting gateId=${gateId} name=${gate.name} sessionId=${session.sessionId}`);
    return this.serializeApproval(record);
  }

  serializeApproval(record) {
    return cleanObject({
      gateId: record.gateId,
      sessionId: record.sessionId,
      pageId: record.pageId,
      name: record.name,
      message: record.message,
      approvers: record.approvers,
      path: record.path,
      status: record.status,
      decision: record.decision,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      comment: record.comment,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      remainingInstructions: Math.max(0, record.program.length - record.state.pc),
      captured: record.state.captured,
    });
  }

  // A suspended workflow holds a browser page open, so an abandoned gate has to
  // expire rather than pin the session forever.
  pruneApprovals() {
    const now = Date.now();
    for (const [gateId, record] of this.pendingApprovals) {
      if (Date.parse(record.expiresAt) <= now) {
        this.pendingApprovals.delete(gateId);
        console.log(`[approval] expired gateId=${gateId} name=${record.name}`);
      }
    }
  }

  // The continuation needs the page it was suspended on, so a closed session
  // takes its gates with it rather than leaving them to be resumed into nothing.
  discardApprovals(sessionId, reason) {
    for (const [gateId, record] of this.pendingApprovals) {
      if (record.sessionId === sessionId) {
        this.pendingApprovals.delete(gateId);
        console.log(`[approval] dropped gateId=${gateId} name=${record.name} session ${reason}`);
      }
    }
  }

  getApproval(gateId, sessionId) {
    this.pruneApprovals();
    const record = this.pendingApprovals.get(gateId);
    if (!record) {
      throw new ApiError(
        404,
        "APPROVAL_NOT_FOUND",
        `No approval is waiting under ${gateId}. It may have been decided, expired, or its session closed.`,
      );
    }
    if (sessionId && record.sessionId !== sessionId) {
      throw new ApiError(404, "APPROVAL_NOT_FOUND", `No approval is waiting under ${gateId} for session ${sessionId}`);
    }
    return record;
  }

  listApprovals(sessionId) {
    this.pruneApprovals();
    return [...this.pendingApprovals.values()]
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .map((record) => this.serializeApproval(record));
  }

  // Records the decision. `decidedBy` is an audit field, not an identity: the
  // API token says which client called, not which person approved. Tying a gate
  // to an authenticated user is the per-project roles work, still to come.
  decideApproval(sessionId, gateId, request = {}) {
    const record = this.getApproval(gateId, sessionId);
    if (record.status !== "pending") {
      throw new ApiError(409, "APPROVAL_ALREADY_DECIDED", `${gateId} was already ${record.status}`);
    }

    const decision = String(request.decision || "").toLowerCase();
    if (decision !== "approve" && decision !== "reject") {
      throw new ApiError(400, "INVALID_DECISION", `decision must be approve or reject (got ${request.decision})`);
    }

    const decidedBy = String(request.decidedBy || "").trim();
    if (!decidedBy) {
      throw new ApiError(400, "INVALID_REQUEST", "decidedBy is required so the decision can be attributed");
    }
    if (record.approvers && !record.approvers.includes(decidedBy)) {
      throw new ApiError(
        403,
        "APPROVER_NOT_LISTED",
        `${decidedBy} is not in the approvers list for ${record.name}: ${record.approvers.join(", ")}`,
      );
    }

    record.status = decision === "approve" ? "approved" : "rejected";
    record.decision = record.status;
    record.decidedBy = decidedBy;
    record.decidedAt = toIso();
    record.comment = request.comment ? truncate(String(request.comment), 1000) : null;
    console.log(`[approval] ${record.status} gateId=${gateId} by=${decidedBy}`);
    return this.serializeApproval(record);
  }

  async resumeExecution(sessionId, request = {}) {
    const record = this.getApproval(request.gateId, sessionId);
    if (record.status === "pending") {
      throw new ApiError(
        409,
        "APPROVAL_PENDING",
        `${record.gateId} has not been decided yet. Record a decision first, then resume.`,
      );
    }

    return this.withLock(sessionId, async (session) => {
      // The page may have been closed while the gate was waiting.
      this.getPageRecord(session, record.pageId);
      record.state.captured[record.saveAs] = record.status;
      record.state.pc += 1;

      if (record.status === "rejected" && record.onReject === "stop") {
        this.pendingApprovals.delete(record.gateId);
        record.results.push(cleanObject({
          index: record.state.sequence,
          path: record.path,
          action: "approval",
          status: "rejected",
          result: { decision: record.status, decidedBy: record.decidedBy, comment: record.comment },
        }));
        return {
          pageId: record.pageId,
          status: "rejected",
          stepCount: record.stepCount,
          executedCount: record.state.executed,
          failedCount: record.results.filter((entry) => entry.status === "error").length,
          captured: record.state.captured,
          results: record.results,
          approval: this.serializeApproval(record),
        };
      }

      record.results.push(cleanObject({
        index: record.state.sequence,
        path: record.path,
        action: "approval",
        status: "ok",
        result: { decision: record.status, decidedBy: record.decidedBy, comment: record.comment },
      }));
      record.state.sequence += 1;
      this.pendingApprovals.delete(record.gateId);

      return this.driveWorkflow(session, {
        gateId: record.gateId,
        pageId: record.pageId,
        program: record.program,
        state: record.state,
        gateCount: record.gateCount,
        continueOnError: record.continueOnError,
        limits: record.limits,
        stepCount: record.stepCount,
        results: record.results,
      });
    });
  }

  // Reads the standalone index, so listing and downloading keep working after
  // the session that produced the artifacts is gone.
  async listArtifacts(sessionId) {
    return [...this.artifactIndex.values()]
      .filter((artifact) => artifact.sessionId === sessionId)
      .map((artifact) => this.serializeArtifact(sessionId, artifact));
  }

  getArtifact(sessionId, artifactId) {
    const artifact = this.artifactIndex.get(artifactId);
    if (!artifact || (sessionId && artifact.sessionId !== sessionId)) {
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  // Actions, the browser events each one caused, and the artifacts it produced
  // were three separate lists a caller had to correlate by hand. Finding out why
  // step 7 failed meant eyeballing timestamps across all three.
  async buildTimeline(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    const includeEvents = options.includeEvents !== false;
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 2000);
    const actions = session.actions.slice(-limit);

    // One pass over the events, bucketed by the range each action claimed.
    const eventsBySeq = new Map();
    for (const event of session.events) {
      eventsBySeq.set(event.seq, event);
    }

    const entries = actions.map((action) => {
      const events = [];
      if (action.fromEventSeq !== undefined) {
        for (let seq = action.fromEventSeq; seq <= (action.toEventSeq ?? 0); seq += 1) {
          const event = eventsBySeq.get(seq);
          if (event) {
            events.push(event);
          }
        }
      }

      const issues = [];
      for (const event of events) {
        const severity = SessionManager.classifyEvent(event);
        if (!severity) {
          continue;
        }
        issues.push(cleanObject({
          severity,
          type: event.type,
          level: event.level,
          status: event.status,
          url: event.url,
          message: truncate(event.message || event.text, 500),
        }));
      }

      const artifacts = (action.artifactIds || [])
        .map((artifactId) => this.artifactIndex.get(artifactId))
        .filter(Boolean)
        .map((artifact) => this.serializeArtifact(sessionId, artifact));

      return cleanObject({
        actionId: action.actionId,
        type: action.type,
        status: action.status,
        pageId: action.pageId,
        contextId: action.contextId,
        startedAt: action.startedAt ?? action.ts,
        endedAt: action.ts,
        durationMs: action.durationMs ?? null,
        url: action.url,
        input: action.input,
        output: action.output,
        error: action.error,
        artifacts: artifacts.length ? artifacts : undefined,
        issueCount: issues.length,
        issues: issues.length ? issues : undefined,
        events: includeEvents && events.length ? events : undefined,
      });
    });

    const durations = entries.map((entry) => entry.durationMs).filter((value) => typeof value === "number");
    const slowest = [...entries]
      .filter((entry) => typeof entry.durationMs === "number")
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5)
      .map((entry) => ({ actionId: entry.actionId, type: entry.type, durationMs: entry.durationMs }));

    return {
      sessionId,
      actionCount: session.actions.length,
      eventCount: session.events.length,
      returned: entries.length,
      totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
      failedCount: entries.filter((entry) => entry.status === "error").length,
      withIssuesCount: entries.filter((entry) => entry.issueCount > 0).length,
      slowest,
      entries,
    };
  }

  async listActions(sessionId) {
    const session = this.getSession(sessionId);
    return {
      sessionId,
      actions: session.actions,
      events: session.events,
    };
  }
}

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const INLINE_ARTIFACT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webm": "video/webm",
};

// `res.download` always forces a download, which broke the playground's inline
// screenshot preview. `?disposition=inline` serves the same file for viewing.
function sendArtifact(req, res, absolutePath, fileName) {
  const inline = String(req.query.disposition || "").toLowerCase() === "inline";
  const contentType = INLINE_ARTIFACT_TYPES[path.extname(fileName).toLowerCase()];
  if (inline && contentType) {
    res.type(contentType);
    res.setHeader("Content-Disposition", `inline; filename="${safeFilename(fileName)}"`);
    return res.sendFile(absolutePath);
  }

  return res.download(absolutePath, fileName);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

// JSON embedded in an inline <script> has to survive HTML parsing: `</script>`
// and the line separators that are newlines in HTML but not in JS.
function toInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host") || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}

function normalizeLanguageTag(value) {
  return /^ko\b/i.test(String(value || "").trim()) ? "ko" : "en";
}

function resolveRequestLanguage(req) {
  const queryLanguage = typeof req?.query?.lang === "string" ? req.query.lang : "";
  const acceptLanguage = req?.headers?.["accept-language"] || "";
  return normalizeLanguageTag(queryLanguage || acceptLanguage);
}

function appendLanguageParam(pathname, language) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}lang=${language}`;
}

function containsKoreanText(value) {
  return /[\u3131-\u318e\uac00-\ud7a3]/.test(String(value || ""));
}

// `language` doubles as the ko/en authoring locale, so "ts" there would silently
// switch the prose language. `scriptLanguage` is the explicit field; passing
// "ts" in `language` still works for callers written against 0.1.4.
function resolveScriptLanguage(request = {}) {
  const raw = String(request.scriptLanguage || request.fileLanguage || request.language || "").toLowerCase();
  return ["ts", "typescript"].includes(raw) ? "ts" : "js";
}

function resolveAuthoringLanguage(request = {}) {
  const requested = String(request.language || "").toLowerCase();
  const localeHint = ["ts", "typescript", "js", "javascript"].includes(requested) ? "" : request.language;
  return normalizeLanguageTag(
    localeHint
    || request.locale
    || (containsKoreanText(request.goal || request.prompt || request.request || "") ? "ko" : "en"),
  );
}

function getAuthoringCopy(language) {
  return language === "ko" ? {
    inspectFirst: "locator가 구체적이지 않으면 page_inspect로 먼저 화면 구조를 수집하세요.",
    preferStable: "CSS/XPath보다 role, label, placeholder, testId를 우선 사용하세요.",
    noSteps: "먼저 page_inspect를 호출하고, 이 주석을 실제 click/fill/assert 단계로 바꾸세요.",
    needUserName: "페이지를 분석해서 사용자명 또는 이메일 locator를 채워 주세요.",
    needPassword: "페이지를 분석해서 비밀번호 locator를 채워 주세요.",
    needSubmit: "페이지를 분석해서 제출 버튼 locator를 채워 주세요.",
    needSearchInput: "페이지를 분석해서 검색 입력 locator를 채워 주세요.",
    needSearchSubmit: "페이지를 분석해서 검색 실행 버튼 locator를 채워 주세요.",
    needMessageInput: "페이지를 분석해서 메시지 입력 locator를 채워 주세요.",
    needSendButton: "페이지를 분석해서 메시지 전송 버튼 locator를 채워 주세요.",
    assertExpectation: "다음 기대 결과를 검증하세요",
  } : {
    inspectFirst: "Use page_inspect before finalizing locators whenever the request does not already include concrete locator hints.",
    preferStable: "Prefer role, label, placeholder, and testId locators over CSS and XPath.",
    noSteps: "Use page_inspect first, then replace this comment with concrete click/fill/assert steps.",
    needUserName: "Inspect the page and provide username/email locator.",
    needPassword: "Inspect the page and provide password locator.",
    needSubmit: "Inspect the page and provide submit button locator.",
    needSearchInput: "Inspect the page and provide search input locator.",
    needSearchSubmit: "Inspect the page and provide search submit locator.",
    needMessageInput: "Inspect the page and provide message input locator.",
    needSendButton: "Inspect the page and provide send button locator.",
    assertExpectation: "Assert expectation",
  };
}

function collectInspectionElements(request = {}) {
  const inspection = request.pageInspection || request.inspection || request.snapshot;
  if (!inspection || !Array.isArray(inspection.interactiveElements)) {
    return [];
  }
  return inspection.interactiveElements;
}

function pickBestInspectionLocator(element) {
  if (!element) {
    return null;
  }
  const candidate = Array.isArray(element.locatorCandidates) && element.locatorCandidates.length
    ? element.locatorCandidates[0]
    : null;
  return candidate?.locator || element.bestLocator || null;
}

function scoreInspectionElement(element, keywords = [], options = {}) {
  const haystack = [
    element?.role,
    element?.label,
    element?.text,
    element?.placeholder,
    element?.title,
    element?.testId,
    element?.name,
    element?.id,
    element?.href,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(String(keyword).toLowerCase())) {
      score += 10;
    }
  }

  if (options.preferRole && element?.role === options.preferRole) {
    score += 6;
  }
  if (options.preferTag && element?.tagName === options.preferTag) {
    score += 4;
  }
  if (options.preferTestId && element?.testId) {
    score += 4;
  }

  return score;
}

function findInspectionLocator(request, keywords, options = {}) {
  const elements = collectInspectionElements(request);
  let bestElement = null;
  let bestScore = 0;

  for (const element of elements) {
    const score = scoreInspectionElement(element, keywords, options);
    if (score > bestScore) {
      bestScore = score;
      bestElement = element;
    }
  }

  return bestScore > 0 ? pickBestInspectionLocator(bestElement) : null;
}

function inferLocatorsFromInspection(request = {}) {
  return cleanObject({
    username: findInspectionLocator(request, ["email", "e-mail", "user", "username", "아이디", "이메일", "사용자"], { preferRole: "textbox" }),
    email: findInspectionLocator(request, ["email", "e-mail", "이메일"], { preferRole: "textbox" }),
    password: findInspectionLocator(request, ["password", "비밀번호"], { preferRole: "textbox" }),
    submit: findInspectionLocator(request, ["login", "sign in", "signin", "continue", "submit", "로그인", "계속"], { preferRole: "button", preferTestId: true }),
    searchInput: findInspectionLocator(request, ["search", "검색"], { preferRole: "textbox" }),
    searchSubmit: findInspectionLocator(request, ["search", "검색"], { preferRole: "button", preferTestId: true }),
    messageInput: findInspectionLocator(request, ["message", "chat", "send", "reply", "메시지", "채팅", "답장"], { preferRole: "textbox", preferTestId: true }),
    sendButton: findInspectionLocator(request, ["send", "submit", "reply", "전송", "보내", "등록"], { preferRole: "button", preferTestId: true }),
  });
}

function buildAssistExamples(language) {
  return language === "ko" ? {
    naturalLanguageRequests: [
      "로그인 후 대시보드에 진입하는 스모크 테스트를 만들어줘.",
      "검색어를 입력하고 결과 목록이 보이는지 확인하는 테스트를 만들어줘.",
      "채팅 입력창에 메시지를 쓰고 전송 후 상태 문구를 검증하는 테스트를 만들어줘.",
    ],
    stepPatterns: {
      loginSmoke: [
        { action: "goto", url: "https://example.com/login" },
        { action: "fill", locator: { label: "이메일" }, valueFrom: "username" },
        { action: "fill", locator: { label: "비밀번호" }, valueFrom: "password" },
        { action: "click", locator: { role: "button", name: "로그인" } },
        { action: "assertUrl", value: "/dashboard", match: "contains" },
      ],
      searchSmoke: [
        { action: "goto", url: "https://example.com" },
        { action: "fill", locator: { placeholder: "검색어 입력" }, valueFrom: "query" },
        { action: "press", locator: { placeholder: "검색어 입력" }, key: "Enter" },
        { action: "assertVisible", locator: { testId: "result-list" } },
      ],
      chatSend: [
        { action: "goto", url: "http://127.0.0.1:3000/demo/test-page?lang=ko" },
        { action: "fill", locator: { testId: "message-input" }, valueFrom: "message" },
        { action: "click", locator: { testId: "send-message" } },
        { action: "assertText", locator: { testId: "status" }, value: "메시지 전송 완료", match: "contains" },
      ],
    },
    locatorGuidelines: [
      "testId가 있으면 가장 먼저 사용하세요.",
      "사용자 표시 문자열은 언어에 따라 바뀔 수 있으니 role+name 또는 label 대신 testId도 같이 고려하세요.",
      "page_inspect 결과의 locatorCandidates 배열에서 confidence가 높은 항목부터 사용하세요.",
    ],
  } : {
    naturalLanguageRequests: [
      "Create a smoke test that logs in and verifies the dashboard loads.",
      "Create a test that searches for a product and verifies the result list is visible.",
      "Create a chat test that sends a message and verifies the status text updates.",
    ],
    stepPatterns: {
      loginSmoke: [
        { action: "goto", url: "https://example.com/login" },
        { action: "fill", locator: { label: "Email" }, valueFrom: "username" },
        { action: "fill", locator: { label: "Password" }, valueFrom: "password" },
        { action: "click", locator: { role: "button", name: "Login" } },
        { action: "assertUrl", value: "/dashboard", match: "contains" },
      ],
      searchSmoke: [
        { action: "goto", url: "https://example.com" },
        { action: "fill", locator: { placeholder: "Search" }, valueFrom: "query" },
        { action: "press", locator: { placeholder: "Search" }, key: "Enter" },
        { action: "assertVisible", locator: { testId: "result-list" } },
      ],
      chatSend: [
        { action: "goto", url: "http://127.0.0.1:3000/demo/test-page?lang=en" },
        { action: "fill", locator: { testId: "message-input" }, valueFrom: "message" },
        { action: "click", locator: { testId: "send-message" } },
        { action: "assertText", locator: { testId: "status" }, value: "Message sent", match: "contains" },
      ],
    },
    locatorGuidelines: [
      "Prefer testId when it is available.",
      "Visible labels and button names can change by locale, so keep a stable testId fallback.",
      "Use high-confidence locatorCandidates from page_inspect first.",
    ],
  };
}


// The built-in pages used to be ~1200 lines of template strings inside this
// file, which made every UI change a server.js change and put CSS next to
// request handling. Markup, styles, scripts and copy now live under public/.
const uiDir = path.join(rootDir, "public");
const uiAssetsPath = "/ui";

// Read once at boot: these are shipped with the image and do not change at
// runtime, and a per-request read would hit the disk on every page view.
const uiTemplates = new Map();
const uiCopy = new Map();

async function loadUiAssets() {
  for (const name of ["home", "playground", "demo", "docs", "runs"]) {
    uiTemplates.set(name, await fsPromises.readFile(path.join(uiDir, `${name}.html`), "utf8"));
  }
  for (const language of ["ko", "en"]) {
    uiCopy.set(language, JSON.parse(await fsPromises.readFile(path.join(uiDir, "locales", `${language}.json`), "utf8")));
  }
}

function readPath(source, dottedKey) {
  return dottedKey.split(".").reduce((value, key) => (value === undefined || value === null ? value : value[key]), source);
}

// `{{copy.x}}` is HTML-escaped, `{{json.x}}` is script-safe JSON, `{{raw.x}}` is
// inserted verbatim for fragments this file composes. An unknown key throws
// rather than rendering blank, so a typo in a template is loud.
function renderUiTemplate(name, scopes) {
  const template = uiTemplates.get(name);
  if (!template) {
    throw new ApiError(500, "UI_TEMPLATE_MISSING", `No template for ${name}; is public/ present in the image?`);
  }

  return template.replace(/\{\{\s*(copy|config|json|raw)\.([A-Za-z0-9_.]+)\s*\}\}/g, (match, scope, key) => {
    const value = readPath(scopes[scope], key);
    if (value === undefined) {
      throw new ApiError(500, "UI_TEMPLATE_KEY_MISSING", `${match} in ${name}.html has no value`);
    }
    if (scope === "json") {
      return toInlineJson(value);
    }
    return scope === "raw" ? String(value) : escapeHtml(value);
  });
}

// Locale strings carry the same placeholders, so paths and the service name stay
// in one place instead of being duplicated per language.
function getPageCopy(language) {
  const copy = uiCopy.get(language) || uiCopy.get("en");
  const replacements = {
    "{{config.serviceName}}": config.serviceName,
    "{{config.openApiPath}}": documentationPaths.openApi,
    "{{config.docsPath}}": documentationPaths.docs,
    "{{config.playgroundPath}}": documentationPaths.playground,
    "{{config.swaggerAssetsPath}}": documentationPaths.swaggerAssets,
  };
  const resolve = (value) => {
    if (typeof value === "string") {
      let out = value;
      for (const [placeholder, actual] of Object.entries(replacements)) {
        out = out.split(placeholder).join(actual);
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map(resolve);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value;
  };

  return resolve(copy);
}

function uiConfig(language) {
  return {
    language,
    serviceName: config.serviceName,
    apiBasePath: config.apiBasePath,
    uiAssetsPath,
    openApiPath: documentationPaths.openApi,
    swaggerAssetsPath: documentationPaths.swaggerAssets,
    docsPath: appendLanguageParam(documentationPaths.docs, language),
    playgroundPath: appendLanguageParam(documentationPaths.playground, language),
    runsPath: appendLanguageParam(documentationPaths.runs, language),
    demoPath: appendLanguageParam("/demo/test-page", language),
  };
}

function renderLanguageSwitcher(currentPath, language) {
  const links = [
    { code: "ko", label: "한국어" },
    { code: "en", label: "English" },
  ];

  return `
    <nav class="language-switcher" aria-label="Language">
      ${links.map((entry) => `
        <a href="${escapeHtml(appendLanguageParam(currentPath, entry.code))}" class="${entry.code === language ? "active" : ""}">
          ${escapeHtml(entry.label)}
        </a>
      `).join("")}
    </nav>
  `;
}

function renderHomePage(req) {
  const baseUrl = getBaseUrl(req);
  const language = resolveRequestLanguage(req);
  const copy = getPageCopy(language).home;
  const entries = [
    { href: appendLanguageParam(documentationPaths.docs, language), label: copy.swaggerLabel, description: copy.swaggerDescription },
    { href: appendLanguageParam(documentationPaths.playground, language), label: copy.playgroundLabel, description: copy.playgroundDescription },
    { href: appendLanguageParam(documentationPaths.runs, language), label: copy.runsLabel, description: copy.runsDescription },
    { href: appendLanguageParam("/demo/test-page", language), label: copy.demoLabel, description: copy.demoDescription },
    { href: documentationPaths.openApi, label: copy.openApiLabel, description: copy.openApiDescription },
    { href: "/health", label: copy.healthLabel, description: copy.healthDescription },
  ];

  return renderUiTemplate("home", {
    copy,
    config: uiConfig(language),
    raw: {
      languageSwitcher: renderLanguageSwitcher("/", language),
      cards: entries.map((entry) => `
    <a class="card" href="${escapeHtml(entry.href)}">
      <strong>${escapeHtml(entry.label)}</strong>
      <span>${escapeHtml(entry.description)}</span>
      <code>${escapeHtml(baseUrl + entry.href)}</code>
    </a>
  `).join(""),
    },
  });
}

function renderSwaggerPage(req) {
  const language = resolveRequestLanguage(req);
  return renderUiTemplate("docs", {
    copy: {},
    config: uiConfig(language),
    json: { openApiUrl: `${getBaseUrl(req)}${documentationPaths.openApi}` },
    raw: {},
  });
}

function renderPlaygroundPage(req) {
  const language = resolveRequestLanguage(req);
  const copy = getPageCopy(language).playground;
  const clientConfig = {
    ...uiConfig(language),
    authRequired: Boolean(config.apiToken),
    copy,
  };

  return renderUiTemplate("playground", {
    copy: { ...copy, defaultVariablesJson: JSON.stringify(copy.defaultVariables, null, 2) },
    config: clientConfig,
    json: { clientConfig },
    raw: { languageSwitcher: renderLanguageSwitcher(documentationPaths.playground, language) },
  });
}

function renderRunsPage(req) {
  const language = resolveRequestLanguage(req);
  const copy = getPageCopy(language).runs;
  const clientConfig = {
    ...uiConfig(language),
    authRequired: Boolean(config.apiToken),
    copy,
  };

  return renderUiTemplate("runs", {
    copy,
    config: clientConfig,
    json: { clientConfig },
    raw: { languageSwitcher: renderLanguageSwitcher(documentationPaths.runs, language) },
  });
}

function renderDemoTestPage(req) {
  const language = resolveRequestLanguage(req);
  const copy = getPageCopy(language).demo;

  return renderUiTemplate("demo", {
    copy,
    config: uiConfig(language),
    json: { copy },
    raw: {
      languageSwitcher: renderLanguageSwitcher("/demo/test-page", language),
      roleOptions: (copy.roleOptions || [])
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join(""),
    },
  });
}

function buildOpenApiSpec(req) {
  const baseUrl = getBaseUrl(req);
  const api = config.apiBasePath;
  const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "string" } });
  const sessionParams = [pathParam("sessionId")];
  const contextParams = [pathParam("sessionId"), pathParam("contextId")];
  const pageParams = [pathParam("sessionId"), pathParam("pageId")];

  // Every REST route is listed here; an endpoint missing from Swagger UI is an
  // endpoint nobody discovers.
  const operation = ({ tag, summary, parameters = [], body, responses }) => cleanObject({
    tags: [tag],
    summary,
    parameters: parameters.length ? parameters : undefined,
    requestBody: body ? { required: false, content: { "application/json": { schema: body } } } : undefined,
    responses: responses || { 200: { description: "Success envelope" } },
  });
  const freeFormBody = { type: "object", additionalProperties: true };
  const pageActionPath = (action, summary, extra = {}) => ({
    [`${api}/sessions/{sessionId}/pages/{pageId}/${action}`]: {
      post: operation({
        tag: "Sessions",
        summary,
        parameters: pageParams,
        body: {
          type: "object",
          properties: {
            locator: { $ref: "#/components/schemas/Locator" },
            timeoutMs: { type: "integer", example: 5000 },
            ...extra,
          },
        },
      }),
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: `${config.serviceName} API`,
      version: config.serviceVersion,
      description: "Stateful Playwright REST API with Streamable MCP support, Swagger UI, and a local demo page for offline automation checks.",
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: "Docs", description: "Built-in documentation and demo endpoints." },
      { name: "Scripts", description: "Script registry and validation APIs." },
      { name: "Runs", description: "Playwright test run orchestration APIs." },
      { name: "Sessions", description: "Stateful low-level browser automation APIs." },
      { name: "MCP", description: "Streamable MCP HTTP endpoint for AI agents." },
    ],
    components: {
      schemas: {
        Locator: {
          type: "object",
          description: "Structured Playwright-friendly locator.",
          properties: {
            role: { type: "string", example: "button" },
            name: { type: "string", example: "Login" },
            text: { type: "string", example: "Ready" },
            label: { type: "string", example: "Email" },
            placeholder: { type: "string", example: "Type a message" },
            testId: { type: "string", example: "status" },
            css: { type: "string", example: "#submit-button" },
            xpath: { type: "string", example: "//button[@type='submit']" },
            selector: { type: "string", example: "[data-testid='status']" },
            exact: { type: "boolean" },
            nth: { type: "integer", minimum: 0 },
          },
        },
        CreateRunRequest: {
          type: "object",
          required: ["scriptKey"],
          properties: {
            scriptKey: { type: "string", example: "checkout/guest-order" },
            project: { type: "string", example: "chromium" },
            grep: { type: "string", example: "@smoke" },
            env: { type: "string", example: "staging" },
            baseURL: { type: "string", example: "https://stg.example.com" },
            headed: { type: "boolean", default: false },
            trace: { type: "string", example: "on-first-retry" },
            video: { type: "string", example: "retain-on-failure" },
            storageStateRef: { type: "string", example: "auth/customer.json" },
            shard: { type: "string", example: "1/3" },
            priority: { type: "integer", default: 0, description: "Higher priority runs ahead of what is already queued" },
            environment: { type: "string", example: "staging", description: "Apply a stored environment; explicit fields here win" },
            dataset: { type: "string", example: "orders", description: "Queue one run per dataset row" },
            datasetRow: { type: "integer", description: "Zero-based row index; omit to queue every row" },
            notify: {
              type: "object",
              required: ["url"],
              description: "POST the result when the run ends. The host must pass NOTIFY_ALLOWLIST (or URL_ALLOWLIST).",
              properties: {
                url: { type: "string", example: "https://ci.example.com/hooks/playwright" },
                on: { type: "string", enum: ["failure", "always"], default: "failure" },
                headers: { type: "object", additionalProperties: { type: "string" } },
              },
            },
            urlAllowlist: {
              type: "array",
              items: { type: "string" },
              example: ["*.staging.example.com"],
              description: "Narrow this run's network policy. It can only restrict URL_ALLOWLIST, never widen it.",
            },
            variables: { type: "object", additionalProperties: true },
          },
        },
        CreateSessionRequest: {
          type: "object",
          properties: {
            browserType: { type: "string", enum: ["chromium", "firefox", "webkit"], default: "chromium" },
            headless: { type: "boolean", default: true },
            ttlMs: { type: "integer", example: 1800000 },
          },
        },
        CreateContextRequest: {
          type: "object",
          properties: {
            baseURL: { type: "string", example: `${baseUrl}/demo/test-page` },
            locale: { type: "string", example: "ko-KR" },
            timezoneId: { type: "string", example: "Asia/Seoul" },
            viewport: {
              type: "object",
              properties: {
                width: { type: "integer", example: 1440 },
                height: { type: "integer", example: 960 },
              },
            },
          },
        },
        WorkflowCondition: {
          type: "object",
          description:
            "Either a value test ({value, equals|contains|matches|in|gt|empty|...}), a page test "
            + "({locator, state|count|text} or {url} or {loadState}), or a combinator ({all}, {any}, {not}). "
            + "A page test that is simply not true comes back false; only a locator the page cannot evaluate errors.",
          properties: {
            value: { type: "string", example: "{{orderStatus}}" },
            equals: { type: "string", example: "APPROVED" },
            contains: { type: "string" },
            matches: { type: "string", example: "/^ORD-\\d+$/" },
            in: { type: "array", items: { type: "string" } },
            gt: { type: "number" },
            empty: { type: "boolean" },
            locator: { $ref: "#/components/schemas/Locator" },
            state: { type: "string", example: "visible" },
            url: { type: "string" },
            loadState: { type: "string", example: "networkidle" },
            timeoutMs: { type: "integer", example: 2000 },
            all: { type: "array", items: { $ref: "#/components/schemas/WorkflowCondition" } },
            any: { type: "array", items: { $ref: "#/components/schemas/WorkflowCondition" } },
            not: { $ref: "#/components/schemas/WorkflowCondition" },
          },
        },
        WorkflowStep: {
          type: "object",
          description:
            "A page action (goto, click, fill, assertText, apiRequest, ...) or one of the control-flow "
            + "actions: if, repeat, forEach, while, break, continue, approval.",
          properties: {
            action: { type: "string", example: "click" },
            url: { type: "string", example: `${baseUrl}/demo/test-page` },
            locator: { $ref: "#/components/schemas/Locator" },
            value: { type: "string" },
            saveAs: { type: "string", example: "orderNumber" },
            when: { $ref: "#/components/schemas/WorkflowCondition" },
            then: { type: "array", items: { $ref: "#/components/schemas/WorkflowStep" } },
            else: { type: "array", items: { $ref: "#/components/schemas/WorkflowStep" } },
            steps: { type: "array", items: { $ref: "#/components/schemas/WorkflowStep" } },
            times: { type: "integer", example: 3 },
            items: { description: "Array, or a {{captured}} reference to one", example: "{{rows}}" },
            as: { type: "string", example: "row" },
            indexAs: { type: "string", example: "i" },
            maxIterations: { type: "integer", example: 50 },
            name: { type: "string", example: "finance", description: "approval: gate name" },
            message: { type: "string", example: "결제 금액을 확인해 주세요" },
            approvers: { type: "array", items: { type: "string" } },
            onReject: { type: "string", enum: ["stop", "continue"], example: "stop" },
            timeoutMs: { type: "integer", example: 3600000 },
          },
        },
        ExecuteBatchRequest: {
          type: "object",
          required: ["pageId", "steps"],
          properties: {
            pageId: { type: "string", example: "page_1234567890abcdef" },
            steps: { type: "array", items: { $ref: "#/components/schemas/WorkflowStep" } },
            variables: { type: "object", additionalProperties: true },
            continueOnError: { type: "boolean", example: false },
            limits: {
              type: "object",
              properties: {
                maxIterations: { type: "integer", example: 200 },
                maxSteps: { type: "integer", example: 500 },
                maxDurationMs: { type: "integer", example: 300000 },
              },
            },
          },
        },
        AssistPlanRequest: {
          type: "object",
          properties: {
            goal: { type: "string", example: "로그인 후 대시보드 진입을 확인하는 스모크 테스트" },
            startUrl: { type: "string", example: `${baseUrl}/login` },
            baseURL: { type: "string", example: `${baseUrl}` },
            scriptKey: { type: "string", example: "auth/login-smoke" },
            language: { type: "string", example: "ko" },
            tags: { type: "array", items: { type: "string" } },
            locators: { type: "object", additionalProperties: { $ref: "#/components/schemas/Locator" } },
            expectations: { type: "array", items: { type: "object", additionalProperties: true } },
            variables: { type: "object", additionalProperties: true },
            storageStateRef: { type: "string", example: "auth/admin.json" },
            pageInspection: { type: "object", additionalProperties: true },
          },
        },
        AssistScaffoldRequest: {
          type: "object",
          properties: {
            goal: { type: "string", example: "상품 검색 결과를 검증하는 테스트" },
            testName: { type: "string", example: "search returns result list" },
            scriptKey: { type: "string", example: "search/basic-results" },
            startUrl: { type: "string", example: `${baseUrl}/demo/test-page` },
            baseURL: { type: "string", example: `${baseUrl}` },
            language: { type: "string", example: "ts" },
            steps: { type: "array", items: { type: "object", additionalProperties: true } },
            variables: { type: "object", additionalProperties: true },
            save: { type: "boolean", default: false },
            overwrite: { type: "boolean", default: false },
            validate: { type: "boolean", default: true },
            project: { type: "string", example: "chromium" },
            pageInspection: { type: "object", additionalProperties: true },
          },
        },
        ErrorEnvelope: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "LOCATOR_TIMEOUT" },
                message: { type: "string", example: "button locator timeout" },
                details: { type: "object", additionalProperties: true },
              },
            },
            artifacts: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    paths: {
      "/": {
        get: {
          tags: ["Docs"],
          summary: "Landing page",
          responses: { 200: { description: "HTML landing page" } },
        },
      },
      [documentationPaths.openApi]: {
        get: {
          tags: ["Docs"],
          summary: "OpenAPI JSON",
          responses: { 200: { description: "OpenAPI document" } },
        },
      },
      [documentationPaths.docs]: {
        get: {
          tags: ["Docs"],
          summary: "Swagger UI",
          responses: { 200: { description: "Swagger UI page" } },
        },
      },
      [documentationPaths.playground]: {
        get: {
          tags: ["Docs"],
          summary: "Interactive API playground",
          responses: { 200: { description: "Playground page" } },
        },
      },
      [documentationPaths.runs]: {
        get: {
          tags: ["Docs"],
          summary: "Run history and per-step timelines",
          responses: { 200: { description: "Run history page" } },
        },
      },
      "/demo/test-page": {
        get: {
          tags: ["Docs"],
          summary: "Local automation demo page",
          responses: { 200: { description: "Demo test page" } },
        },
      },
      "/health": {
        get: {
          tags: ["Docs"],
          summary: "Health check",
          responses: { 200: { description: "Service health summary" } },
        },
      },
      [`${api}/scripts`]: {
        get: {
          tags: ["Scripts"],
          summary: "List registered scripts",
          responses: { 200: { description: "Script list" } },
        },
      },
      [`${api}/scripts/sync`]: {
        post: {
          tags: ["Scripts"],
          summary: "Refresh script registry",
          responses: { 200: { description: "Updated registry" } },
        },
      },
      [`${api}/scripts/{scriptKey}`]: {
        get: {
          tags: ["Scripts"],
          summary: "Get script details",
          parameters: [{ name: "scriptKey", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Script metadata" }, 404: { description: "Not found" } },
        },
        put: {
          tags: ["Scripts"],
          summary: "Upload or replace a script file",
          description: "Write script content to the scripts directory. The file is saved with the given key and auto-detected extension. Use this API to register scripts in offline environments where git sync is not available.",
          parameters: [{ name: "scriptKey", in: "path", required: true, schema: { type: "string", example: "checkout/guest-order" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string", description: "Full script source code" }, fileName: { type: "string", description: "Optional file name with extension (e.g. guest-order.spec.ts). Defaults to .spec.js", example: "guest-order.spec.ts" } } } } } },
          responses: { 200: { description: "Script saved and registry refreshed" }, 400: { description: "Invalid request" } },
        },
        delete: {
          tags: ["Scripts"],
          summary: "Delete a script file",
          parameters: [{ name: "scriptKey", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Script deleted" }, 404: { description: "Not found" } },
        },
      },
      [`${api}/scripts/validate`]: {
        post: {
          tags: ["Scripts"],
          summary: "Validate a script request",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/CreateRunRequest" },
                    {
                      type: "object",
                      properties: {
                        inlineScript: { type: "string" },
                        filename: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
          responses: { 200: { description: "Validation result" } },
        },
      },
      [`${api}/assist/capabilities`]: {
        get: {
          tags: ["Scripts"],
          summary: "Get LLM-friendly authoring capabilities",
          responses: { 200: { description: "Supported scaffold workflow, actions, locators, and projects" } },
        },
      },
      [`${api}/assist/examples`]: {
        get: {
          tags: ["Scripts"],
          summary: "Get localized authoring examples for LLM-driven Playwright generation",
          parameters: [
            { name: "language", in: "query", required: false, schema: { type: "string", example: "ko" } },
          ],
          responses: { 200: { description: "Localized natural-language requests, step patterns, and locator guidance" } },
        },
      },
      [`${api}/assist/plan`]: {
        post: {
          tags: ["Scripts"],
          summary: "Turn a user request into a structured test plan",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AssistPlanRequest" },
              },
            },
          },
          responses: { 200: { description: "Structured scenario plan with suggested MCP workflow and Playwright steps" } },
        },
      },
      [`${api}/assist/scaffold`]: {
        post: {
          tags: ["Scripts"],
          summary: "Generate a Playwright script scaffold and optionally save it",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AssistScaffoldRequest" },
              },
            },
          },
          responses: { 200: { description: "Generated script content, optional saved script metadata, and validation result" } },
        },
      },
      [`${api}/runs`]: {
        get: {
          parameters: [
            { name: "status", in: "query", required: false, schema: { type: "string" }, description: "Comma separated: queued, running, completed, failed, cancelled, interrupted" },
            { name: "scriptKey", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 100 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } },
          ],
          tags: ["Runs"],
          summary: "List runs",
          responses: { 200: { description: "Run list" } },
        },
        post: {
          tags: ["Runs"],
          summary: "Create a run",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateRunRequest" },
              },
            },
          },
          responses: { 201: { description: "Created run" } },
        },
      },
      [`${api}/runs/{runId}`]: {
        delete: operation({
          tag: "Runs",
          summary: "Delete a finished run and its artifacts",
          parameters: [pathParam("runId")],
          responses: { 200: { description: "Deleted" }, 409: { description: "Run is still executing" } },
        }),
        get: {
          tags: ["Runs"],
          summary: "Get run status",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Run details" } },
        },
      },
      [`${api}/runs/{runId}/cancel`]: {
        post: {
          tags: ["Runs"],
          summary: "Cancel a run",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Cancellation result" } },
        },
      },
      [`${api}/runs/{runId}/artifacts`]: {
        get: {
          tags: ["Runs"],
          summary: "List run artifacts",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Artifacts created by the run" } },
        },
      },
      [`${api}/runs/{runId}/report`]: {
        get: {
          tags: ["Runs"],
          summary: "Get run report",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Summary report" } },
        },
      },
      [`${api}/runs/{runId}/logs`]: {
        get: {
          tags: ["Runs"],
          summary: "Get run logs",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Structured logs" } },
        },
      },
      [`${api}/sessions`]: {
        get: operation({ tag: "Sessions", summary: "List active browser sessions" }),
        post: {
          tags: ["Sessions"],
          summary: "Create a browser session",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateSessionRequest" },
              },
            },
          },
          responses: { 201: { description: "Created session" } },
        },
      },
      [`${api}/sessions/{sessionId}`]: {
        get: {
          tags: ["Sessions"],
          summary: "Get session state",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Session details" } },
        },
        delete: {
          tags: ["Sessions"],
          summary: "Close session",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Session closure result" } },
        },
      },
      [`${api}/sessions/{sessionId}/contexts`]: {
        post: {
          tags: ["Sessions"],
          summary: "Create a browser context",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateContextRequest" },
              },
            },
          },
          responses: { 201: { description: "Created context" } },
        },
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/pages`]: {
        post: {
          tags: ["Sessions"],
          summary: "Create a page in a context",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "contextId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 201: { description: "Created page" } },
        },
      },
      [`${api}/sessions/{sessionId}/execute`]: {
        post: {
          tags: ["Sessions"],
          summary: "Execute a workflow: actions with if, repeat, forEach, while and approval gates",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExecuteBatchRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "status completed, rejected, or awaiting_approval when the workflow stopped at a gate",
            },
          },
        },
      },
      [`${api}/sessions/{sessionId}/execute/resume`]: {
        post: {
          tags: ["Sessions"],
          summary: "Resume a workflow that stopped at an approval gate",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["gateId"],
                  properties: { gateId: { type: "string", example: "gate_1234567890abcdef" } },
                },
              },
            },
          },
          responses: { 200: { description: "Execution result after the gate" } },
        },
      },
      [`${api}/sessions/{sessionId}/approvals`]: {
        get: {
          tags: ["Sessions"],
          summary: "List workflows waiting for an approval decision",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Pending approvals" } },
        },
      },
      [`${api}/sessions/{sessionId}/approvals/{gateId}`]: {
        get: {
          tags: ["Sessions"],
          summary: "Read one approval gate",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "gateId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Approval gate" } },
        },
      },
      [`${api}/sessions/{sessionId}/approvals/{gateId}/decide`]: {
        post: {
          tags: ["Sessions"],
          summary: "Approve or reject a waiting workflow",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "gateId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["decision", "decidedBy"],
                  properties: {
                    decision: { type: "string", enum: ["approve", "reject"], example: "approve" },
                    decidedBy: {
                      type: "string",
                      example: "kim@example.com",
                      description: "Audit field. The API token identifies the client, not the person.",
                    },
                    comment: { type: "string", example: "금액 확인했습니다" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Recorded decision" } },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/goto`]: {
        post: {
          tags: ["Sessions"],
          summary: "Navigate a page",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: { type: "string", example: `${baseUrl}/demo/test-page` },
                    waitUntil: { type: "string", example: "domcontentloaded" },
                    timeoutMs: { type: "integer", example: 10000 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Navigation result" } },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/inspect`]: {
        post: {
          tags: ["Sessions"],
          summary: "Inspect a live page and extract locator candidates for LLM-assisted script authoring",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    maxElements: { type: "integer", example: 40, description: "1-200" },
                    maxTextLength: { type: "integer", example: 140, description: "20-400" },
                    verifyLocators: {
                      type: "boolean",
                      default: true,
                      description: "Resolve every candidate against the live DOM to get its real match count",
                    },
                    maxVerifiedCandidates: { type: "integer", default: 3, description: "1-6" },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Page structure, visible text, and locator candidates verified against the live DOM. Each element carries locatorStatus (unique / ambiguous / not-found), locatorUnique, enabled, and a bestLocator that is known to resolve to one node; each candidate carries matchCount, verifiedConfidence, and a refinedLocator when ambiguity could be narrowed. locatorVerification summarises the page.",
            },
          },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/click`]: {
        post: {
          tags: ["Sessions"],
          summary: "Low-level click action",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["locator"],
                  properties: {
                    locator: { $ref: "#/components/schemas/Locator" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Updated page state" } },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/fill`]: {
        post: {
          tags: ["Sessions"],
          summary: "Low-level fill action",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["locator", "value"],
                  properties: {
                    locator: { $ref: "#/components/schemas/Locator" },
                    value: { type: "string", example: "hello from playground" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Updated page state" } },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/assert/text`]: {
        post: {
          tags: ["Sessions"],
          summary: "Assert locator text",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["locator", "value"],
                  properties: {
                    locator: { $ref: "#/components/schemas/Locator" },
                    value: { type: "string", example: "Primary clicked" },
                    match: { type: "string", example: "contains" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Assertion result" } },
        },
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/screenshot`]: {
        post: {
          tags: ["Sessions"],
          summary: "Capture a screenshot",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "pageId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Created screenshot artifact" } },
        },
      },
      [`${api}/sessions/{sessionId}/artifacts`]: {
        get: {
          tags: ["Sessions"],
          summary: "List all artifacts in a session",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Array of artifact metadata with downloadPath" } },
        },
      },
      [`${api}/sessions/{sessionId}/artifacts/{artifactId}`]: {
        get: {
          tags: ["Sessions"],
          summary: "Download an artifact file (screenshot, video, trace, etc.)",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "artifactId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Binary file download" }, 404: { description: "Artifact not found" } },
        },
      },
      [`${api}/environments`]: {
        get: operation({ tag: "Runs", summary: "List environments" }),
      },
      [`${api}/environments/{name}`]: {
        get: operation({ tag: "Runs", summary: "Get one environment", parameters: [pathParam("name")] }),
        put: operation({
          tag: "Runs",
          summary: "Create or replace an environment",
          parameters: [pathParam("name")],
          body: {
            type: "object",
            properties: {
              baseURL: { type: "string", example: "https://stg.example.com" },
              project: { type: "string", enum: ["chromium", "firefox", "webkit"] },
              storageStateRef: { type: "string", example: "auth/customer.json" },
              urlAllowlist: { type: "array", items: { type: "string" } },
              variables: {
                type: "object",
                additionalProperties: true,
                description: "Use \"{{secret.NAME}}\" for credentials; a reference is never stored in a run record",
              },
            },
          },
        }),
        delete: operation({ tag: "Runs", summary: "Delete an environment", parameters: [pathParam("name")] }),
      },
      [`${api}/datasets`]: {
        get: operation({ tag: "Runs", summary: "List datasets with row counts and columns" }),
      },
      [`${api}/schedules`]: {
        get: operation({ tag: "Runs", summary: "List schedules" }),
      },
      [`${api}/schedules/{name}`]: {
        get: operation({ tag: "Runs", summary: "Get one schedule", parameters: [pathParam("name")] }),
        put: operation({
          tag: "Runs",
          summary: "Create or replace a schedule; cron, script, environment and dataset are validated now",
          parameters: [pathParam("name")],
          body: {
            type: "object",
            required: ["cron", "request"],
            properties: {
              cron: { type: "string", example: "0 2 * * *", description: "minute hour dayOfMonth month dayOfWeek, in the server's local timezone" },
              enabled: { type: "boolean", default: true },
              request: { $ref: "#/components/schemas/CreateRunRequest" },
              notify: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string" },
                  on: { type: "string", enum: ["failure", "always"], default: "failure" },
                  headers: { type: "object", additionalProperties: { type: "string" } },
                },
              },
            },
          },
          responses: { 200: { description: "Stored schedule" }, 400: { description: "Invalid cron, or an unknown script, environment or dataset" } },
        }),
        delete: operation({ tag: "Runs", summary: "Delete a schedule", parameters: [pathParam("name")] }),
      },
      [`${api}/schedules/{name}/trigger`]: {
        post: operation({
          tag: "Runs",
          summary: "Run a schedule now — what a deploy pipeline calls to gate a release",
          parameters: [pathParam("name")],
          body: {
            type: "object",
            properties: {
              variables: { type: "object", additionalProperties: true, description: "Merged over the stored request, e.g. the build id" },
              notify: { type: "object", additionalProperties: true },
            },
          },
          responses: { 201: { description: "Queued run, or a list when the schedule uses a dataset" } },
        }),
      },
      [`${api}/datasets/{name}`]: {
        get: operation({ tag: "Runs", summary: "Get one dataset including its rows", parameters: [pathParam("name")] }),
        put: operation({
          tag: "Runs",
          summary: "Create or replace a dataset",
          parameters: [pathParam("name")],
          body: {
            type: "object",
            required: ["rows"],
            properties: {
              rows: {
                type: "array",
                minItems: 1,
                items: { type: "object", additionalProperties: true },
                example: [{ sku: "ABC-1", qty: "1" }, { sku: "ABC-2", qty: "5" }],
              },
            },
          },
          responses: { 200: { description: "Stored dataset" }, 400: { description: "rows must be a non-empty array of objects" } },
        }),
        delete: operation({ tag: "Runs", summary: "Delete a dataset", parameters: [pathParam("name")] }),
      },
      [`${api}/queue`]: {
        get: operation({
          tag: "Runs",
          summary: "Show the run queue and how many slots are busy",
        }),
      },
      [`${api}/runs/{runId}/retry`]: {
        post: operation({
          tag: "Runs",
          summary: "Queue a new run with the same request as a finished one",
          parameters: [pathParam("runId")],
          responses: { 201: { description: "New queued run" }, 409: { description: "The original run has not finished" } },
        }),
      },
      [`${api}/runs/{runId}/artifacts/{artifactPath}`]: {
        get: operation({
          tag: "Runs",
          summary: "Download one file produced by a run",
          parameters: [pathParam("runId"), { name: "artifactPath", in: "path", required: true, schema: { type: "string" }, description: "relativePath from the artifacts listing" }],
          responses: { 200: { description: "Binary file" }, 404: { description: "Artifact not found" } },
        }),
      },
      [`${api}/sessions/{sessionId}/close`]: {
        post: operation({ tag: "Sessions", summary: "Close a session (alias of DELETE)", parameters: sessionParams }),
      },
      [`${api}/sessions/{sessionId}/keepalive`]: {
        post: operation({
          tag: "Sessions",
          summary: "Extend the session TTL",
          parameters: sessionParams,
          body: { type: "object", properties: { ttlMs: { type: "integer", example: 1800000 } } },
        }),
      },
      [`${api}/sessions/{sessionId}/actions`]: {
        get: operation({ tag: "Sessions", summary: "List the raw action and browser event logs", parameters: sessionParams }),
      },
      [`${api}/sessions/{sessionId}/downloads`]: {
        get: operation({
          tag: "Sessions",
          summary: "List files the session downloaded, captured as artifacts",
          parameters: sessionParams,
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/request`]: {
        post: operation({
          tag: "Sessions",
          summary: "Issue an HTTP request through the context, carrying its cookies — use it to confirm the outcome a UI action claims",
          parameters: contextParams,
          body: {
            type: "object",
            required: ["url"],
            properties: {
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" },
              url: { type: "string", description: "Absolute, or relative to the context baseURL" },
              headers: { type: "object", additionalProperties: { type: "string" } },
              params: { type: "object", additionalProperties: true },
              data: { description: "Request body; an object is sent as JSON" },
              form: { type: "object", additionalProperties: true },
              timeoutMs: { type: "integer" },
            },
          },
          responses: {
            200: { description: "status, headers, body text, parsed json when applicable, and the full body stored as an artifact" },
            403: { description: "The URL is not in URL_ALLOWLIST" },
            408: { description: "The request timed out" },
          },
        }),
      },
      [`${api}/sessions/{sessionId}/timeline`]: {
        get: operation({
          tag: "Sessions",
          summary: "Per-step timeline: each action with its duration, the console and network events it caused, and its failure artifacts",
          parameters: [
            ...sessionParams,
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 200 }, description: "Most recent N actions, 1-2000" },
            { name: "includeEvents", in: "query", required: false, schema: { type: "boolean", default: true }, description: "false returns only durations and issue counts" },
          ],
          responses: {
            200: {
              description: "Entries in order, each with durationMs, issues (console errors, failed responses, page errors) and linked artifacts, plus a slowest-steps summary",
            },
          },
        }),
      },
      [`${api}/sessions/{sessionId}/trace/start`]: {
        post: operation({
          tag: "Sessions",
          summary: "Start Playwright tracing for a context",
          parameters: sessionParams,
          body: { type: "object", required: ["contextId"], properties: { contextId: { type: "string" }, title: { type: "string" }, screenshots: { type: "boolean" }, snapshots: { type: "boolean" }, sources: { type: "boolean" } } },
          responses: { 200: { description: "Tracing started" }, 409: { description: "Tracing already active" } },
        }),
      },
      [`${api}/sessions/{sessionId}/trace/stop`]: {
        post: operation({
          tag: "Sessions",
          summary: "Stop tracing and store the trace zip as an artifact",
          parameters: sessionParams,
          body: { type: "object", required: ["contextId"], properties: { contextId: { type: "string" } } },
          responses: { 200: { description: "Trace artifact" }, 409: { description: "Tracing was never started" } },
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}`]: {
        get: operation({ tag: "Sessions", summary: "Get one context", parameters: contextParams }),
        delete: operation({ tag: "Sessions", summary: "Close one context and collect its videos", parameters: contextParams }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/storage-state/export`]: {
        post: operation({ tag: "Sessions", summary: "Export cookies and origins as a storage state artifact", parameters: contextParams }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/storage-state/import`]: {
        post: operation({
          tag: "Sessions",
          summary: "Recreate the context with an imported storage state",
          parameters: contextParams,
          body: { type: "object", properties: { storageState: freeFormBody, storageStateRef: { type: "string", example: "auth/admin.json", description: "Path relative to STORAGE_STATE_DIR" } } },
          responses: { 200: { description: "Context recreated; existing pages are closed" }, 400: { description: "Invalid storage state or path outside STORAGE_STATE_DIR" } },
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/route`]: {
        post: operation({
          tag: "Sessions",
          summary: "Register a network route handler",
          parameters: contextParams,
          body: { type: "object", required: ["url"], properties: { url: { type: "string", example: "**/api/**" }, times: { type: "integer" }, behavior: { type: "object", properties: { action: { type: "string", enum: ["continue", "abort", "fulfill"] }, status: { type: "integer" }, body: { type: "string" }, json: freeFormBody, contentType: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } }, errorCode: { type: "string" } } } } },
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/route/{routeId}`]: {
        delete: operation({ tag: "Sessions", summary: "Remove a route handler", parameters: [...contextParams, pathParam("routeId")] }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/cookies`]: {
        get: operation({
          tag: "Sessions",
          summary: "List cookies",
          parameters: [...contextParams, { name: "urls", in: "query", required: false, schema: { type: "string" }, description: "Comma separated URL filter" }],
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/cookies/set`]: {
        post: operation({
          tag: "Sessions",
          summary: "Add cookies to the context",
          parameters: contextParams,
          body: { type: "object", properties: { cookies: { type: "array", items: freeFormBody }, urls: { type: "array", items: { type: "string" } } } },
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/permissions`]: {
        post: operation({
          tag: "Sessions",
          summary: "Grant browser permissions",
          parameters: contextParams,
          body: { type: "object", properties: { permissions: { type: "array", items: { type: "string" }, example: ["geolocation"] }, origin: { type: "string" } } },
        }),
      },
      [`${api}/sessions/{sessionId}/contexts/{contextId}/headers`]: {
        post: operation({
          tag: "Sessions",
          summary: "Replace the context default extra HTTP headers",
          parameters: contextParams,
          body: { type: "object", properties: { headers: { type: "object", additionalProperties: { type: "string" } } } },
        }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}`]: {
        get: operation({ tag: "Sessions", summary: "Get one page", parameters: pageParams }),
        delete: operation({ tag: "Sessions", summary: "Close one page and collect its video", parameters: pageParams }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/reload`]: {
        post: operation({ tag: "Sessions", summary: "Reload the page", parameters: pageParams, body: { type: "object", properties: { waitUntil: { type: "string" }, timeoutMs: { type: "integer" } } } }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/go-back`]: {
        post: operation({ tag: "Sessions", summary: "Go back in history", parameters: pageParams }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/go-forward`]: {
        post: operation({ tag: "Sessions", summary: "Go forward in history", parameters: pageParams }),
      },
      ...pageActionPath("press", "Press a key on a locator", { key: { type: "string", example: "Enter" }, delay: { type: "integer" } }),
      ...pageActionPath("hover", "Hover a locator", { force: { type: "boolean" } }),
      ...pageActionPath("select-option", "Select option(s) in a <select>", { values: { type: "array", items: { type: "string" } }, value: { type: "string" } }),
      ...pageActionPath("assert/visible", "Assert a locator becomes visible"),
      ...pageActionPath("assert/count", "Assert how many elements a locator matches", { expected: { type: "integer", example: 3 }, operator: { type: "string", enum: ["eq", "gt", "gte", "lt", "lte"] } }),
      ...pageActionPath("dialog-policy", "Choose how this page answers alert/confirm/prompt dialogs", { action: { type: "string", enum: ["accept", "dismiss", "ignore"] }, promptText: { type: "string" } }),
      ...pageActionPath("wait-for", "Wait for a load state, URL, locator, text, or a fixed delay", { loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }, url: { type: "string" }, text: { type: "string" }, textGone: { type: "string" }, state: { type: "string" }, sleepMs: { type: "integer" } }),
      [`${api}/sessions/{sessionId}/pages/{pageId}/drag`]: {
        post: operation({
          tag: "Sessions",
          summary: "Drag one locator onto another",
          parameters: pageParams,
          body: { type: "object", required: ["source", "target"], properties: { source: { $ref: "#/components/schemas/Locator" }, target: { $ref: "#/components/schemas/Locator" }, timeoutMs: { type: "integer" } } },
        }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/evaluate`]: {
        post: operation({
          tag: "Sessions",
          summary: "Evaluate JavaScript in the page (disable with ENABLE_EVALUATE=false)",
          parameters: pageParams,
          body: { type: "object", required: ["expression"], properties: { expression: { type: "string", example: "() => document.title" }, arg: {} } },
          responses: { 200: { description: "Evaluation result" }, 403: { description: "Evaluate is disabled by configuration" } },
        }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/locator/query`]: {
        post: operation({
          tag: "Sessions",
          summary: "Read count or text from a locator without asserting",
          parameters: pageParams,
          body: { type: "object", properties: { locator: { $ref: "#/components/schemas/Locator" }, operation: { type: "string", enum: ["count", "allTextContents", "textContent", "innerText", "isVisible"] } } },
        }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/assert/url`]: {
        post: operation({
          tag: "Sessions",
          summary: "Assert the page URL",
          parameters: pageParams,
          body: { type: "object", properties: { expected: { type: "string", example: "/dashboard", description: "Use \"/pattern/flags\" for a regular expression" }, match: { type: "string", enum: ["equals", "contains", "startsWith", "endsWith"] }, timeoutMs: { type: "integer" } } },
        }),
      },
      [`${api}/sessions/{sessionId}/pages/{pageId}/pdf`]: {
        post: operation({
          tag: "Sessions",
          summary: "Render the page to PDF (chromium only)",
          parameters: pageParams,
          body: { type: "object", properties: { format: { type: "string", example: "A4" }, landscape: { type: "boolean" }, printBackground: { type: "boolean" }, scale: { type: "number" } } },
          responses: { 200: { description: "PDF artifact" }, 400: { description: "Not a chromium session" } },
        }),
      },
      [config.mcpBasePath]: {
        get: {
          tags: ["MCP"],
          summary: "MCP GET probe",
          responses: { 405: { description: "SSE stream is not enabled on this endpoint" } },
        },
        post: {
          tags: ["MCP"],
          summary: "Send Streamable MCP JSON-RPC request",
          responses: { 200: { description: "JSON-RPC response" }, 202: { description: "Accepted without response payload" } },
        },
        delete: {
          tags: ["MCP"],
          summary: "Delete MCP session",
          parameters: [{ name: "Mcp-Session-Id", in: "header", required: true, schema: { type: "string" } }],
          responses: { 204: { description: "MCP session closed" } },
        },
      },
    },
  };
}






const scriptRegistry = new ScriptRegistry(config);
await scriptRegistry.refresh();
const runManager = new RunManager({
  ...config,
  registry: scriptRegistry,
});
await loadUiAssets();
await runManager.restore();
runManager.startScheduler();
const sessionManager = new SessionManager(config);
const scriptAssistant = new ScriptAssistant({
  ...config,
  registry: scriptRegistry,
  runManager,
});

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  req.requestId = createId("req");
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

app.use(express.json({ limit: config.bodyLimit }));

// body-parser rejects malformed JSON and oversized bodies with its own error
// shape; without this they surfaced as 500 INTERNAL_ERROR.
app.use((error, req, res, next) => {
  if (error && (error.type === "entity.parse.failed" || error instanceof SyntaxError)) {
    return next(new ApiError(400, "INVALID_JSON", `Request body is not valid JSON: ${error.message}`));
  }

  if (error && error.type === "entity.too.large") {
    return next(new ApiError(413, "BODY_TOO_LARGE", `Request body exceeds the ${config.bodyLimit} limit`));
  }

  return next(error);
});

app.use(documentationPaths.swaggerAssets, express.static(swaggerUiAssetDir));
app.use(uiAssetsPath, express.static(path.join(uiDir, "assets"), { maxAge: "1h" }));

const mcpSessions = new Map();

// Same-origin requests from the built-in playground and loopback callers are
// always safe; ALLOWED_ORIGINS only needs to list extra cross-origin clients.
function isAllowedOrigin(req, origin) {
  if (config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin)) {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.host === (req.headers["x-forwarded-host"] || req.get("host"))) {
    return true;
  }

  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }

  if (!isAllowedOrigin(req, origin)) {
    if (req.path.startsWith(config.mcpBasePath)) {
      return next(new ApiError(403, "MCP_ORIGIN_DENIED", `Origin not allowed: ${origin}`));
    }
    return next();
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  // Streamable MCP clients read the session id off the initialize response, so
  // it has to be exposed explicitly to cross-origin readers.
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Request-Id");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
});

// Optional shared-secret gate. The API can launch browsers and read files from
// the configured directories, so any non-loopback deployment should set it.
const publicPaths = new Set([
  "/health",
  "/",
  documentationPaths.docs,
  documentationPaths.openApi,
  documentationPaths.playground,
  documentationPaths.runs,
  "/demo/test-page",
]);
app.use((req, res, next) => {
  if (!config.apiToken || publicPaths.has(req.path) || req.path.startsWith(documentationPaths.swaggerAssets)) {
    return next();
  }

  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = bearer || req.headers["x-api-token"] || "";
  if (token !== config.apiToken) {
    return next(new ApiError(401, "UNAUTHORIZED", "A valid API token is required"));
  }

  return next();
});

app.get("/", asyncRoute(async (req, res) => {
  res.type("html").send(renderHomePage(req));
}));

app.get(documentationPaths.openApi, asyncRoute(async (req, res) => {
  res.json(buildOpenApiSpec(req));
}));

app.get(documentationPaths.docs, asyncRoute(async (req, res) => {
  res.type("html").send(renderSwaggerPage(req));
}));

app.get(documentationPaths.playground, asyncRoute(async (req, res) => {
  res.type("html").send(renderPlaygroundPage(req));
}));

app.get(documentationPaths.runs, asyncRoute(async (req, res) => {
  res.type("html").send(renderRunsPage(req));
}));

app.get("/demo/test-page", asyncRoute(async (req, res) => {
  res.type("html").send(renderDemoTestPage(req));
}));

app.get("/health", asyncRoute(async (req, res) => {
  ok(res, {
    service: config.serviceName,
    version: config.serviceVersion,
    uptimeSec: Math.round(process.uptime()),
    docker: isDocker,
    scriptCount: scriptRegistry.list().length,
    runCount: runManager.runs.size,
    activeRunCount: runManager.countActiveRuns(),
    queuedRunCount: runManager.countQueuedRuns(),
    scheduleCount: (await runManager.schedules.list().catch(() => [])).length,
    sessionCount: sessionManager.sessions.size,
    mcpSessionCount: mcpSessions.size,
    limits: {
      maxSessions: config.maxSessions,
      maxContextsPerSession: config.maxContextsPerSession,
      maxPagesPerSession: config.maxPagesPerSession,
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxQueuedRuns: config.maxQueuedRuns,
      maxRetainedRuns: config.maxRetainedRuns,
      runTimeoutMs: config.runTimeoutMs,
      maxWorkflowIterations: config.maxWorkflowIterations,
      maxWorkflowSteps: config.maxWorkflowSteps,
      maxWorkflowDurationMs: config.maxWorkflowDurationMs,
      maxPendingApprovals: config.maxPendingApprovals,
    },
    features: {
      evaluate: config.enableEvaluate,
      authRequired: Boolean(config.apiToken),
      failureArtifacts: config.captureFailureArtifacts,
      persistentRunHistory: true,
      scheduler: config.scheduleTickMs > 0,
      workflowControlFlow: ["if", "repeat", "forEach", "while", "break", "continue", "approval"],
      // Gates live in memory with the session they suspended, so a restart
      // cancels them rather than silently resuming later.
      approvalGatesPersistAcrossRestart: false,
      urlAllowlist: config.urlAllowlist,
      urlAllowlistCoverage: config.urlAllowlist.length
        ? ["sessions", "runs"]
        : [],
      runTimeoutMs: config.runTimeoutMs,
    },
  });
}));

app.get(`${config.apiBasePath}/scripts`, asyncRoute(async (req, res) => {
  ok(res, {
    scripts: scriptRegistry.list(),
  });
}));

app.post(`${config.apiBasePath}/scripts/sync`, asyncRoute(async (req, res) => {
  ok(res, await scriptRegistry.sync());
}));

async function uploadScript({ scriptKey, content, fileName }) {
  if (!content || typeof content !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "content (string) is required");
  }

  const target = resolveScriptUploadPath(config.scriptsDir, scriptKey, fileName);
  try {
    await ensureDir(path.dirname(target.absolutePath));
    await fsPromises.writeFile(target.absolutePath, content, "utf8");
  } catch (error) {
    // A read-only or foreign-owned SCRIPTS_DIR is the usual cause, and a bare
    // EACCES as a 500 tells the caller nothing about how to fix it.
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
      throw new ApiError(
        403,
        "SCRIPTS_DIR_NOT_WRITABLE",
        `Cannot write to ${config.scriptsDir} (${error.code}). The process runs as uid `
        + `${process.getuid?.() ?? "?"}; make the scripts directory writable by that uid or mount it read-write.`,
      );
    }
    throw error;
  }
  await scriptRegistry.refresh();
  console.log(`[scripts] uploaded scriptKey=${target.scriptKey} path=${target.absolutePath} size=${content.length}`);
  return scriptRegistry.get(target.scriptKey);
}

app.put(`${config.apiBasePath}/scripts/:scriptKey(*)`, asyncRoute(async (req, res) => {
  ok(res, await uploadScript({
    scriptKey: req.params.scriptKey,
    content: req.body?.content,
    fileName: req.body?.fileName,
  }));
}));

app.delete(`${config.apiBasePath}/scripts/:scriptKey(*)`, asyncRoute(async (req, res) => {
  const scriptKey = req.params.scriptKey;
  const script = scriptRegistry.get(scriptKey);
  try {
    await fsPromises.unlink(script.absolutePath);
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
      throw new ApiError(
        403,
        "SCRIPTS_DIR_NOT_WRITABLE",
        `Cannot delete from ${config.scriptsDir} (${error.code}). The process runs as uid `
        + `${process.getuid?.() ?? "?"}; make the scripts directory writable by that uid.`,
      );
    }
    throw error;
  }
  await scriptRegistry.refresh();
  ok(res, { deleted: scriptKey });
}));

app.post(`${config.apiBasePath}/scripts/validate`, asyncRoute(async (req, res) => {
  ok(res, await runManager.validateScript(req.body || {}));
}));

app.get(`${config.apiBasePath}/assist/capabilities`, asyncRoute(async (req, res) => {
  ok(res, scriptAssistant.getCapabilities());
}));

app.get(`${config.apiBasePath}/assist/examples`, asyncRoute(async (req, res) => {
  ok(res, scriptAssistant.examples({
    language: req.query.language || resolveRequestLanguage(req),
  }));
}));

app.post(`${config.apiBasePath}/assist/plan`, asyncRoute(async (req, res) => {
  ok(res, scriptAssistant.plan(req.body || {}));
}));

app.post(`${config.apiBasePath}/assist/scaffold`, asyncRoute(async (req, res) => {
  ok(res, await scriptAssistant.scaffold(req.body || {}));
}));

app.get(`${config.apiBasePath}/scripts/:scriptKey(*)`, asyncRoute(async (req, res) => {
  ok(res, scriptRegistry.get(req.params.scriptKey));
}));

app.get(`${config.apiBasePath}/runs`, asyncRoute(async (req, res) => {
  ok(res, runManager.listRuns({
    status: req.query.status,
    scriptKey: req.query.scriptKey,
    limit: req.query.limit,
    offset: req.query.offset,
  }));
}));

app.get(`${config.apiBasePath}/queue`, asyncRoute(async (req, res) => {
  ok(res, runManager.describeQueue());
}));

// A dataset turns one request into one run per row, so this answers with a list
// when one is used and with a single run otherwise.
app.post(`${config.apiBasePath}/runs`, asyncRoute(async (req, res) => {
  const { request, environment } = await runManager.composeRequest(req.body || {});
  const expanded = await runManager.expandDataset(request);

  if (!request.dataset) {
    ok(res, await runManager.createRun(expanded[0], { environment }), 201);
    return;
  }

  const runs = [];
  for (const entry of expanded) {
    runs.push(await runManager.createRun(entry, { environment }));
  }

  ok(res, { dataset: request.dataset, rowCount: runs.length, runs }, 201);
}));

app.get(`${config.apiBasePath}/environments`, asyncRoute(async (req, res) => {
  ok(res, { environments: await runManager.environments.list() });
}));

app.get(`${config.apiBasePath}/environments/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.environments.get(req.params.name));
}));

app.put(`${config.apiBasePath}/environments/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.environments.save(req.params.name, req.body || {}));
}));

app.delete(`${config.apiBasePath}/environments/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.environments.remove(req.params.name));
}));

app.get(`${config.apiBasePath}/schedules`, asyncRoute(async (req, res) => {
  ok(res, { schedules: await runManager.schedules.list() });
}));

app.get(`${config.apiBasePath}/schedules/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.schedules.get(req.params.name));
}));

app.put(`${config.apiBasePath}/schedules/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.saveSchedule(req.params.name, req.body || {}));
}));

app.delete(`${config.apiBasePath}/schedules/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.schedules.remove(req.params.name));
}));

// What a deploy pipeline calls: run this schedule's scenarios now, optionally
// passing the build it is gating.
app.post(`${config.apiBasePath}/schedules/:name/trigger`, asyncRoute(async (req, res) => {
  ok(res, await runManager.triggerSchedule(req.params.name, req.body || {}), 201);
}));

app.get(`${config.apiBasePath}/datasets`, asyncRoute(async (req, res) => {
  const datasets = await runManager.datasets.list();
  ok(res, {
    // Rows can be large; the listing reports the shape, not the contents.
    datasets: datasets.map((dataset) => ({
      name: dataset.name,
      rowCount: Array.isArray(dataset.rows) ? dataset.rows.length : 0,
      columns: Array.isArray(dataset.rows) && dataset.rows[0] ? Object.keys(dataset.rows[0]) : [],
      updatedAt: dataset.updatedAt,
    })),
  });
}));

app.get(`${config.apiBasePath}/datasets/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.datasets.get(req.params.name));
}));

app.put(`${config.apiBasePath}/datasets/:name`, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.rows) || !body.rows.length) {
    throw new ApiError(400, "INVALID_REQUEST", "rows must be a non-empty array of objects");
  }
  if (body.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new ApiError(400, "INVALID_REQUEST", "every dataset row must be an object of variable values");
  }
  ok(res, await runManager.datasets.save(req.params.name, body));
}));

app.delete(`${config.apiBasePath}/datasets/:name`, asyncRoute(async (req, res) => {
  ok(res, await runManager.datasets.remove(req.params.name));
}));

app.get(`${config.apiBasePath}/runs/:runId`, asyncRoute(async (req, res) => {
  ok(res, runManager.serializeRun(runManager.getRun(req.params.runId)));
}));

app.post(`${config.apiBasePath}/runs/:runId/cancel`, asyncRoute(async (req, res) => {
  ok(res, await runManager.cancelRun(req.params.runId));
}));

app.get(`${config.apiBasePath}/runs/:runId/artifacts`, asyncRoute(async (req, res) => {
  ok(res, {
    runId: req.params.runId,
    artifacts: await runManager.listArtifacts(req.params.runId),
  });
}));

app.get(`${config.apiBasePath}/runs/:runId/report`, asyncRoute(async (req, res) => {
  ok(res, await runManager.getReport(req.params.runId));
}));

app.get(`${config.apiBasePath}/runs/:runId/logs`, asyncRoute(async (req, res) => {
  ok(res, await runManager.getLogs(req.params.runId, {
    source: req.query.source,
    limit: req.query.limit,
  }));
}));

app.post(`${config.apiBasePath}/runs/:runId/retry`, asyncRoute(async (req, res) => {
  ok(res, await runManager.retryRun(req.params.runId), 201);
}));

app.get(`${config.apiBasePath}/runs/:runId/artifacts/:artifactPath(*)`, asyncRoute(async (req, res) => {
  const artifact = await runManager.resolveArtifactPath(req.params.runId, req.params.artifactPath);
  sendArtifact(req, res, artifact.absolutePath, artifact.fileName);
}));

app.delete(`${config.apiBasePath}/runs/:runId`, asyncRoute(async (req, res) => {
  ok(res, await runManager.deleteRun(req.params.runId));
}));

app.get(`${config.apiBasePath}/sessions`, asyncRoute(async (req, res) => {
  ok(res, {
    sessions: sessionManager.listSessions(),
  });
}));

app.post(`${config.apiBasePath}/sessions`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.createSession(req.body || {}), 201);
}));

app.get(`${config.apiBasePath}/sessions/:sessionId`, asyncRoute(async (req, res) => {
  ok(res, sessionManager.serializeSession(sessionManager.getSession(req.params.sessionId)));
}));

app.delete(`${config.apiBasePath}/sessions/:sessionId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.closeSession(req.params.sessionId, "closed"));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/close`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.closeSession(req.params.sessionId, "closed"));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/keepalive`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.keepAlive(req.params.sessionId, req.body?.ttlMs));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/actions`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.listActions(req.params.sessionId));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/downloads`, asyncRoute(async (req, res) => {
  ok(res, sessionManager.listDownloads(req.params.sessionId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/request`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.apiRequest(req.params.sessionId, req.params.contextId, req.body || {}));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/timeline`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.buildTimeline(req.params.sessionId, {
    limit: req.query.limit,
    includeEvents: req.query.includeEvents !== "false",
  }));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/artifacts`, asyncRoute(async (req, res) => {
  ok(res, {
    sessionId: req.params.sessionId,
    artifacts: await sessionManager.listArtifacts(req.params.sessionId),
  });
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/artifacts/:artifactId`, asyncRoute(async (req, res) => {
  const artifact = sessionManager.getArtifact(req.params.sessionId, req.params.artifactId);
  sendArtifact(req, res, artifact.absolutePath, artifact.fileName);
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/trace/start`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.startTrace(req.params.sessionId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/trace/stop`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.stopTrace(req.params.sessionId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/execute`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.execute(req.params.sessionId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/execute/resume`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.resumeExecution(req.params.sessionId, req.body || {}));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/approvals`, asyncRoute(async (req, res) => {
  ok(res, { approvals: sessionManager.listApprovals(req.params.sessionId) });
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/approvals/:gateId`, asyncRoute(async (req, res) => {
  ok(res, sessionManager.serializeApproval(sessionManager.getApproval(req.params.gateId, req.params.sessionId)));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/approvals/:gateId/decide`, asyncRoute(async (req, res) => {
  ok(res, sessionManager.decideApproval(req.params.sessionId, req.params.gateId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.createContext(req.params.sessionId, req.body || {}), 201);
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.getContext(req.params.sessionId, req.params.contextId));
}));

app.delete(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.closeContext(req.params.sessionId, req.params.contextId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/storage-state/export`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.exportStorageState(req.params.sessionId, req.params.contextId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/storage-state/import`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.importStorageState(req.params.sessionId, req.params.contextId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/route`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.addRoute(req.params.sessionId, req.params.contextId, req.body || {}), 201);
}));

app.delete(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/route/:routeId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.removeRoute(req.params.sessionId, req.params.contextId, req.params.routeId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/cookies/set`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.setCookies(req.params.sessionId, req.params.contextId, req.body || {}));
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/cookies`, asyncRoute(async (req, res) => {
  // A GET body is not reliably delivered, so `urls` is read from the query string.
  const urls = parseCsv(req.query.urls);
  ok(res, await sessionManager.getCookies(req.params.sessionId, req.params.contextId, {
    urls: urls.length ? urls : undefined,
  }));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/permissions`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.grantPermissions(req.params.sessionId, req.params.contextId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/headers`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.setHeaders(req.params.sessionId, req.params.contextId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/contexts/:contextId/pages`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.createPage(req.params.sessionId, req.params.contextId), 201);
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.getPage(req.params.sessionId, req.params.pageId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/inspect`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.inspectPage(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.delete(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.closePage(req.params.sessionId, req.params.pageId));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/goto`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.navigate(req.params.sessionId, req.params.pageId, "goto", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/reload`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.navigate(req.params.sessionId, req.params.pageId, "reload", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/go-back`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.navigate(req.params.sessionId, req.params.pageId, "goBack", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/go-forward`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.navigate(req.params.sessionId, req.params.pageId, "goForward", req.body || {}));
}));

for (const action of ["click", "fill", "press", "hover", "drag", "evaluate"]) {
  app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/${action}`, asyncRoute(async (req, res) => {
    ok(res, await sessionManager.pageAction(req.params.sessionId, req.params.pageId, action, req.body || {}));
  }));
}

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/select-option`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAction(req.params.sessionId, req.params.pageId, "selectOption", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/locator/query`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAction(req.params.sessionId, req.params.pageId, "locatorQuery", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/assert/visible`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAssert(req.params.sessionId, req.params.pageId, "visible", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/assert/text`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAssert(req.params.sessionId, req.params.pageId, "text", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/assert/url`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAssert(req.params.sessionId, req.params.pageId, "url", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/assert/count`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pageAssert(req.params.sessionId, req.params.pageId, "count", req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/dialog-policy`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.setDialogPolicy(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/wait-for`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.waitFor(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/screenshot`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.screenshot(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/pdf`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pdf(req.params.sessionId, req.params.pageId, req.body || {}));
}));

// REST (OpenAPI) and MCP described the same operations with different, and in
// MCP's case incomplete, schemas - page_action advertised only sessionId,
// pageId and action, so a model had no way to learn that it must send a
// locator. Both now build on these shared fragments.
const LOCATOR_SCHEMA = {
  type: "object",
  description: "Structured locator. Provide exactly one primary strategy; role+name and testId are the most stable.",
  properties: {
    role: { type: "string", description: "ARIA role, e.g. button, link, textbox" },
    name: { type: "string", description: "Accessible name, used together with role" },
    text: { type: "string" },
    label: { type: "string" },
    placeholder: { type: "string" },
    testId: { type: "string", description: "data-testid value" },
    altText: { type: "string" },
    title: { type: "string" },
    css: { type: "string" },
    xpath: { type: "string" },
    selector: { type: "string" },
    exact: { type: "boolean" },
    hasText: { type: "string", description: "Extra .filter({ hasText }) narrowing" },
    first: { type: "boolean" },
    last: { type: "boolean" },
    nth: { type: "integer", description: "Zero-based index; takes precedence over first/last" },
  },
};

const DIALOG_POLICY_SCHEMA = {
  type: "object",
  description: "What to do when the page opens an alert/confirm/prompt. Without a policy the action that opened it would block.",
  properties: {
    action: { type: "string", enum: ["accept", "dismiss", "ignore"] },
    promptText: { type: "string", description: "Text typed into a prompt() when action is accept" },
  },
  required: ["action"],
};

// A condition answers a question about the page or about a captured value. It
// never fails the workflow when the answer is no, which is what separates it
// from an assertion.
const CONDITION_SCHEMA = {
  type: "object",
  description:
    "A value test, a page test, or a combinator. Value test: {value, and one of equals, notEquals, contains, "
    + "notContains, startsWith, endsWith, matches (regex literal), in, notIn, gt, gte, lt, lte, empty, notEmpty}. "
    + "Page test: {locator, state} or {locator, count, operator} or {locator, text, match} or {url, match} or "
    + "{loadState}. Combinators: {all: [...]}, {any: [...]}, {not: {...}}.",
  properties: {
    value: { type: "string", description: "Usually a {{captured}} reference" },
    equals: { type: "string" },
    notEquals: { type: "string" },
    contains: { type: "string" },
    notContains: { type: "string" },
    startsWith: { type: "string" },
    endsWith: { type: "string" },
    matches: { type: "string", description: "Regular expression literal, e.g. /^ORD-\\d+$/i" },
    in: { type: "array", items: { type: "string" } },
    notIn: { type: "array", items: { type: "string" } },
    gt: { type: "number" },
    gte: { type: "number" },
    lt: { type: "number" },
    lte: { type: "number" },
    empty: { type: "boolean" },
    notEmpty: { type: "boolean" },
    locator: LOCATOR_SCHEMA,
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    count: { type: "integer" },
    operator: { type: "string", enum: ["eq", "gt", "gte", "lt", "lte"] },
    text: { type: "string" },
    match: { type: "string", enum: ["contains", "equals", "startsWith", "endsWith"] },
    url: { type: "string" },
    loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
    timeoutMs: { type: "integer", description: "How long to wait for a page condition before answering no. Default 2000." },
    all: { type: "array", items: { type: "object", additionalProperties: true } },
    any: { type: "array", items: { type: "object", additionalProperties: true } },
    not: { type: "object", additionalProperties: true },
  },
};

const NESTED_STEPS_SCHEMA = {
  type: "array",
  minItems: 1,
  items: { type: "object", additionalProperties: true },
  description: "Nested steps, each the same shape as the step that contains them.",
};

const STEP_SCHEMA = {
  type: "object",
  description: "One automation step. Field requirements follow the action.",
  properties: {
    action: {
      type: "string",
      enum: [
        "goto", "reload", "goBack", "goForward",
        "click", "fill", "press", "hover", "drag", "selectOption", "evaluate", "locatorQuery",
        "assertVisible", "assertText", "assertUrl", "assertCount",
        // Outcome checks: a green button is not a completed task.
        "apiRequest", "assertApiResponse", "assertValue", "assertDownload",
        "waitFor", "screenshot",
        // Control flow: real work branches, repeats, and sometimes waits for a person.
        "if", "repeat", "forEach", "while", "break", "continue", "approval",
      ],
    },
    url: { type: "string", description: "goto / assertUrl / waitFor" },
    locator: LOCATOR_SCHEMA,
    source: LOCATOR_SCHEMA,
    target: LOCATOR_SCHEMA,
    value: { type: "string", description: "fill value, or the expected value for assertions" },
    expected: { description: "Expected value for assertions; a number for assertCount" },
    key: { type: "string", description: "press, e.g. Enter" },
    values: { type: "array", items: { type: "string" }, description: "selectOption" },
    match: { type: "string", enum: ["contains", "equals", "startsWith", "endsWith"] },
    operator: { type: "string", enum: ["eq", "gt", "gte", "lt", "lte"], description: "assertCount" },
    expression: { type: "string", description: "evaluate" },
    loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
    text: { type: "string" },
    textGone: { type: "string" },
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    sleepMs: { type: "integer" },
    fullPage: { type: "boolean" },
    timeoutMs: { type: "integer" },
    // Outcome verification
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], description: "apiRequest / assertApiResponse" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    params: { type: "object", additionalProperties: true },
    data: { description: "Request body; an object is sent as JSON" },
    contextId: { type: "string", description: "Defaults to the page's own context" },
    status: { type: "integer", description: "assertApiResponse: expected HTTP status" },
    ok: { type: "boolean", description: "assertApiResponse: require a 2xx" },
    jsonPath: { type: "string", example: "data.order.referenceNumber", description: "Dotted path into the JSON body" },
    bodyContains: { type: "string" },
    fileName: { type: "string", description: "assertDownload: name to wait for" },
    minBytes: { type: "integer", description: "assertDownload: reject an empty or truncated file" },
    contains: { type: "string", description: "assertDownload: text the file must contain" },
    // Capture and reuse
    saveAs: { type: "string", description: "Store this step's value under a name; later steps can use {{name}}" },
    savePath: { type: "string", description: "Dotted path to pluck from the result before saving" },
    // Control flow
    when: CONDITION_SCHEMA,
    then: NESTED_STEPS_SCHEMA,
    else: NESTED_STEPS_SCHEMA,
    steps: NESTED_STEPS_SCHEMA,
    times: { type: "integer", description: "repeat: how many iterations. May be a {{captured}} reference." },
    items: { description: "forEach: an array, or a {{captured}} reference to one" },
    as: { type: "string", description: "repeat / forEach: name the iteration value is bound to, usable as {{name}} or {{name.field}}" },
    indexAs: { type: "string", description: "repeat / forEach: name the zero-based index is bound to" },
    maxIterations: { type: "integer", description: "Per-loop iteration cap; cannot exceed the server limit" },
    name: { type: "string", description: "approval: the gate name, also where the decision is captured" },
    message: { type: "string", description: "approval: what the person is being asked to confirm" },
    approvers: { type: "array", items: { type: "string" }, description: "approval: decidedBy must be one of these. An audit check, not authentication." },
    onReject: { type: "string", enum: ["stop", "continue"], description: "approval: default stop. With continue, later steps run and can branch on {{name}}." },
  },
  required: ["action"],
};

function sessionPageSchema(extra = {}, required = ["sessionId", "pageId"]) {
  return {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      pageId: { type: "string" },
      timeoutMs: { type: "integer", description: "Per-call timeout in milliseconds" },
      ...extra,
    },
    required,
  };
}

function defineTool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function toolResult(payload, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

const mcpTools = [
  defineTool("script_list", "List registered Playwright scripts.", { type: "object", properties: {} }, async () => ({
    scripts: scriptRegistry.list(),
  })),
  defineTool("script_get", "Get one registered Playwright script.", { type: "object", properties: { scriptKey: { type: "string" } }, required: ["scriptKey"] }, async (args) => scriptRegistry.get(args.scriptKey)),
  defineTool("script_sync", "Rescan the scripts directory and return git metadata when available.", { type: "object", properties: {} }, async () => scriptRegistry.sync()),
  defineTool("script_upload", "Upload or replace a Playwright script file. Use this in offline environments where git sync is not available.", { type: "object", properties: { scriptKey: { type: "string", description: "Script key path (e.g. checkout/guest-order)" }, content: { type: "string", description: "Full script source code" }, fileName: { type: "string", description: "Optional file name with a .spec/.test/.pw extension" } }, required: ["scriptKey", "content"] }, async (args) => uploadScript(args)),
  defineTool("script_delete", "Delete a registered script file.", { type: "object", properties: { scriptKey: { type: "string" } }, required: ["scriptKey"] }, async (args) => {
    const script = scriptRegistry.get(args.scriptKey);
    await fsPromises.unlink(script.absolutePath);
    await scriptRegistry.refresh();
    return { deleted: args.scriptKey };
  }),
  defineTool(
    "script_validate",
    "Check a script. mode=syntax parses it without running anything (JavaScript only). mode=discover (default) lists its tests through Playwright, which loads the file and therefore executes its module scope.",
    {
      type: "object",
      properties: {
        scriptKey: { type: "string" },
        scriptPath: { type: "string", description: "Path relative to the scripts directory" },
        filename: { type: "string", description: "File name used when validating inline content" },
        content: { type: "string", description: "Inline script source" },
        mode: { type: "string", enum: ["syntax", "discover"], default: "discover" },
        project: { type: "string" },
        grep: { type: "string" },
      },
    },
    async (args) => runManager.validateScript(args),
  ),
  defineTool("assist_capabilities", "Return LLM-friendly authoring capabilities, workflow hints, and supported locator/action vocabularies.", { type: "object", properties: {} }, async () => scriptAssistant.getCapabilities()),
  defineTool("assist_examples", "Return localized prompt examples, reusable step patterns, and locator guidance for LLM-driven script generation.", { type: "object", properties: { language: { type: "string" } } }, async (args) => scriptAssistant.examples(args)),
  defineTool("assist_plan", "Turn a natural-language test request into a structured scenario plan with suggested steps and MCP workflow.", { type: "object", properties: { goal: { type: "string" }, startUrl: { type: "string" }, baseURL: { type: "string" }, scriptKey: { type: "string" }, language: { type: "string" }, tags: { type: "array" }, locators: { type: "object" }, expectations: { type: "array" }, variables: { type: "object" }, storageStateRef: { type: "string" }, pageInspection: { type: "object" } } }, async (args) => scriptAssistant.plan(args)),
  defineTool("assist_scaffold", "Generate a Playwright script scaffold from a user goal or structured steps, optionally saving and validating it.", { type: "object", properties: { goal: { type: "string" }, testName: { type: "string" }, scriptKey: { type: "string" }, startUrl: { type: "string" }, baseURL: { type: "string" }, language: { type: "string", description: "Authoring locale for comments: ko or en." }, scriptLanguage: { type: "string", enum: ["js", "ts"], description: "Generated file language." }, steps: { type: "array" }, variables: { type: "object" }, save: { type: "boolean" }, overwrite: { type: "boolean" }, validate: { type: "boolean" }, project: { type: "string" }, pageInspection: { type: "object" } } }, async (args) => scriptAssistant.scaffold(args)),
  defineTool(
    "run_create",
    "Queue a Playwright test run. It starts as soon as a slot is free, so the returned status may be \"queued\"; poll run_get. The script is snapshotted and hashed at this point, so later edits do not affect this run.",
    {
      type: "object",
      properties: {
        scriptKey: { type: "string" },
        project: { type: "string", enum: ["chromium", "firefox", "webkit"] },
        env: { type: "string" },
        baseURL: { type: "string" },
        grep: { type: "string", example: "@smoke" },
        headed: { type: "boolean" },
        trace: { type: "string" },
        video: { type: "string" },
        screenshot: { type: "string" },
        storageStateRef: { type: "string", description: "Path relative to STORAGE_STATE_DIR" },
        shard: { type: "string", example: "1/3" },
        timeoutMs: { type: "integer" },
        priority: { type: "integer", default: 0, description: "Higher runs first" },
        environment: { type: "string", description: "Name of an environment whose baseURL, project, storage state, allowlist and variables to apply. Anything set explicitly here wins." },
        dataset: { type: "string", description: "Name of a dataset. Queues one run per row unless datasetRow selects one." },
        datasetRow: { type: "integer", description: "Zero-based row index; omit to queue every row." },
        notify: {
          type: "object",
          description: "POST the result to a URL when the run ends. The payload carries the redacted request, never resolved secrets.",
          properties: {
            url: { type: "string" },
            on: { type: "string", enum: ["failure", "always"], default: "failure" },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["url"],
        },
        urlAllowlist: {
          type: "array",
          items: { type: "string" },
          description: "Narrow this run's network policy, e.g. [\"*.staging.example.com\"]. It can only restrict URL_ALLOWLIST, never widen it; entries the server policy does not permit are reported in network.rejectedAllowlistEntries.",
        },
        variables: { type: "object", additionalProperties: true },
      },
      required: ["scriptKey"],
    },
    async (args) => {
      const { request, environment } = await runManager.composeRequest(args);
      const expanded = await runManager.expandDataset(request);
      if (!request.dataset) {
        return runManager.createRun(expanded[0], { environment });
      }

      const runs = [];
      for (const entry of expanded) {
        runs.push(await runManager.createRun(entry, { environment }));
      }
      return { dataset: request.dataset, rowCount: runs.length, runs };
    },
  ),
  defineTool("run_get", "Get one Playwright run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.serializeRun(runManager.getRun(args.runId))),
  defineTool("run_cancel", "Cancel a running Playwright run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.cancelRun(args.runId)),
  defineTool("run_artifacts", "List files produced by a run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => ({ runId: args.runId, artifacts: await runManager.listArtifacts(args.runId) })),
  defineTool("run_report", "Get the JSON summary report for a run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.getReport(args.runId)),
  defineTool(
    "run_logs",
    "Get captured stdout and stderr for a run. Reads the on-disk log when the in-memory window does not cover it, so logs from a previous server lifetime are still available.",
    {
      type: "object",
      properties: {
        runId: { type: "string" },
        source: { type: "string", enum: ["memory", "file"], description: "Force the on-disk log" },
        limit: { type: "integer", default: 1000, description: "Newest N lines, 1-20000" },
      },
      required: ["runId"],
    },
    async (args) => runManager.getLogs(args.runId, args),
  ),
  defineTool(
    "run_list",
    "List runs, newest first. History survives a restart, so this includes runs from previous server lifetimes.",
    {
      type: "object",
      properties: {
        status: { type: "string", description: "Comma separated: queued, running, completed, failed, cancelled, interrupted" },
        scriptKey: { type: "string" },
        limit: { type: "integer", default: 100, description: "1-500" },
        offset: { type: "integer", default: 0 },
      },
    },
    async (args) => runManager.listRuns(args),
  ),
  defineTool(
    "environment_list",
    "List environments. An environment supplies baseURL, project, storage state, allowlist and variables so the same script can be pointed at dev, staging or production without reassembling them.",
    { type: "object", properties: {} },
    async () => ({ environments: await runManager.environments.list() }),
  ),
  defineTool(
    "environment_get",
    "Get one environment.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.environments.get(args.name),
  ),
  defineTool(
    "environment_save",
    "Create or replace an environment. Put credentials in `variables` as \"{{secret.NAME}}\" rather than literals: a reference is never written to a run record, a literal is.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        baseURL: { type: "string" },
        project: { type: "string", enum: ["chromium", "firefox", "webkit"] },
        storageStateRef: { type: "string" },
        urlAllowlist: { type: "array", items: { type: "string" } },
        variables: { type: "object", additionalProperties: true },
      },
      required: ["name"],
    },
    async (args) => runManager.environments.save(args.name, args),
  ),
  defineTool(
    "environment_delete",
    "Delete an environment.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.environments.remove(args.name),
  ),
  defineTool(
    "schedule_list",
    "List schedules with their cron expression, last fired minute and last error.",
    { type: "object", properties: {} },
    async () => ({ schedules: await runManager.schedules.list() }),
  ),
  defineTool(
    "schedule_get",
    "Get one schedule.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.schedules.get(args.name),
  ),
  defineTool(
    "schedule_save",
    "Create or replace a schedule. The cron expression, the script, the environment and the dataset are all validated now rather than at the scheduled time. Cron is evaluated in the server's local timezone.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        cron: { type: "string", description: "5 fields: minute hour dayOfMonth month dayOfWeek. Supports *, n, a,b, a-b and */n" },
        enabled: { type: "boolean", default: true },
        request: { type: "object", additionalProperties: true, description: "A run request: scriptKey, environment, dataset, variables, ..." },
        notify: {
          type: "object",
          properties: {
            url: { type: "string" },
            on: { type: "string", enum: ["failure", "always"], default: "failure" },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["url"],
        },
      },
      required: ["name", "cron", "request"],
    },
    async (args) => runManager.saveSchedule(args.name, args),
  ),
  defineTool(
    "schedule_delete",
    "Delete a schedule.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.schedules.remove(args.name),
  ),
  defineTool(
    "schedule_trigger",
    "Run a schedule's scenarios now, regardless of its cron. This is what a deploy pipeline calls to gate a release; `variables` here are merged over the stored request so the build under test can be identified.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        variables: { type: "object", additionalProperties: true },
        notify: { type: "object", additionalProperties: true },
      },
      required: ["name"],
    },
    async (args) => runManager.triggerSchedule(args.name, args),
  ),
  defineTool(
    "dataset_list",
    "List datasets with their row counts and columns, without returning the rows.",
    { type: "object", properties: {} },
    async () => {
      const datasets = await runManager.datasets.list();
      return {
        datasets: datasets.map((dataset) => ({
          name: dataset.name,
          rowCount: Array.isArray(dataset.rows) ? dataset.rows.length : 0,
          columns: Array.isArray(dataset.rows) && dataset.rows[0] ? Object.keys(dataset.rows[0]) : [],
          updatedAt: dataset.updatedAt,
        })),
      };
    },
  ),
  defineTool(
    "dataset_get",
    "Get one dataset including its rows.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.datasets.get(args.name),
  ),
  defineTool(
    "dataset_save",
    "Create or replace a dataset. Each row is an object of variable values, merged over the environment's and the request's own variables.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        rows: { type: "array", items: { type: "object", additionalProperties: true }, minItems: 1 },
      },
      required: ["name", "rows"],
    },
    async (args) => runManager.datasets.save(args.name, { rows: args.rows }),
  ),
  defineTool(
    "dataset_delete",
    "Delete a dataset.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async (args) => runManager.datasets.remove(args.name),
  ),
  defineTool(
    "run_queue",
    "Show the run queue: what is waiting, in what order, and how many slots are busy.",
    { type: "object", properties: {} },
    async () => runManager.describeQueue(),
  ),
  defineTool(
    "run_retry",
    "Queue a new run with the same request as a finished one. Returns the new runId; the original is left untouched.",
    { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    async (args) => runManager.retryRun(args.runId),
  ),
  defineTool("run_delete", "Delete a finished run and reclaim its artifacts from disk.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.deleteRun(args.runId)),
  defineTool("session_list", "List active browser sessions.", { type: "object", properties: {} }, async () => ({ sessions: sessionManager.listSessions() })),
  defineTool("session_create", "Create a low-level browser session for debugging.", { type: "object", properties: { browserType: { type: "string" }, headless: { type: "boolean" }, ttlMs: { type: "number" } } }, async (args) => sessionManager.createSession(args)),
  defineTool("session_get", "Get one browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.serializeSession(sessionManager.getSession(args.sessionId))),
  defineTool("session_delete", "Close a browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.closeSession(args.sessionId, "closed")),
  defineTool("session_keepalive", "Extend a browser session TTL.", { type: "object", properties: { sessionId: { type: "string" }, ttlMs: { type: "number" } }, required: ["sessionId"] }, async (args) => sessionManager.keepAlive(args.sessionId, args.ttlMs)),
  defineTool("session_artifacts", "List artifacts captured in a browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => ({ sessionId: args.sessionId, artifacts: await sessionManager.listArtifacts(args.sessionId) })),
  defineTool("session_actions", "List the raw action and event logs for a browser session. Prefer session_timeline, which correlates them.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.listActions(args.sessionId)),
  defineTool(
    "session_timeline",
    "Per-step timeline for a session: each action with its duration, the console and network events it caused, any failure artifacts, and the slowest steps. Use this to find why a step failed instead of correlating session_actions and the event log by hand.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        limit: { type: "integer", default: 200, description: "Most recent N actions, 1-2000" },
        includeEvents: { type: "boolean", default: true, description: "Set false for just durations and issue counts" },
      },
      required: ["sessionId"],
    },
    async (args) => sessionManager.buildTimeline(args.sessionId, args),
  ),
  defineTool("session_trace", "Start or stop Playwright tracing for a context.", { type: "object", properties: { sessionId: { type: "string" }, action: { type: "string" }, contextId: { type: "string" }, title: { type: "string" } }, required: ["sessionId", "action", "contextId"] }, async (args) => args.action === "start" ? sessionManager.startTrace(args.sessionId, args) : sessionManager.stopTrace(args.sessionId, args)),
  defineTool(
    "session_execute",
    "Run a workflow of page steps. The whole workflow holds the session lock, so no other call can interleave between steps. A step can capture a value with saveAs and later steps reference it as {{name}}, which is how a reference number read off the page gets checked against the API in one call. Steps are not limited to a flat list: use if/then/else to branch on the page or on a captured value, repeat/forEach/while to loop (with break and continue), and approval to stop and wait for a person. When a workflow reaches an approval gate the response comes back with status awaiting_approval and an approval.gateId; record a decision with session_approval_decide, then continue with session_execute_resume.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pageId: { type: "string" },
        steps: { type: "array", items: STEP_SCHEMA, minItems: 1 },
        variables: { type: "object", additionalProperties: true, description: "Seed values available as {{name}} from the first step" },
        continueOnError: { type: "boolean", default: false, description: "Keep running later steps after one fails. A malformed condition still fails the workflow, so a typo cannot silently skip a branch." },
        limits: {
          type: "object",
          description: "Tighten this workflow's budget. Values above the server limit are clamped down to it.",
          properties: {
            maxIterations: { type: "integer" },
            maxSteps: { type: "integer" },
            maxDurationMs: { type: "integer" },
          },
        },
      },
      required: ["sessionId", "pageId", "steps"],
    },
    async (args) => sessionManager.execute(args.sessionId, args),
  ),
  defineTool(
    "session_approvals",
    "List the workflows in a session that are stopped at an approval gate, with the message each one is waiting on.",
    { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    async (args) => ({ approvals: sessionManager.listApprovals(args.sessionId) }),
  ),
  defineTool(
    "session_approval_decide",
    "Approve or reject a workflow waiting at a gate. decidedBy is recorded for the audit trail; it is not verified, so do not invent a name — pass the one the person gave you.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        gateId: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        decidedBy: { type: "string", description: "Who decided. Required." },
        comment: { type: "string" },
      },
      required: ["sessionId", "gateId", "decision", "decidedBy"],
    },
    async (args) => sessionManager.decideApproval(args.sessionId, args.gateId, args),
  ),
  defineTool(
    "session_execute_resume",
    "Continue a workflow that stopped at an approval gate, after a decision has been recorded. The remaining steps pick up where they left off, inside the same loop iteration if the gate was in a loop, and the decision is available as {{gateName}}.",
    {
      type: "object",
      properties: { sessionId: { type: "string" }, gateId: { type: "string" } },
      required: ["sessionId", "gateId"],
    },
    async (args) => sessionManager.resumeExecution(args.sessionId, args),
  ),
  defineTool(
    "context_create",
    "Create a browser context (an isolated cookie/storage profile) within a session.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        baseURL: { type: "string" },
        viewport: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
        locale: { type: "string", example: "ko-KR" },
        timezoneId: { type: "string" },
        userAgent: { type: "string" },
        ignoreHTTPSErrors: { type: "boolean" },
        extraHTTPHeaders: { type: "object", additionalProperties: { type: "string" } },
        storageState: { type: "object" },
        dialogPolicy: DIALOG_POLICY_SCHEMA,
        recordVideo: { type: "object", properties: { size: { type: "object" } } },
        permissions: { type: "array", items: { type: "string" } },
      },
      required: ["sessionId"],
    },
    async (args) => sessionManager.createContext(args.sessionId, args),
  ),
  defineTool("context_get", "Get one browser context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.getContext(args.sessionId, args.contextId)),
  defineTool("context_delete", "Close one browser context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.closeContext(args.sessionId, args.contextId)),
  defineTool("context_storage_export", "Export storage state from a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.exportStorageState(args.sessionId, args.contextId)),
  defineTool("context_storage_import", "Import storage state into a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, storageState: { type: "object" }, storageStateRef: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.importStorageState(args.sessionId, args.contextId, args)),
  defineTool("context_route_add", "Register a network route handler.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, url: { type: "string" }, behavior: { type: "object" } }, required: ["sessionId", "contextId", "url"] }, async (args) => sessionManager.addRoute(args.sessionId, args.contextId, args)),
  defineTool("context_route_remove", "Remove a route handler.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, routeId: { type: "string" } }, required: ["sessionId", "contextId", "routeId"] }, async (args) => sessionManager.removeRoute(args.sessionId, args.contextId, args.routeId)),
  defineTool("context_cookies", "Get or set cookies in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, mode: { type: "string" }, cookies: { type: "array" }, urls: { type: "array" } }, required: ["sessionId", "contextId", "mode"] }, async (args) => args.mode === "set" ? sessionManager.setCookies(args.sessionId, args.contextId, args) : sessionManager.getCookies(args.sessionId, args.contextId, args)),
  defineTool("context_permissions", "Grant permissions in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, permissions: { type: "array" }, origin: { type: "string" } }, required: ["sessionId", "contextId", "permissions"] }, async (args) => sessionManager.grantPermissions(args.sessionId, args.contextId, args)),
  defineTool(
    "context_request",
    "Issue an HTTP request through the context, carrying its cookies and headers. Use it to confirm the business outcome a UI action claims to have produced - that the record exists, the status changed, the reference number resolves - rather than trusting the screen.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        contextId: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" },
        url: { type: "string", description: "Absolute, or relative to the context baseURL" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        params: { type: "object", additionalProperties: true, description: "Query string parameters" },
        data: { description: "Request body; an object is sent as JSON" },
        form: { type: "object", additionalProperties: true, description: "Send as application/x-www-form-urlencoded" },
        timeoutMs: { type: "integer" },
      },
      required: ["sessionId", "contextId", "url"],
    },
    async (args) => sessionManager.apiRequest(args.sessionId, args.contextId, args),
  ),
  defineTool(
    "session_downloads",
    "List files the session downloaded. Downloads are captured as artifacts, so the file can be fetched and its contents checked.",
    { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    async (args) => sessionManager.listDownloads(args.sessionId),
  ),
  defineTool("context_headers", "Set default extra HTTP headers for a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, headers: { type: "object" } }, required: ["sessionId", "contextId", "headers"] }, async (args) => sessionManager.setHeaders(args.sessionId, args.contextId, args)),
  defineTool("page_create", "Create a new page in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.createPage(args.sessionId, args.contextId)),
  defineTool("page_get", "Get one page.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.getPage(args.sessionId, args.pageId)),
  defineTool(
    "page_inspect",
    "Inspect a live page: headings, visible text, and locator candidates that have been resolved against the real DOM. Each element reports locatorStatus (\"unique\" | \"ambiguous\" | \"not-found\") and every candidate reports its real matchCount, so prefer bestLocator and treat any ambiguous element as unsafe to act on.",
    sessionPageSchema({
      maxElements: { type: "integer", default: 40, description: "1-200" },
      maxTextLength: { type: "integer", default: 140, description: "20-400" },
      verifyLocators: {
        type: "boolean",
        default: true,
        description: "Resolve each candidate against the page to get its real match count. Disable only for a fast, unverified snapshot.",
      },
      maxVerifiedCandidates: { type: "integer", default: 3, description: "Candidates to verify per element, 1-6" },
    }),
    async (args) => sessionManager.inspectPage(args.sessionId, args.pageId, args),
  ),
  defineTool("page_delete", "Close one page.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.closePage(args.sessionId, args.pageId)),
  defineTool(
    "page_navigate",
    "Navigate the page or move through its history. action=goto requires url.",
    sessionPageSchema({
      action: { type: "string", enum: ["goto", "reload", "goBack", "goForward"] },
      url: { type: "string", description: "Absolute URL; required for goto" },
      waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
    }, ["sessionId", "pageId", "action"]),
    async (args) => sessionManager.navigate(args.sessionId, args.pageId, args.action, args),
  ),
  defineTool(
    "page_action",
    "Run one page action. click/fill/press/hover/selectOption/locatorQuery need `locator`; fill needs `value`; press needs `key`; selectOption needs `values`; drag needs `source` and `target`; evaluate needs `expression`.",
    sessionPageSchema({
      action: {
        type: "string",
        enum: ["click", "fill", "press", "hover", "drag", "selectOption", "evaluate", "locatorQuery"],
      },
      locator: LOCATOR_SCHEMA,
      source: LOCATOR_SCHEMA,
      target: LOCATOR_SCHEMA,
      value: { type: "string", description: "Text to type for fill" },
      key: { type: "string", description: "Key name for press, e.g. Enter" },
      values: { type: "array", items: { type: "string" }, description: "Options to select for selectOption" },
      expression: { type: "string", description: "JavaScript for evaluate, e.g. () => document.title" },
      arg: { description: "Argument passed to the evaluate expression" },
      operation: {
        type: "string",
        enum: ["count", "allTextContents", "textContent", "innerText", "isVisible"],
        description: "locatorQuery read to perform",
      },
      button: { type: "string", enum: ["left", "right", "middle"] },
      clickCount: { type: "integer" },
      force: { type: "boolean" },
      modifiers: { type: "array", items: { type: "string" } },
      delay: { type: "integer" },
    }, ["sessionId", "pageId", "action"]),
    async (args) => sessionManager.pageAction(args.sessionId, args.pageId, args.action, args),
  ),
  defineTool(
    "page_assert",
    "Assert page state. visible/count need `locator`; text needs `locator` and `expected`; url needs `expected`; count needs a numeric `expected`. Wrap a value in \"/pattern/flags\" to match it as a regular expression.",
    sessionPageSchema({
      action: { type: "string", enum: ["visible", "text", "url", "count"] },
      locator: LOCATOR_SCHEMA,
      expected: { description: "Expected text, URL, or count" },
      match: { type: "string", enum: ["contains", "equals", "startsWith", "endsWith"], default: "contains" },
      operator: { type: "string", enum: ["eq", "gt", "gte", "lt", "lte"], default: "eq" },
    }, ["sessionId", "pageId", "action"]),
    async (args) => sessionManager.pageAssert(args.sessionId, args.pageId, args.action, args),
  ),
  defineTool(
    "page_wait_for",
    "Wait for a page condition. Exactly one of loadState, url, locator, text, textGone, or sleepMs is required.",
    sessionPageSchema({
      loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
      url: { type: "string", description: "URL or \"/pattern/flags\" regular expression" },
      locator: LOCATOR_SCHEMA,
      state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], default: "visible" },
      text: { type: "string", description: "Wait until this text is visible" },
      textGone: { type: "string", description: "Wait until this text disappears" },
      sleepMs: { type: "integer", description: "Unconditional delay; prefer a real condition" },
      exact: { type: "boolean" },
    }),
    async (args) => sessionManager.waitFor(args.sessionId, args.pageId, args),
  ),
  defineTool(
    "page_dialog_policy",
    "Set how this page answers alert/confirm/prompt dialogs. Without a policy the server default (dismiss) applies; action=ignore leaves the dialog open and will block whatever opened it.",
    sessionPageSchema({
      action: { type: "string", enum: ["accept", "dismiss", "ignore"] },
      promptText: { type: "string" },
    }, ["sessionId", "pageId", "action"]),
    async (args) => sessionManager.setDialogPolicy(args.sessionId, args.pageId, args),
  ),
  defineTool(
    "page_screenshot",
    "Capture a screenshot and store it as a downloadable artifact.",
    sessionPageSchema({
      fullPage: { type: "boolean", default: true },
      type: { type: "string", enum: ["png", "jpeg"], default: "png" },
      quality: { type: "integer", description: "jpeg only, 0-100" },
      omitBackground: { type: "boolean" },
    }),
    async (args) => sessionManager.screenshot(args.sessionId, args.pageId, args),
  ),
  defineTool(
    "page_pdf",
    "Render the page to PDF and store it as an artifact. Chromium sessions only.",
    sessionPageSchema({
      format: { type: "string", example: "A4" },
      landscape: { type: "boolean" },
      printBackground: { type: "boolean", default: true },
      scale: { type: "number" },
      margin: { type: "object", additionalProperties: { type: "string" } },
    }),
    async (args) => sessionManager.pdf(args.sessionId, args.pageId, args),
  ),
];

const mcpToolMap = new Map(mcpTools.map((tool) => [tool.name, tool]));

function createMcpSession() {
  const sessionId = createId("mcp");
  mcpSessions.set(sessionId, {
    sessionId,
    createdAt: toIso(),
    updatedAt: toIso(),
  });
  return sessionId;
}

// MCP sessions are just bookkeeping, but clients rarely send DELETE /mcp, so
// they have to age out or the map grows for the lifetime of the process.
const mcpCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - config.mcpSessionTtlMs;
  for (const [sessionId, session] of mcpSessions) {
    if (Date.parse(session.updatedAt) <= cutoff) {
      mcpSessions.delete(sessionId);
    }
  }
}, Math.min(config.mcpSessionTtlMs, 5 * 60 * 1000));
mcpCleanupTimer.unref?.();

function requireMcpSession(req, requestMessage) {
  const sessionId = req.header("Mcp-Session-Id");
  if (requestMessage?.method === "initialize") {
    return sessionId;
  }
  if (!sessionId) {
    throw new ApiError(400, "MCP_SESSION_REQUIRED", "Mcp-Session-Id header is required after initialize");
  }
  if (!mcpSessions.has(sessionId)) {
    throw new ApiError(404, "MCP_SESSION_NOT_FOUND", "MCP session not found");
  }
  const session = mcpSessions.get(sessionId);
  session.updatedAt = toIso();
  return sessionId;
}

async function handleMcpRequest(req, message) {
  if (!message || typeof message !== "object") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  if (!message.method) {
    return undefined;
  }

  // JSON-RPC notifications carry no id and must never receive a response, not
  // even an error one.
  const isNotification = message.id === undefined || message.id === null;

  if (message.method === "initialize") {
    return jsonRpcResult(message.id ?? null, {
      protocolVersion: config.protocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: config.serviceName,
        version: config.serviceVersion,
      },
    });
  }

  requireMcpSession(req, message);

  switch (message.method) {
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
    case "notifications/roots/list_changed":
      return undefined;
    case "ping":
      return jsonRpcResult(message.id ?? null, {});
    case "tools/list":
      return jsonRpcResult(message.id ?? null, {
        tools: mcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case "tools/call": {
      const tool = mcpToolMap.get(message.params?.name);
      if (!tool) {
        return jsonRpcError(message.id ?? null, -32601, `Unknown tool: ${message.params?.name}`);
      }
      try {
        const output = await tool.handler(message.params?.arguments || {});
        return jsonRpcResult(message.id ?? null, toolResult(output));
      } catch (error) {
        const apiError = toApiError(error);
        return jsonRpcResult(message.id ?? null, toolResult({
          error: {
            code: apiError.code,
            message: apiError.message,
            details: apiError.details,
          },
          artifacts: apiError.artifacts,
        }, true));
      }
    }
    default:
      if (isNotification) {
        return undefined;
      }
      return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

app.get(config.mcpBasePath, asyncRoute(async (req, res) => {
  res.setHeader("Allow", "POST, DELETE");
  res.status(405).json({
    error: "SSE stream is not enabled on this MCP endpoint. Use POST for requests and DELETE to end the session.",
  });
}));

app.delete(config.mcpBasePath, asyncRoute(async (req, res) => {
  const sessionId = req.header("Mcp-Session-Id");
  if (!sessionId || !mcpSessions.has(sessionId)) {
    throw new ApiError(404, "MCP_SESSION_NOT_FOUND", "MCP session not found");
  }
  mcpSessions.delete(sessionId);
  res.status(204).send();
}));

app.post(config.mcpBasePath, asyncRoute(async (req, res) => {
  const payload = req.body;
  const messages = Array.isArray(payload) ? payload : [payload];
  const hasInitialize = messages.some((message) => message?.method === "initialize");
  const sessionId = hasInitialize ? createMcpSession() : requireMcpSession(req, messages[0]);
  const responses = (await Promise.all(messages.map((message) => handleMcpRequest(req, message))))
    .filter(Boolean);

  if (hasInitialize) {
    res.setHeader("Mcp-Session-Id", sessionId);
  }

  if (!responses.length) {
    return res.status(202).send();
  }

  return res.status(200).json(Array.isArray(payload) ? responses : responses[0]);
}));

// Unknown routes must stay on the JSON contract; Express' default handler
// returns an HTML error page.
app.use((req, res, next) => {
  next(new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));
});

app.use((error, req, res, next) => {
  const apiError = toApiError(error);
  if (apiError.statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.path} requestId=${req.requestId} ${apiError.code}`, error);
  }

  if (res.headersSent) {
    return res.end();
  }

  return res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
      requestId: req.requestId,
    },
    artifacts: apiError.artifacts,
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`${config.serviceName} listening on http://${config.host}:${config.port}`);
  if (config.apiToken) {
    console.log("API_TOKEN is set — /api and /mcp require a bearer token");
  }
  if (isDocker) {
    console.log("Docker environment detected - Chromium: channel=chromium, --disable-gpu --no-sandbox --disable-dev-shm-usage");
  }
});

// Without this, a busy port surfaced as an unhandled 'error' event and a raw
// stack trace instead of an actionable message.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`port ${config.port} is already in use — set PORT to a free port`);
  } else {
    console.error("server failed to start", error);
  }
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, 5000).unref?.();
  });
  // Spawned Playwright runs are children of this process; leaving them behind
  // orphaned browsers on every container restart.
  runManager.stopScheduler();
  await runManager.killAll();
  await sessionManager.shutdown();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error("graceful shutdown failed", error);
      process.exit(1);
    });
  });
}

// A rejected promise in a detached listener (a page event, a run's close
// handler) must not be allowed to take the whole server down.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});
