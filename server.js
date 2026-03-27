import express from "express";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const require = createRequire(import.meta.url);
const swaggerUiAssetDir = path.dirname(require.resolve("swagger-ui-dist/package.json"));
const documentationPaths = {
  openApi: "/openapi.json",
  docs: "/docs",
  playground: "/playground",
  swaggerAssets: "/swagger-ui",
};

const config = {
  serviceName: process.env.SERVICE_NAME || "playwright-player",
  serviceVersion: process.env.SERVICE_VERSION || "0.1.1",
  host: process.env.HOST || "0.0.0.0",
  port: parseInteger(process.env.PORT, 3000),
  apiBasePath: process.env.API_BASE_PATH || "/api",
  mcpBasePath: process.env.MCP_BASE_PATH || "/mcp",
  scriptsDir: path.resolve(process.env.SCRIPTS_DIR || path.join(rootDir, "scripts")),
  runsDir: path.resolve(process.env.RUNS_DIR || path.join(rootDir, "data", "runs")),
  artifactsDir: path.resolve(process.env.ARTIFACTS_DIR || path.join(rootDir, "data", "artifacts")),
  storageStateDir: path.resolve(process.env.STORAGE_STATE_DIR || path.join(rootDir, "storage-states")),
  bodyLimit: process.env.BODY_LIMIT || "5mb",
  defaultBrowserType: process.env.DEFAULT_BROWSER_TYPE || "chromium",
  defaultHeadless: parseBoolean(process.env.DEFAULT_HEADLESS, true),
  sessionTtlMs: parseInteger(process.env.SESSION_TTL_MS, 30 * 60 * 1000),
  cleanupIntervalMs: parseInteger(process.env.SESSION_CLEANUP_INTERVAL_MS, 30 * 1000),
  maxContextsPerSession: parseInteger(process.env.MAX_CONTEXTS_PER_SESSION, 5),
  maxPagesPerSession: parseInteger(process.env.MAX_PAGES_PER_SESSION, 10),
  maxActionLogEntries: parseInteger(process.env.MAX_ACTION_LOG_ENTRIES, 500),
  maxEventLogEntries: parseInteger(process.env.MAX_EVENT_LOG_ENTRIES, 1500),
  maxRunLogEntries: parseInteger(process.env.MAX_RUN_LOG_ENTRIES, 3000),
  enableEvaluate: parseBoolean(process.env.ENABLE_EVALUATE, true),
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

await ensureDir(config.scriptsDir);
await ensureDir(config.runsDir);
await ensureDir(config.artifactsDir);

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
      const revParse = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], rootDir);
      if (!revParse.stdout.includes("true")) {
        return { available: false };
      }

      const branch = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
      const commit = await runCommand("git", ["rev-parse", "HEAD"], rootDir);
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

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
      }
    });
  });
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

function renderPlaywrightConfig({ scriptsDir, outputDir, htmlReportDir, jsonReportPath }) {
  return `import { defineConfig, devices } from "@playwright/test";

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
    ["html", { open: "never", outputFolder: ${JSON.stringify(htmlReportDir)} }],
  ],
  use: {
    baseURL,
    headless: !headed,
    trace,
    video,
    screenshot,
    storageState,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "webkit", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
`;
}

class RunManager {
  constructor(options) {
    this.options = options;
    this.registry = options.registry;
    this.runs = new Map();
  }

  listRuns() {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => this.serializeRun(run));
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
      pid: run.pid,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      request: run.request,
      paths: run.paths,
      logCount: run.logs.length,
      artifactCount: run.artifacts.length,
      summary: run.summary,
    };
  }

  appendLog(run, stream, chunk) {
    const message = chunk.toString("utf8");
    const lines = message.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      run.logs.push({
        ts: toIso(),
        stream,
        line: truncate(line, 4000),
      });
    }

    if (run.logs.length > this.options.maxRunLogEntries) {
      run.logs.splice(0, run.logs.length - this.options.maxRunLogEntries);
    }
  }

  async createRun(request) {
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

    const runId = createId("run");
    const runDir = path.join(this.options.runsDir, runId);
    const outputDir = path.join(runDir, "test-results");
    const htmlReportDir = path.join(runDir, "html-report");
    const jsonReportPath = path.join(runDir, "report.json");
    const configPath = path.join(runDir, "playwright.config.mjs");

    await ensureDir(runDir);
    await ensureDir(outputDir);
    await fsPromises.writeFile(
      configPath,
      renderPlaywrightConfig({
        scriptsDir: this.options.scriptsDir,
        outputDir,
        htmlReportDir,
        jsonReportPath,
      }),
      "utf8",
    );

    const args = [
      this.options.playwrightCliPath,
      "test",
      script.absolutePath,
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

    const env = {
      ...process.env,
      PW_PLAYER_RUN_ID: runId,
      PW_PLAYER_SCRIPT_KEY: request.scriptKey,
      PW_PLAYER_TARGET_ENV: request.env || "",
      PW_PLAYER_BASE_URL: request.baseURL || "",
      PW_PLAYER_HEADED: String(Boolean(request.headed)),
      PW_PLAYER_TRACE: request.trace || "on-first-retry",
      PW_PLAYER_VIDEO: request.video || "retain-on-failure",
      PW_PLAYER_SCREENSHOT: request.screenshot || "only-on-failure",
      PW_PLAYER_STORAGE_STATE: request.storageStateRef ? this.resolveStorageState(request.storageStateRef) : "",
      PW_PLAYER_VARIABLES_JSON: JSON.stringify(request.variables || {}),
      PW_PLAYER_TIMEOUT_MS: String(request.timeoutMs || 30_000),
    };

    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const run = {
      runId,
      scriptKey: request.scriptKey,
      request,
      status: "running",
      createdAt: toIso(),
      startedAt: toIso(),
      endedAt: null,
      exitCode: null,
      signal: null,
      pid: child.pid,
      paths: {
        runDir,
        configPath,
        outputDir,
        htmlReportDir,
        jsonReportPath,
      },
      logs: [],
      artifacts: [],
      summary: null,
      process: child,
      cancelRequested: false,
    };

    this.runs.set(runId, run);

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
    });
    child.on("close", async (code, signal) => {
      run.exitCode = code;
      run.signal = signal;
      run.endedAt = toIso();
      run.process = null;
      if (run.cancelRequested) {
        run.status = "cancelled";
      } else if (code === 0) {
        run.status = "completed";
      } else {
        run.status = "failed";
      }

      run.summary = await this.buildSummary(run);
      run.artifacts = await this.listArtifacts(run.runId);
    });

    return this.serializeRun(run);
  }

  async buildSummary(run) {
    const report = await readJsonFile(run.paths.jsonReportPath);
    const artifacts = await collectFilesWithMetadata(run.paths.runDir);
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
    if (path.isAbsolute(reference)) {
      return reference;
    }

    return path.resolve(this.options.storageStateDir, reference);
  }

  async validateScript(request) {
    const validationId = createId("validation");
    const validationDir = path.join(this.options.runsDir, validationId);
    await ensureDir(validationDir);

    let targetPath;
    if (request.content) {
      const fileName = request.filename || "inline.spec.js";
      targetPath = path.join(validationDir, fileName);
      await fsPromises.writeFile(targetPath, request.content, "utf8");
    } else if (request.scriptKey) {
      targetPath = this.registry.get(request.scriptKey).absolutePath;
    } else if (request.scriptPath) {
      targetPath = path.resolve(request.scriptPath);
      if (!(await fileExists(targetPath))) {
        throw new ApiError(404, "SCRIPT_NOT_FOUND", `Script not found: ${request.scriptPath}`);
      }
    } else {
      throw new ApiError(400, "INVALID_REQUEST", "scriptKey, scriptPath, or content is required");
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

    const result = await runCommand(process.execPath, args, rootDir).catch((error) => ({
      stdout: "",
      stderr: error.message,
      code: 1,
    }));

    return {
      valid: result.code === 0,
      validationId,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async cancelRun(runId) {
    const run = this.getRun(runId);
    if (!run.process) {
      return {
        runId,
        status: run.status,
      };
    }

    run.cancelRequested = true;
    run.process.kill("SIGTERM");
    return {
      runId,
      status: "cancelling",
    };
  }

  async listArtifacts(runId) {
    const run = this.getRun(runId);
    return collectFilesWithMetadata(run.paths.runDir);
  }

  async getReport(runId) {
    const run = this.getRun(runId);
    return {
      ...this.serializeRun(run),
      report: await readJsonFile(run.paths.jsonReportPath),
      summary: run.summary || (await this.buildSummary(run)),
    };
  }

  getLogs(runId) {
    const run = this.getRun(runId);
    return {
      runId,
      status: run.status,
      logs: run.logs,
    };
  }
}

function normalizePattern(value) {
  if (!value || typeof value !== "string") {
    return value;
  }

  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const lastSlash = value.lastIndexOf("/");
    return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
  }

  return value;
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
    case "contains":
    default:
      return normalizedActual.includes(normalizedExpected);
  }
}

async function poll(timeoutMs, fn, onTimeoutMessage) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) {
      return;
    }
    await sleep(200);
  }

  throw new ApiError(408, "TIMEOUT", onTimeoutMessage);
}

class SessionManager {
  constructor(options) {
    this.options = options;
    this.sessions = new Map();
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
    const session = this.getSession(sessionId);
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

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
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
    session.actions.push({
      ts: toIso(),
      ...action,
    });
    if (session.actions.length > this.options.maxActionLogEntries) {
      session.actions.splice(0, session.actions.length - this.options.maxActionLogEntries);
    }
  }

  logEvent(session, event) {
    session.events.push({
      ts: toIso(),
      ...event,
    });
    if (session.events.length > this.options.maxEventLogEntries) {
      session.events.splice(0, session.events.length - this.options.maxEventLogEntries);
    }
  }

  assertAllowedUrl(url) {
    const allowlist = this.options.urlAllowlist;
    if (!allowlist.length) {
      return;
    }

    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowed = allowlist.some((entry) => {
      const normalized = entry.toLowerCase();
      if (normalized === "*") {
        return true;
      }
      if (normalized.startsWith("*.")) {
        const suffix = normalized.slice(2);
        return hostname === suffix || hostname.endsWith(`.${suffix}`);
      }
      return hostname === normalized;
    });

    if (!allowed) {
      throw new ApiError(403, "URL_NOT_ALLOWED", `URL host is not in allowlist: ${hostname}`);
    }
  }

  async createSession(request = {}) {
    const browserType = request.browserType || this.options.defaultBrowserType;
    const launcher = browsers[browserType];
    if (!launcher) {
      throw new ApiError(400, "INVALID_BROWSER", `Unsupported browser type: ${browserType}`);
    }

    const sessionId = createId("sess");
    const browser = await launcher.launch(
      cleanObject({
        headless: request.headless ?? this.options.defaultHeadless,
        slowMo: request.slowMo,
        channel: request.channel,
        proxy: request.proxy,
        args: [...this.options.launchArgs, ...(request.launchArgs || [])],
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
      actions: [],
      events: [],
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
    await session.browser.close().catch(() => undefined);
    session.status = reason;
    session.updatedAt = toIso();
    return {
      sessionId,
      status: reason,
    };
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
    page.on("dialog", (dialog) => {
      this.logEvent(session, {
        type: "dialog",
        pageId: pageRecord.pageId,
        dialogType: dialog.type(),
        message: dialog.message(),
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        pageRecord.lastUrl = frame.url();
      }
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
        tracing: false,
      };

      this.attachContextListeners(session, contextRecord);
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
      await pageRecord.page.close();
      this.touch(session);
      return {
        pageId,
        status: "closed",
      };
    });
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
    return this.serializeArtifact(session.sessionId, artifact);
  }

  async captureFailureArtifacts(session, pageRecord, actionType) {
    const artifacts = {};
    if (pageRecord.page.isClosed()) {
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
        const storagePath = path.isAbsolute(request.storageStateRef)
          ? request.storageStateRef
          : path.resolve(this.options.storageStateDir, request.storageStateRef);
        if (!(await fileExists(storagePath))) {
          throw new ApiError(404, "STORAGE_STATE_NOT_FOUND", `Storage state not found: ${request.storageStateRef}`);
        }
        storageState = await readJsonFile(storagePath);
      }
      if (!storageState) {
        throw new ApiError(400, "INVALID_REQUEST", "storageState or storageStateRef is required");
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
              path: behavior.path,
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
    try {
      const result = await executor(pageRecord);
      pageRecord.updatedAt = toIso();
      this.touch(session);
      this.logAction(session, {
        type,
        status: "ok",
        pageId,
        contextId: pageRecord.contextId,
        input,
        output: summarize(result),
      });
      return result;
    } catch (error) {
      const artifacts = await this.captureFailureArtifacts(session, pageRecord, type);
      this.logAction(session, {
        type,
        status: "error",
        pageId,
        contextId: pageRecord.contextId,
        input,
        error: error.message,
      });
      throw toApiError(error, {
        statusCode: error instanceof ApiError ? error.statusCode : 500,
        code: error instanceof ApiError ? error.code : "PLAYWRIGHT_ACTION_ERROR",
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

  async navigate(sessionId, pageId, action, request = {}) {
    return this.withLock(sessionId, async (session) => {
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

  async pageAction(sessionId, pageId, action, request = {}) {
    return this.withLock(sessionId, async (session) => {
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
            await resolveLocator(page, request.locator).press(request.key, {
              delay: request.delay,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "selectOption": {
            const selected = await resolveLocator(page, request.locator).selectOption(
              request.values || request.value || request.options,
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
            await resolveLocator(page, request.source).dragTo(resolveLocator(page, request.target), {
              force: request.force,
              timeout: request.timeoutMs,
            });
            return this.serializePage(pageRecord);
          case "evaluate":
            if (!this.options.enableEvaluate) {
              throw new ApiError(403, "EVALUATE_DISABLED", "page.evaluate is disabled by configuration");
            }
            if (!request.expression) {
              throw new ApiError(400, "INVALID_REQUEST", "expression is required");
            }
            return {
              pageId,
              result: await page.evaluate(request.expression, request.arg),
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

  async pageAssert(sessionId, pageId, action, request = {}) {
    return this.withLock(sessionId, async (session) => {
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

  async waitFor(sessionId, pageId, request = {}) {
    return this.withLock(sessionId, async (session) => {
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
        } else {
          await sleep(timeoutMs);
        }
        return {
          pageId,
          success: true,
          url: page.url(),
        };
      });
    });
  }

  async screenshot(sessionId, pageId, request = {}) {
    return this.withLock(sessionId, async (session) => {
      return this.runPageCommandLocked(session, pageId, "page.screenshot", request, async (pageRecord) => {
        const extension = request.type || "png";
        const buffer = await pageRecord.page.screenshot(cleanObject({
          fullPage: request.fullPage ?? true,
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
      return {
        contextId: contextRecord.contextId,
        tracing: false,
        artifact: this.serializeArtifact(session.sessionId, artifact),
      };
    });
  }

  async execute(sessionId, request = {}) {
    if (!Array.isArray(request.steps) || !request.steps.length) {
      throw new ApiError(400, "INVALID_REQUEST", "steps must be a non-empty array");
    }

    const results = [];
    for (const step of request.steps) {
      switch (step.action) {
        case "goto":
        case "reload":
        case "goBack":
        case "goForward":
          results.push(await this.navigate(sessionId, request.pageId, step.action, step));
          break;
        case "click":
        case "fill":
        case "press":
        case "selectOption":
        case "hover":
        case "drag":
        case "evaluate":
        case "locatorQuery":
          results.push(await this.pageAction(sessionId, request.pageId, step.action, step));
          break;
        case "assertVisible":
          results.push(await this.pageAssert(sessionId, request.pageId, "visible", step));
          break;
        case "assertText":
          results.push(await this.pageAssert(sessionId, request.pageId, "text", step));
          break;
        case "assertUrl":
          results.push(await this.pageAssert(sessionId, request.pageId, "url", step));
          break;
        case "assertCount":
          results.push(await this.pageAssert(sessionId, request.pageId, "count", step));
          break;
        case "waitFor":
          results.push(await this.waitFor(sessionId, request.pageId, step));
          break;
        case "screenshot":
          results.push(await this.screenshot(sessionId, request.pageId, step));
          break;
        default:
          throw new ApiError(400, "INVALID_STEP", `Unsupported execute step: ${step.action}`);
      }
    }

    return {
      pageId: request.pageId,
      results,
    };
  }

  async listArtifacts(sessionId) {
    const session = this.getSession(sessionId);
    return [...session.artifacts.values()].map((artifact) => this.serializeArtifact(sessionId, artifact));
  }

  getArtifact(sessionId, artifactId) {
    const session = this.getSession(sessionId);
    const artifact = session.artifacts.get(artifactId);
    if (!artifact) {
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
    }
    return artifact;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host") || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}

function buildOpenApiSpec(req) {
  const baseUrl = getBaseUrl(req);
  const api = config.apiBasePath;

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
        ExecuteBatchRequest: {
          type: "object",
          required: ["pageId", "steps"],
          properties: {
            pageId: { type: "string", example: "page_1234567890abcdef" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", example: "goto" },
                  url: { type: "string", example: `${baseUrl}/demo/test-page` },
                  locator: { $ref: "#/components/schemas/Locator" },
                  value: { type: "string" },
                },
              },
            },
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
      [`${api}/scripts/{scriptKey}`]: {
        get: {
          tags: ["Scripts"],
          summary: "Get script details",
          parameters: [{ name: "scriptKey", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Script metadata" },
            404: { description: "Script not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
      },
      [`${api}/runs`]: {
        get: {
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
          summary: "Execute a batch of page actions",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExecuteBatchRequest" },
              },
            },
          },
          responses: { 200: { description: "Batch execution result" } },
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

function renderHomePage(req) {
  const baseUrl = getBaseUrl(req);
  const entries = [
    { href: documentationPaths.docs, label: "Swagger UI", description: "Browse the REST and MCP API in an offline-friendly UI." },
    { href: documentationPaths.playground, label: "API Playground", description: "Call the service interactively, create sessions, and capture screenshots." },
    { href: "/demo/test-page", label: "Demo Test Page", description: "Simple local page for stable Playwright automation checks." },
    { href: documentationPaths.openApi, label: "OpenAPI JSON", description: "Raw OpenAPI document for client generation or import." },
    { href: "/health", label: "Health", description: "Quick service status and counters." },
  ];

  const cards = entries.map((entry) => `
    <a class="card" href="${escapeHtml(entry.href)}">
      <strong>${escapeHtml(entry.label)}</strong>
      <span>${escapeHtml(entry.description)}</span>
      <code>${escapeHtml(baseUrl + entry.href)}</code>
    </a>
  `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.serviceName)} Home</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe7;
      --panel: rgba(255,255,255,0.9);
      --ink: #1d2433;
      --muted: #5b6476;
      --line: rgba(29,36,51,0.12);
      --accent: #0f766e;
      --accent-2: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Pretendard Variable", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.18), transparent 34%),
        radial-gradient(circle at bottom right, rgba(239,68,68,0.14), transparent 36%),
        linear-gradient(180deg, #f6f1e7 0%, #ece9e4 100%);
      min-height: 100vh;
    }
    main {
      width: min(1040px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0 56px;
    }
    .hero {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      padding: 28px;
      box-shadow: 0 18px 50px rgba(29,36,51,0.08);
      backdrop-filter: blur(12px);
    }
    .hero h1 {
      margin: 0 0 10px;
      font-size: clamp(2rem, 4vw, 3.5rem);
      letter-spacing: -0.04em;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 720px;
      line-height: 1.65;
      font-size: 1.05rem;
    }
    .grid {
      margin-top: 24px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .card {
      display: grid;
      gap: 8px;
      padding: 18px;
      text-decoration: none;
      color: inherit;
      background: rgba(255,255,255,0.86);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: 0 12px 34px rgba(29,36,51,0.06);
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      border-color: rgba(15,118,110,0.35);
      box-shadow: 0 20px 40px rgba(29,36,51,0.12);
    }
    .card strong { font-size: 1.05rem; }
    .card span {
      color: var(--muted);
      line-height: 1.55;
      min-height: 3.1em;
    }
    .card code {
      color: var(--accent);
      word-break: break-all;
      font-size: .9rem;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>${escapeHtml(config.serviceName)}</h1>
      <p>
        This container serves the stateful Playwright REST API, Streamable MCP endpoint, Swagger UI, and a local demo page for offline browser automation.
        Use the links below to inspect the API surface quickly or drive the built-in test page with screenshot capture.
      </p>
    </section>
    <section class="grid">${cards}</section>
  </main>
</body>
</html>`;
}

function renderSwaggerPage(req) {
  const openApiUrl = `${getBaseUrl(req)}${documentationPaths.openApi}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.serviceName)} Swagger UI</title>
  <link rel="stylesheet" href="${documentationPaths.swaggerAssets}/swagger-ui.css">
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; background: #f8fafc; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${documentationPaths.swaggerAssets}/swagger-ui-bundle.js"></script>
  <script src="${documentationPaths.swaggerAssets}/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(openApiUrl)},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      displayRequestDuration: true,
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
      tryItOutEnabled: true
    });
  </script>
</body>
</html>`;
}

function renderPlaygroundPage() {
  const clientConfig = {
    apiBasePath: config.apiBasePath,
    docsPath: documentationPaths.docs,
    openApiPath: documentationPaths.openApi,
    demoPath: "/demo/test-page",
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.serviceName)} Playground</title>
  <style>
    :root {
      color-scheme: light;
      --panel: rgba(255,255,255,0.94);
      --ink: #1f2937;
      --muted: #667085;
      --line: rgba(17,24,39,0.12);
      --primary: #0f766e;
      --accent: #c2410c;
      --shadow: 0 18px 48px rgba(17,24,39,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Pretendard Variable", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.15), transparent 28%),
        radial-gradient(circle at top right, rgba(194,65,12,0.12), transparent 28%),
        linear-gradient(180deg, #f5f2ec 0%, #ece6df 100%);
      min-height: 100vh;
    }
    main { width: min(1180px, calc(100vw - 24px)); margin: 0 auto; padding: 20px 0 28px; display: grid; gap: 18px; }
    .hero, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); }
    .hero { padding: 24px; }
    .hero h1 { margin: 0 0 10px; font-size: clamp(1.9rem, 4vw, 3.2rem); letter-spacing: -0.05em; }
    .hero p, .panel p { margin: 0 0 14px; color: var(--muted); line-height: 1.6; }
    .hero nav, .row { display: flex; flex-wrap: wrap; gap: 10px; }
    .layout { display: grid; grid-template-columns: 1.15fr .85fr; gap: 18px; }
    .left, .right, .stack, .grid2 { display: grid; gap: 12px; }
    .panel { padding: 18px; }
    .grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    a, button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      background: var(--primary);
      color: #fff;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
      text-decoration: none;
    }
    button.secondary, a.secondary { background: #e5e7eb; color: #111827; }
    button.warn { background: var(--accent); }
    label { display: grid; gap: 6px; font-size: .94rem; font-weight: 600; }
    input, select, textarea, pre {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      padding: 11px 12px;
      font: inherit;
    }
    textarea { min-height: 110px; resize: vertical; }
    .status {
      border-radius: 14px;
      padding: 12px 14px;
      background: rgba(15,118,110,0.08);
      color: #0f766e;
      font-weight: 600;
    }
    .status.error { background: rgba(194,65,12,0.1); color: #9a3412; }
    pre { margin: 0; min-height: 280px; overflow: auto; background: #0f172a; color: #dbeafe; line-height: 1.5; }
    .preview {
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid var(--line);
      min-height: 180px;
      background: linear-gradient(135deg, rgba(15,118,110,0.1), rgba(194,65,12,0.08));
      display: grid;
      place-items: center;
      color: var(--muted);
    }
    .preview img { display: block; max-width: 100%; height: auto; }
    @media (max-width: 980px) {
      .layout, .grid2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>API Playground</h1>
      <p>Use this page to call the built-in REST API against the current container, create a live browser session, navigate to the local demo page, and preview screenshot artifacts without leaving the browser.</p>
      <nav>
        <a href="${documentationPaths.docs}">Open Swagger UI</a>
        <a class="secondary" href="/demo/test-page" target="_blank" rel="noreferrer">Open Demo Test Page</a>
        <a class="secondary" href="${documentationPaths.openApi}" target="_blank" rel="noreferrer">OpenAPI JSON</a>
      </nav>
    </section>

    <section class="layout">
      <div class="left">
        <section class="panel">
          <h2>Quick Calls</h2>
          <p>Basic endpoints for connectivity and script registry checks.</p>
          <div class="row">
            <button type="button" id="healthBtn">GET /health</button>
            <button type="button" id="syncScriptsBtn" class="secondary">POST /api/scripts/sync</button>
            <button type="button" id="loadScriptsBtn" class="secondary">GET /api/scripts</button>
          </div>
        </section>

        <section class="panel">
          <h2>Create Run</h2>
          <p>Submit a script execution request using the registered script list from this container.</p>
          <div class="grid2">
            <label>Script<select id="scriptKey"></select></label>
            <label>Project<input id="project" value="chromium"></label>
            <label>Environment<input id="envName" value="local"></label>
            <label>Base URL<input id="baseUrl" value=""></label>
            <label>Grep<input id="grep" placeholder="@smoke"></label>
            <label>Storage State Ref<input id="storageStateRef" placeholder="auth/customer.json"></label>
          </div>
          <label>Variables JSON
            <textarea id="variablesJson">{
  "locale": "ko-KR",
  "source": "playground"
}</textarea>
          </label>
          <div class="row">
            <button type="button" id="createRunBtn">POST /api/runs</button>
            <button type="button" id="listRunsBtn" class="secondary">GET /api/runs</button>
          </div>
        </section>

        <section class="panel">
          <h2>Session Flow</h2>
          <p>Create a low-level session, open the local demo page, click and type, then capture a screenshot artifact.</p>
          <div class="grid2">
            <label>Session ID<input id="sessionId" readonly placeholder="Created session id"></label>
            <label>Context ID<input id="contextId" readonly placeholder="Created context id"></label>
            <label>Page ID<input id="pageId" readonly placeholder="Created page id"></label>
            <label>Chat Message<input id="messageText" value="hello from playground"></label>
          </div>
          <div class="row">
            <button type="button" id="createSessionBtn">Create Session</button>
            <button type="button" id="createContextBtn" class="secondary">Create Context</button>
            <button type="button" id="createPageBtn" class="secondary">Create Page</button>
          </div>
          <div class="row">
            <button type="button" id="gotoDemoBtn">Goto Demo</button>
            <button type="button" id="clickPrimaryBtn" class="secondary">Click Primary</button>
            <button type="button" id="sendMessageBtn" class="secondary">Send Message</button>
            <button type="button" id="takeScreenshotBtn">Take Screenshot</button>
            <button type="button" id="closeSessionBtn" class="warn">Close Session</button>
          </div>
        </section>
      </div>

      <div class="right">
        <section class="panel">
          <h2>Current Status</h2>
          <p>The latest API call result and a short human-readable summary are shown here.</p>
          <div id="statusBox" class="status">Ready to call the API.</div>
        </section>
        <section class="panel">
          <h2>Screenshot Preview</h2>
          <p>When a screenshot artifact is created, it is shown below using the API download path.</p>
          <div id="preview" class="preview">No screenshot yet.</div>
        </section>
        <section class="panel">
          <h2>JSON Result</h2>
          <p>All responses are rendered as pretty JSON so the page is useful for debugging in air-gapped environments.</p>
          <pre id="resultBox">{}</pre>
        </section>
      </div>
    </section>
  </main>

  <script>
    const CONFIG = ${JSON.stringify(clientConfig)};
    const state = { sessionId: '', contextId: '', pageId: '' };
    const resultBox = document.getElementById('resultBox');
    const preview = document.getElementById('preview');
    const statusBox = document.getElementById('statusBox');
    const scriptKeySelect = document.getElementById('scriptKey');
    const sessionIdInput = document.getElementById('sessionId');
    const contextIdInput = document.getElementById('contextId');
    const pageIdInput = document.getElementById('pageId');

    function setStatus(message, isError) {
      statusBox.textContent = message;
      statusBox.className = isError ? 'status error' : 'status';
    }

    function setResult(payload) {
      resultBox.textContent = JSON.stringify(payload, null, 2);
    }

    function syncInputs() {
      sessionIdInput.value = state.sessionId;
      contextIdInput.value = state.contextId;
      pageIdInput.value = state.pageId;
    }

    function showArtifact(artifact) {
      if (!artifact || !artifact.downloadPath) {
        preview.textContent = 'No screenshot yet.';
        return;
      }
      preview.innerHTML = '<img alt="Screenshot artifact preview">';
      preview.querySelector('img').src = artifact.downloadPath;
    }

    async function api(method, path, body) {
      const response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await response.json() : await response.text();
      setResult(payload);
      if (!response.ok) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : 'Request failed';
        setStatus(method + ' ' + path + ' failed: ' + message, true);
        throw new Error(message);
      }
      setStatus(method + ' ' + path + ' completed.', false);
      return payload;
    }

    async function refreshScripts() {
      const payload = await api('GET', CONFIG.apiBasePath + '/scripts');
      const scripts = (payload.data && payload.data.scripts) || [];
      scriptKeySelect.innerHTML = '';
      if (!scripts.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No scripts found';
        scriptKeySelect.append(option);
        return;
      }
      scripts.forEach((script) => {
        const option = document.createElement('option');
        option.value = script.key;
        option.textContent = script.key;
        scriptKeySelect.append(option);
      });
    }

    function requireValue(value, message) {
      if (!value) {
        throw new Error(message);
      }
    }

    document.getElementById('healthBtn').addEventListener('click', async () => { await api('GET', '/health'); });
    document.getElementById('syncScriptsBtn').addEventListener('click', async () => {
      await api('POST', CONFIG.apiBasePath + '/scripts/sync', {});
      await refreshScripts();
    });
    document.getElementById('loadScriptsBtn').addEventListener('click', async () => { await refreshScripts(); });
    document.getElementById('createRunBtn').addEventListener('click', async () => {
      const variablesText = document.getElementById('variablesJson').value.trim();
      const variables = variablesText ? JSON.parse(variablesText) : {};
      const payload = await api('POST', CONFIG.apiBasePath + '/runs', {
        scriptKey: scriptKeySelect.value,
        project: document.getElementById('project').value.trim() || undefined,
        env: document.getElementById('envName').value.trim() || undefined,
        baseURL: document.getElementById('baseUrl').value.trim() || undefined,
        grep: document.getElementById('grep').value.trim() || undefined,
        storageStateRef: document.getElementById('storageStateRef').value.trim() || undefined,
        variables
      });
      if (payload && payload.data && payload.data.runId) {
        setStatus('Run created: ' + payload.data.runId, false);
      }
    });
    document.getElementById('listRunsBtn').addEventListener('click', async () => { await api('GET', CONFIG.apiBasePath + '/runs'); });
    document.getElementById('createSessionBtn').addEventListener('click', async () => {
      const payload = await api('POST', CONFIG.apiBasePath + '/sessions', { browserType: 'chromium', headless: true });
      state.sessionId = payload.data.sessionId;
      state.contextId = '';
      state.pageId = '';
      syncInputs();
    });
    document.getElementById('createContextBtn').addEventListener('click', async () => {
      requireValue(state.sessionId, 'Create a session first.');
      const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/contexts', {
        viewport: { width: 1440, height: 960 }
      });
      state.contextId = payload.data.contextId;
      state.pageId = '';
      syncInputs();
    });
    document.getElementById('createPageBtn').addEventListener('click', async () => {
      requireValue(state.contextId, 'Create a context first.');
      const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/contexts/' + state.contextId + '/pages', {});
      state.pageId = payload.data.pageId;
      syncInputs();
    });
    document.getElementById('gotoDemoBtn').addEventListener('click', async () => {
      requireValue(state.pageId, 'Create a page first.');
      await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/goto', {
        url: window.location.origin + CONFIG.demoPath,
        waitUntil: 'domcontentloaded'
      });
    });
    document.getElementById('clickPrimaryBtn').addEventListener('click', async () => {
      requireValue(state.pageId, 'Create a page first.');
      await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/click', {
        locator: { testId: 'primary-action' }
      });
      await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/assert/text', {
        locator: { testId: 'status' },
        value: 'Primary clicked',
        match: 'contains'
      });
    });
    document.getElementById('sendMessageBtn').addEventListener('click', async () => {
      requireValue(state.pageId, 'Create a page first.');
      await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/fill', {
        locator: { label: 'Message' },
        value: document.getElementById('messageText').value
      });
      await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/click', {
        locator: { role: 'button', name: 'Send message' }
      });
    });
    document.getElementById('takeScreenshotBtn').addEventListener('click', async () => {
      requireValue(state.pageId, 'Create a page first.');
      const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/screenshot', {
        fullPage: true,
        type: 'png'
      });
      showArtifact(payload && payload.data && payload.data.artifact);
    });
    document.getElementById('closeSessionBtn').addEventListener('click', async () => {
      requireValue(state.sessionId, 'Create a session first.');
      await api('DELETE', CONFIG.apiBasePath + '/sessions/' + state.sessionId);
      state.sessionId = '';
      state.contextId = '';
      state.pageId = '';
      syncInputs();
      preview.textContent = 'No screenshot yet.';
    });

    syncInputs();
    refreshScripts().catch((error) => setStatus(error.message, true));
  </script>
</body>
</html>`;
}

function renderDemoTestPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playwright Player Demo Page</title>
  <style>
    :root {
      color-scheme: light;
      --panel: rgba(255,255,255,0.95);
      --ink: #172033;
      --muted: #5f6b82;
      --line: rgba(23,32,51,0.12);
      --teal: #0f766e;
      --sand: #b45309;
      --shadow: 0 20px 48px rgba(23,32,51,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Pretendard Variable", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.17), transparent 30%),
        radial-gradient(circle at bottom right, rgba(180,83,9,0.12), transparent 34%),
        linear-gradient(180deg, #f8f4ed 0%, #eee8df 100%);
      min-height: 100vh;
    }
    main { width: min(1120px, calc(100vw - 24px)); margin: 0 auto; padding: 24px 0 36px; display: grid; gap: 18px; }
    .hero, .panel { border-radius: 26px; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow); }
    .hero { padding: 26px; }
    .hero h1 { margin: 0 0 8px; font-size: clamp(2rem, 4vw, 3.4rem); letter-spacing: -0.05em; }
    .hero p, .muted { margin: 0; line-height: 1.65; color: var(--muted); }
    .layout { display: grid; grid-template-columns: 1.1fr .9fr; gap: 18px; }
    .panel { padding: 20px; }
    h2 { margin: 0 0 12px; font-size: 1.12rem; }
    .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; font-weight: 600; }
    input, select, button { font: inherit; }
    input, select {
      width: 100%;
      padding: 11px 12px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      color: #fff;
      background: var(--teal);
    }
    .ghost { background: #e5e7eb; color: #111827; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .status, .counter, .feed {
      border-radius: 18px;
      border: 1px solid var(--line);
      background: #fff;
      padding: 14px 16px;
    }
    .status strong { display: block; margin-bottom: 6px; }
    ul.feed {
      list-style: none;
      margin: 0;
      display: grid;
      gap: 10px;
      max-height: 320px;
      overflow: auto;
    }
    ul.feed li {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(15,118,110,0.08);
      border: 1px solid rgba(15,118,110,0.12);
    }
    ul.feed li.reply {
      background: rgba(180,83,9,0.08);
      border-color: rgba(180,83,9,0.14);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(23,32,51,0.07);
      color: var(--muted);
      font-size: .9rem;
      margin: 8px 8px 0 0;
    }
    @media (max-width: 920px) {
      .layout, .grid2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Playwright Player Demo Page</h1>
      <p>This local page is designed for stable browser automation in offline environments. It exposes role, label, text, and test id based targets for click, fill, assert, and screenshot flows.</p>
    </section>
    <section class="layout">
      <div class="panel">
        <h2>Interaction Targets</h2>
        <p class="muted">Use the controls below with the low-level session API.</p>
        <div>
          <span class="chip">data-testid="primary-action"</span>
          <span class="chip">data-testid="status"</span>
          <span class="chip">label="Message"</span>
        </div>

        <div class="status" data-testid="status-panel" style="margin-top: 16px;">
          <strong>Status</strong>
          <div id="statusText" data-testid="status">Ready</div>
        </div>

        <div class="row" style="margin-top: 14px;">
          <button type="button" id="primaryAction" data-testid="primary-action">Primary Action</button>
          <button type="button" id="secondaryAction" class="ghost">Secondary Action</button>
        </div>

        <div class="grid2" style="margin-top: 18px;">
          <label>Name<input id="nameInput" placeholder="Operator name" data-testid="name-input"></label>
          <label>Role
            <select id="roleSelect" data-testid="role-select">
              <option value="observer">observer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>

        <div class="row" style="margin-top: 14px;">
          <button type="button" id="saveProfile">Save Profile</button>
          <div id="profileResult" data-testid="profile-result" class="muted">Profile is not saved yet.</div>
        </div>
      </div>

      <div class="panel">
        <h2>Counter And Chat</h2>
        <div class="counter" data-testid="counter-card">
          <strong>Counter</strong>
          <div id="counterValue" data-testid="counter-value">0</div>
          <div class="row" style="margin-top: 12px;">
            <button type="button" id="incrementCounter">Increment Counter</button>
            <button type="button" id="resetCounter" class="ghost">Reset</button>
          </div>
        </div>

        <div style="margin-top: 18px;">
          <label>Message<input id="messageInput" placeholder="Type a message" aria-label="Message"></label>
          <div class="row" style="margin-top: 12px;">
            <button type="button" id="sendMessage">Send message</button>
            <div id="chatSummary" data-testid="chat-summary" class="muted">No messages sent.</div>
          </div>
          <ul id="messageFeed" class="feed" data-testid="message-feed">
            <li>System: local demo page loaded.</li>
          </ul>
        </div>
      </div>
    </section>
  </main>

  <script>
    const statusText = document.getElementById('statusText');
    const profileResult = document.getElementById('profileResult');
    const counterValue = document.getElementById('counterValue');
    const messageFeed = document.getElementById('messageFeed');
    const chatSummary = document.getElementById('chatSummary');

    function appendMessage(text, className) {
      const item = document.createElement('li');
      if (className) {
        item.className = className;
      }
      item.textContent = text;
      messageFeed.append(item);
      item.scrollIntoView({ block: 'nearest' });
    }

    document.getElementById('primaryAction').addEventListener('click', () => {
      statusText.textContent = 'Primary clicked';
    });
    document.getElementById('secondaryAction').addEventListener('click', () => {
      statusText.textContent = 'Secondary clicked';
    });
    document.getElementById('saveProfile').addEventListener('click', () => {
      const name = document.getElementById('nameInput').value.trim() || 'anonymous';
      const role = document.getElementById('roleSelect').value;
      profileResult.textContent = 'Saved profile for ' + name + ' as ' + role + '.';
      statusText.textContent = 'Profile saved';
    });
    document.getElementById('incrementCounter').addEventListener('click', () => {
      const next = Number(counterValue.textContent || '0') + 1;
      counterValue.textContent = String(next);
      statusText.textContent = 'Counter updated';
    });
    document.getElementById('resetCounter').addEventListener('click', () => {
      counterValue.textContent = '0';
      statusText.textContent = 'Counter reset';
    });
    document.getElementById('sendMessage').addEventListener('click', () => {
      const input = document.getElementById('messageInput');
      const value = input.value.trim();
      if (!value) {
        statusText.textContent = 'Message is empty';
        return;
      }
      appendMessage('You: ' + value, '');
      appendMessage('Bot: Echo -> ' + value, 'reply');
      chatSummary.textContent = 'Last message: ' + value;
      statusText.textContent = 'Message sent';
      input.value = '';
    });
  </script>
</body>
</html>`;
}

const scriptRegistry = new ScriptRegistry(config);
await scriptRegistry.refresh();
const runManager = new RunManager({
  ...config,
  registry: scriptRegistry,
});
const sessionManager = new SessionManager(config);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: config.bodyLimit }));
app.use(documentationPaths.swaggerAssets, express.static(swaggerUiAssetDir));

const mcpSessions = new Map();

app.use((req, res, next) => {
  if (!req.path.startsWith(config.mcpBasePath)) {
    return next();
  }

  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }

  if (!config.allowedOrigins.length) {
    return next(new ApiError(403, "MCP_ORIGIN_DENIED", "Origin header is not allowed for MCP requests"));
  }

  if (!config.allowedOrigins.includes(origin)) {
    return next(new ApiError(403, "MCP_ORIGIN_DENIED", `Origin not allowed: ${origin}`));
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
  res.type("html").send(renderPlaygroundPage());
}));

app.get("/demo/test-page", asyncRoute(async (req, res) => {
  res.type("html").send(renderDemoTestPage());
}));

app.get("/health", asyncRoute(async (req, res) => {
  ok(res, {
    service: config.serviceName,
    version: config.serviceVersion,
    uptimeSec: Math.round(process.uptime()),
    scriptCount: scriptRegistry.list().length,
    runCount: runManager.listRuns().length,
    sessionCount: sessionManager.sessions.size,
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

app.post(`${config.apiBasePath}/scripts/validate`, asyncRoute(async (req, res) => {
  ok(res, await runManager.validateScript(req.body || {}));
}));

app.get(`${config.apiBasePath}/scripts/:scriptKey(*)`, asyncRoute(async (req, res) => {
  ok(res, scriptRegistry.get(req.params.scriptKey));
}));

app.get(`${config.apiBasePath}/runs`, asyncRoute(async (req, res) => {
  ok(res, {
    runs: runManager.listRuns(),
  });
}));

app.post(`${config.apiBasePath}/runs`, asyncRoute(async (req, res) => {
  ok(res, await runManager.createRun(req.body || {}), 201);
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
  ok(res, runManager.getLogs(req.params.runId));
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

app.get(`${config.apiBasePath}/sessions/:sessionId/artifacts`, asyncRoute(async (req, res) => {
  ok(res, {
    sessionId: req.params.sessionId,
    artifacts: await sessionManager.listArtifacts(req.params.sessionId),
  });
}));

app.get(`${config.apiBasePath}/sessions/:sessionId/artifacts/:artifactId`, asyncRoute(async (req, res) => {
  const artifact = sessionManager.getArtifact(req.params.sessionId, req.params.artifactId);
  res.download(artifact.absolutePath, artifact.fileName);
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
  ok(res, await sessionManager.getCookies(req.params.sessionId, req.params.contextId, req.body || {}));
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

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/wait-for`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.waitFor(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/screenshot`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.screenshot(req.params.sessionId, req.params.pageId, req.body || {}));
}));

app.post(`${config.apiBasePath}/sessions/:sessionId/pages/:pageId/pdf`, asyncRoute(async (req, res) => {
  ok(res, await sessionManager.pdf(req.params.sessionId, req.params.pageId, req.body || {}));
}));

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
  defineTool("script_validate", "Validate a script before registration or execution.", { type: "object", properties: { scriptKey: { type: "string" }, scriptPath: { type: "string" }, filename: { type: "string" }, content: { type: "string" }, project: { type: "string" }, grep: { type: "string" } } }, async (args) => runManager.validateScript(args)),
  defineTool("run_create", "Create a Playwright test run.", { type: "object", properties: { scriptKey: { type: "string" }, project: { type: "string" }, env: { type: "string" }, baseURL: { type: "string" }, grep: { type: "string" }, headed: { type: "boolean" }, trace: { type: "string" }, video: { type: "string" }, storageStateRef: { type: "string" }, shard: { type: "string" }, variables: { type: "object" } }, required: ["scriptKey"] }, async (args) => runManager.createRun(args)),
  defineTool("run_get", "Get one Playwright run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.serializeRun(runManager.getRun(args.runId))),
  defineTool("run_cancel", "Cancel a running Playwright run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.cancelRun(args.runId)),
  defineTool("run_artifacts", "List files produced by a run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => ({ runId: args.runId, artifacts: await runManager.listArtifacts(args.runId) })),
  defineTool("run_report", "Get the JSON summary report for a run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.getReport(args.runId)),
  defineTool("run_logs", "Get captured stdout and stderr for a run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }, async (args) => runManager.getLogs(args.runId)),
  defineTool("session_create", "Create a low-level browser session for debugging.", { type: "object", properties: { browserType: { type: "string" }, headless: { type: "boolean" }, ttlMs: { type: "number" } } }, async (args) => sessionManager.createSession(args)),
  defineTool("session_get", "Get one browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.serializeSession(sessionManager.getSession(args.sessionId))),
  defineTool("session_delete", "Close a browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.closeSession(args.sessionId, "closed")),
  defineTool("session_keepalive", "Extend a browser session TTL.", { type: "object", properties: { sessionId: { type: "string" }, ttlMs: { type: "number" } }, required: ["sessionId"] }, async (args) => sessionManager.keepAlive(args.sessionId, args.ttlMs)),
  defineTool("session_artifacts", "List artifacts captured in a browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => ({ sessionId: args.sessionId, artifacts: await sessionManager.listArtifacts(args.sessionId) })),
  defineTool("session_actions", "List action and event logs for a browser session.", { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] }, async (args) => sessionManager.listActions(args.sessionId)),
  defineTool("session_trace", "Start or stop Playwright tracing for a context.", { type: "object", properties: { sessionId: { type: "string" }, action: { type: "string" }, contextId: { type: "string" }, title: { type: "string" } }, required: ["sessionId", "action", "contextId"] }, async (args) => args.action === "start" ? sessionManager.startTrace(args.sessionId, args) : sessionManager.stopTrace(args.sessionId, args)),
  defineTool("session_execute", "Execute a batch of page actions inside a session.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" }, steps: { type: "array" } }, required: ["sessionId", "pageId", "steps"] }, async (args) => sessionManager.execute(args.sessionId, args)),
  defineTool("context_create", "Create a browser context within a session.", { type: "object", properties: { sessionId: { type: "string" }, baseURL: { type: "string" }, viewport: { type: "object" }, locale: { type: "string" }, storageState: { type: "object" } }, required: ["sessionId"] }, async (args) => sessionManager.createContext(args.sessionId, args)),
  defineTool("context_get", "Get one browser context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.getContext(args.sessionId, args.contextId)),
  defineTool("context_delete", "Close one browser context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.closeContext(args.sessionId, args.contextId)),
  defineTool("context_storage_export", "Export storage state from a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.exportStorageState(args.sessionId, args.contextId)),
  defineTool("context_storage_import", "Import storage state into a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, storageState: { type: "object" }, storageStateRef: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.importStorageState(args.sessionId, args.contextId, args)),
  defineTool("context_route_add", "Register a network route handler.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, url: { type: "string" }, behavior: { type: "object" } }, required: ["sessionId", "contextId", "url"] }, async (args) => sessionManager.addRoute(args.sessionId, args.contextId, args)),
  defineTool("context_route_remove", "Remove a route handler.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, routeId: { type: "string" } }, required: ["sessionId", "contextId", "routeId"] }, async (args) => sessionManager.removeRoute(args.sessionId, args.contextId, args.routeId)),
  defineTool("context_cookies", "Get or set cookies in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, mode: { type: "string" }, cookies: { type: "array" }, urls: { type: "array" } }, required: ["sessionId", "contextId", "mode"] }, async (args) => args.mode === "set" ? sessionManager.setCookies(args.sessionId, args.contextId, args) : sessionManager.getCookies(args.sessionId, args.contextId, args)),
  defineTool("context_permissions", "Grant permissions in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, permissions: { type: "array" }, origin: { type: "string" } }, required: ["sessionId", "contextId", "permissions"] }, async (args) => sessionManager.grantPermissions(args.sessionId, args.contextId, args)),
  defineTool("context_headers", "Set default extra HTTP headers for a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" }, headers: { type: "object" } }, required: ["sessionId", "contextId", "headers"] }, async (args) => sessionManager.setHeaders(args.sessionId, args.contextId, args)),
  defineTool("page_create", "Create a new page in a context.", { type: "object", properties: { sessionId: { type: "string" }, contextId: { type: "string" } }, required: ["sessionId", "contextId"] }, async (args) => sessionManager.createPage(args.sessionId, args.contextId)),
  defineTool("page_get", "Get one page.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.getPage(args.sessionId, args.pageId)),
  defineTool("page_delete", "Close one page.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.closePage(args.sessionId, args.pageId)),
  defineTool("page_navigate", "Navigate or move the current page history.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" }, action: { type: "string" }, url: { type: "string" } }, required: ["sessionId", "pageId", "action"] }, async (args) => sessionManager.navigate(args.sessionId, args.pageId, args.action, args)),
  defineTool("page_action", "Run a low-level page action such as click, fill, hover, drag, evaluate, or locator query.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" }, action: { type: "string" } }, required: ["sessionId", "pageId", "action"] }, async (args) => sessionManager.pageAction(args.sessionId, args.pageId, args.action, args)),
  defineTool("page_assert", "Run a low-level page assertion.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" }, action: { type: "string" } }, required: ["sessionId", "pageId", "action"] }, async (args) => sessionManager.pageAssert(args.sessionId, args.pageId, args.action, args)),
  defineTool("page_wait_for", "Wait for a page condition.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.waitFor(args.sessionId, args.pageId, args)),
  defineTool("page_screenshot", "Capture a screenshot artifact.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.screenshot(args.sessionId, args.pageId, args)),
  defineTool("page_pdf", "Create a PDF artifact for a chromium page.", { type: "object", properties: { sessionId: { type: "string" }, pageId: { type: "string" } }, required: ["sessionId", "pageId"] }, async (args) => sessionManager.pdf(args.sessionId, args.pageId, args)),
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
      return jsonRpcError(message.id ?? null, -32601, `Method not found: ${message.method}`);
  }
}

app.get(config.mcpBasePath, asyncRoute(async (req, res) => {
  res.status(405).json({
    error: "SSE stream is not enabled on this MCP endpoint.",
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

app.use((error, req, res, next) => {
  const apiError = toApiError(error);
  res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
    },
    artifacts: apiError.artifacts,
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`${config.serviceName} listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close();
  await sessionManager.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("graceful shutdown failed", error);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("graceful shutdown failed", error);
    process.exit(1);
  });
});
