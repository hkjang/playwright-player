// Offline readiness must test real rendering, clean up on failure, and leave
// user sessions/artifacts alone. No external service or download is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineDiagnostics } from "../offline-diagnostics.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pw-player-diagnostics-"));
let passed = 0;
class ApiError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

async function fixture(options = {}) {
  const artifactsDir = await fs.mkdtemp(path.join(scratch, "unit-"));
  const config = {
    artifactsDir, defaultBrowserType: "chromium", defaultHeadless: true,
    screenshotWaitForFonts: false, screenshotTimeoutMs: 1000, urlAllowlist: [],
    serviceVersion: "test", ...options.config,
  };
  let launches = 0;
  let closes = 0;
  const sessions = new Map();
  const artifactIndex = new Map([["user-artifact", { sessionId: "user-session" }]]);
  const png = Buffer.alloc(40);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(360, 20);
  const page = {
    async setContent(html, { timeout }) {
      assert.ok(!/<(?:script|link)[\s>]/i.test(html));
      assert.ok(html.includes("default-src 'none'"));
      assert.ok(timeout > 0);
      if (options.renderError) throw options.renderError;
    },
    async evaluate(fn, image) { return image ? options.pixelsMatch !== false : true; },
    async screenshot({ timeout }) {
      assert.ok(timeout > 0 && timeout <= config.screenshotTimeoutMs);
      if (options.screenshotError) throw options.screenshotError;
      return png;
    },
  };
  const manager = {
    sessions, artifactIndex,
    async createSession(request) {
      launches += 1;
      assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 15_000);
      if (options.launchDelay) await sleep(options.launchDelay);
      if (options.launchError) throw options.launchError;
      const session = { sessionId: "diagnostic-owned", browserType: "chromium" };
      await fs.mkdir(path.join(artifactsDir, session.sessionId));
      sessions.set(session.sessionId, session);
      return session;
    },
    async createContext(id, request) {
      assert.ok(sessions.has(id));
      assert.equal(request.offline, true);
      assert.equal(request.serviceWorkers, "block");
      assert.equal(request.acceptDownloads, false);
      return { contextId: "context" };
    },
    getSession(id) { return sessions.get(id); },
    getContextRecord() {
      return { context: { async route(pattern, handler) {
        assert.equal(pattern, "**/*");
        let aborted = false;
        await handler({ abort: async () => { aborted = true; } });
        assert.equal(aborted, true);
      } } };
    },
    async createPage() { return { pageId: "page" }; },
    getPageRecord() { return { page }; },
    async closeSession(id) { assert.ok(sessions.has(id)); closes += 1; sessions.delete(id); },
  };
  return {
    diagnostics: createOfflineDiagnostics({ sessionManager: manager, config, ApiError, timeoutMs: options.timeoutMs }),
    manager, artifactsDir, get launches() { return launches; }, get closes() { return closes; },
  };
}

let child;
let base;
let log = "";
const token = "offline-diagnostics-test-token";
const serverArtifacts = path.join(scratch, "server-artifacts");

async function request(method, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json();
  return { response, data };
}

async function doctor(apiToken = token) {
  const command = spawn(process.execPath, [path.join(root, "tools/doctor.mjs"), "--url", base, "--json"], {
    cwd: root, env: { ...process.env, API_TOKEN: apiToken, API_BASE_PATH: "/api" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  command.stdout.on("data", (chunk) => { stdout += chunk; });
  command.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(command, "exit");
  assert.equal(stderr, "", stderr);
  return { exitCode, report: JSON.parse(stdout) };
}

try {
  await check("readiness checks coalesce concurrent work and preserve existing artifacts", async () => {
    const f = await fixture({ launchDelay: 20 });
    const first = f.diagnostics.run();
    const second = f.diagnostics.run();
    assert.equal(first, second);
    const report = await first;
    assert.equal(report.status, "ok", JSON.stringify(report));
    assert.equal(f.launches, 1);
    assert.equal(f.closes, 1);
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.manager.artifactIndex.size, 1);
    assert.ok(f.manager.artifactIndex.has("user-artifact"));
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
    assert.equal((await f.diagnostics.run()).status, "ok");
    assert.equal(f.launches, 2, "later requests should recheck, not reuse stale readiness");
  });

  await check("a browser limit is degraded readiness and does not allocate another session", async () => {
    const f = await fixture({ launchError: new ApiError(429, "SESSION_LIMIT_EXCEEDED", "private detail") });
    const report = await f.diagnostics.run();
    assert.equal(report.status, "degraded");
    assert.equal(report.checks.find((item) => item.id === "browser_launch").errorCode, "SESSION_LIMIT_EXCEEDED");
    assert.equal(report.checks.find((item) => item.id === "screenshot_capture").status, "skipped");
    assert.equal(f.closes, 0);
    assert.ok(!JSON.stringify(report).includes("private detail"));
  });

  await check("missing browsers produce actionable reports without credentials or local paths", async () => {
    const f = await fixture({ launchError: new Error("Executable doesn't exist at /secret/browser proxy=http://user:password@secret") });
    const report = await f.diagnostics.run();
    assert.equal(report.status, "failed");
    assert.equal(report.checks.find((item) => item.id === "browser_launch").errorCode, "BROWSER_NOT_INSTALLED");
    assert.ok(!/secret|password|proxy=/.test(JSON.stringify(report)));
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
  });

  await check("blank screenshots fail readiness and release the owned browser and files", async () => {
    const f = await fixture({ pixelsMatch: false });
    const report = await f.diagnostics.run();
    assert.equal(report.status, "failed");
    assert.equal(report.checks.find((item) => item.id === "screenshot_capture").errorCode, "SCREENSHOT_INVALID");
    assert.equal(report.checks.find((item) => item.id === "artifact_roundtrip").status, "skipped");
    assert.equal(f.closes, 1);
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
  });

  await check("capture failures redact launch details and still clean up", async () => {
    const f = await fixture({ screenshotError: new Error("failure with token=secret-value /private/artifacts") });
    const report = await f.diagnostics.run();
    assert.equal(report.status, "failed");
    assert.ok(!/secret-value|private/.test(JSON.stringify(report)));
    assert.equal(f.closes, 1);
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
  });

  await check("an offline font-wait risk is visible even when rendering passes", async () => {
    const f = await fixture({ config: { screenshotWaitForFonts: true } });
    const report = await f.diagnostics.run();
    assert.equal(report.status, "degraded");
    assert.equal(report.checks.find((item) => item.id === "configuration").errorCode, "SCREENSHOT_FONT_WAIT_ENABLED");
    assert.equal(report.checks.find((item) => item.id === "screenshot_capture").status, "passed");
  });

  await check("a launch completing after the deadline is reclaimed rather than orphaned", async () => {
    const f = await fixture({ launchDelay: 100, timeoutMs: 60 });
    const started = Date.now();
    const report = await f.diagnostics.run();
    assert.equal(report.status, "failed");
    assert.ok(Date.now() - started < 300, "diagnostic response exceeded its bounded budget");
    await sleep(100);
    assert.equal(f.closes, 1);
    assert.equal(f.manager.sessions.size, 0);
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
  });

  await check("wall-clock corrections cannot extend deadlines or make durations negative", async () => {
    const f = await fixture({ launchDelay: 100, timeoutMs: 60 });
    const originalNow = Date.now;
    const before = originalNow();
    let report;
    try {
      const pending = f.diagnostics.run();
      Date.now = () => originalNow() - 3_600_000;
      report = await pending;
    } finally {
      Date.now = originalNow;
    }
    assert.equal(report.status, "failed", "a clock rollback must not give a late launch an extra hour");
    assert.ok(Number.isInteger(report.durationMs) && report.durationMs >= 0 && report.durationMs < 300);
    assert.ok(report.checks.every((item) => Number.isInteger(item.durationMs) && item.durationMs >= 0));
    assert.ok(Date.parse(report.checkedAt) >= before, "checkedAt should preserve the original wall-clock timestamp");
    await sleep(100);
    assert.equal(f.closes, 1);
    assert.equal(f.manager.sessions.size, 0);
    assert.deepEqual(await fs.readdir(f.artifactsDir), []);
  });

  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), API_TOKEN: token,
      SCRIPTS_DIR: path.join(scratch, "scripts"), RUNS_DIR: path.join(scratch, "runs"),
      ARTIFACTS_DIR: serverArtifacts, STORAGE_STATE_DIR: path.join(scratch, "storage"),
      ENVIRONMENTS_DIR: path.join(scratch, "environments"), DATASETS_DIR: path.join(scratch, "datasets"),
      SCHEDULES_DIR: path.join(scratch, "schedules"), SECRETS_DIR: path.join(scratch, "secrets"),
      PRINCIPALS_FILE: "", SCHEDULE_TICK_MS: "0", URL_ALLOWLIST: "no-network.invalid",
      SCREENSHOT_WAIT_FOR_FONTS: "false", ENABLE_EVALUATE: "false", MAX_SESSIONS: "2",
      DEFAULT_BROWSER_TYPE: "chromium", DEFAULT_HEADLESS: "true", PLAYWRIGHT_LAUNCH_ARGS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const startupDeadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > startupDeadline) throw new Error(`Server did not start: ${log}`);
    await sleep(100);
  }

  await check("readiness REST endpoint requires the configured API credentials", async () => {
    const response = await fetch(`${base}/api/diagnostics`, { method: "POST" });
    assert.equal(response.status, 401);
  });

  let browserAvailable;
  await check("REST readiness distinguishes process health from actual browser readiness", async () => {
    const { response, data } = await request("POST", "/api/diagnostics", {});
    assert.equal(response.status, 200, JSON.stringify(data));
    const report = data.data;
    assert.ok(["ok", "degraded", "failed"].includes(report.status));
    assert.equal(report.network, "local-only");
    assert.equal(report.checks.length, 6);
    browserAvailable = report.status === "ok";
    if (!browserAvailable) {
      assert.notEqual(process.env.SMOKE_REQUIRE_BROWSER, "1", JSON.stringify(report));
      assert.equal(report.checks.find((item) => item.id === "browser_launch").errorCode, "BROWSER_NOT_INSTALLED", JSON.stringify(report));
      console.log("SKIP  Real screenshot readiness: the pinned browser is not installed");
    } else {
      assert.ok(report.checks.every((item) => item.status === "passed"), JSON.stringify(report));
      assert.ok(report.checks.find((item) => item.id === "screenshot_capture").details.sizeBytes > 100);
    }
    assert.ok(report.durationMs < 21_000);
    assert.ok(!JSON.stringify(report).includes(scratch));
    assert.deepEqual((await request("GET", "/api/sessions")).data.data.sessions, []);
    assert.deepEqual(await fs.readdir(serverArtifacts), []);
  });

  await check("MCP diagnostics_run exposes the same readiness report and no browser session", async () => {
    const initialized = await request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const headers = { "Mcp-Session-Id": sessionId };
    const listed = await request("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    const tool = listed.data.result.tools.find((entry) => entry.name === "diagnostics_run");
    assert.ok(tool);
    assert.ok(!tool.inputSchema.required?.length);
    const result = await request("POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "diagnostics_run", arguments: {} } }, headers);
    assert.equal(result.response.status, 200);
    const report = result.data.result.structuredContent;
    assert.equal(report.status, browserAvailable ? "ok" : "failed", JSON.stringify(result.data));
    assert.equal(report.checks.find((item) => item.id === "cleanup").status, "passed");
    assert.deepEqual((await request("GET", "/api/sessions")).data.data.sessions, []);
    assert.deepEqual(await fs.readdir(serverArtifacts), []);
    await request("DELETE", "/mcp", undefined, headers).catch(() => undefined); // 204 has no JSON body.
  });

  await check("doctor CLI emits machine-readable readiness with a meaningful exit code", async () => {
    const { exitCode, report } = await doctor();
    assert.equal(exitCode, browserAvailable ? 0 : 1);
    assert.equal(report.status, browserAvailable ? "ok" : "failed");
    assert.equal(report.checks.length, 6);
    assert.ok(!JSON.stringify(report).includes(token));
  });

  await check("doctor CLI distinguishes authentication errors from failed readiness", async () => {
    const { exitCode, report } = await doctor("invalid-token");
    assert.equal(exitCode, 2);
    assert.equal(report.status, "unavailable");
    assert.match(report.error.message, /HTTP 401/);
    assert.ok(!JSON.stringify(report).includes("invalid-token"));
  });

  if (browserAvailable) {
    await check("readiness respects session capacity and leaves active user sessions untouched", async () => {
      const first = (await request("POST", "/api/sessions", {})).data.data.sessionId;
      const second = (await request("POST", "/api/sessions", {})).data.data.sessionId;
      assert.ok(first && second);
      const report = (await request("POST", "/api/diagnostics", {})).data.data;
      assert.equal(report.status, "degraded");
      assert.equal(report.checks.find((item) => item.id === "browser_launch").errorCode, "SESSION_LIMIT_EXCEEDED");
      assert.deepEqual((await request("GET", "/api/sessions")).data.data.sessions.map((item) => item.sessionId).sort(), [first, second].sort());
      const cli = await doctor();
      assert.equal(cli.exitCode, 1);
      assert.equal(cli.report.status, "degraded");
      await request("DELETE", `/api/sessions/${first}`);
      await request("DELETE", `/api/sessions/${second}`);
    });
  }
  console.log(`\n${passed} diagnostics checks passed`);
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
