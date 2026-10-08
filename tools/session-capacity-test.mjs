// Exercise the real HTTP server with deterministic browser lifecycle faults.
// The launcher is replaced only in this child process by Node's --import;
// production has no test hooks and this suite needs no browser downloads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pw-player-capacity-"));
const artifactsDir = path.join(scratch, "artifacts");
const token = "session-capacity-test";
let child;
let base;
let log = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const launchCount = () => (log.match(/\[fixture\] launch /g) || []).length;
const closeCount = () => (log.match(/\[fixture\] close /g) || []).length;

async function until(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`${message}\n${log}`);
    await delay(20);
  }
}

async function request(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

const create = (options = {}) => request("POST", "/api/sessions", options);
const close = (sessionId) => request("DELETE", `/api/sessions/${sessionId}`);
const health = async () => (await request("GET", "/health")).body.data;

async function check(name, fn) {
  await fn();
  console.log(`PASS  ${name}`);
}

async function expectIdle() {
  const state = await health();
  assert.equal(state.sessionCount, 0);
  assert.equal(state.pendingSessionCount, 0);
  assert.equal(state.closingSessionCount, 0);
}

try {
  const preload = path.join(scratch, "launcher.mjs");
  await fs.writeFile(preload, `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import fs from "node:fs";
    import path from "node:path";
    const require = createRequire(${JSON.stringify(pathToFileURL(path.join(root, "package.json")).href)});
    const { chromium } = require("playwright");
    const scratch = ${JSON.stringify(scratch)};
    async function barrier(name) {
      while (!fs.existsSync(path.join(scratch, name))) await new Promise(r => setTimeout(r, 10));
    }
    chromium.launch = async options => {
      console.log("[fixture] launch " + JSON.stringify(options));
      if (options.channel === "missing-browser") throw new Error("Executable doesn't exist at /offline-cache/chromium");
      if (options.channel === "timeout-browser") {
        const error = new Error("Browser launch timed out");
        error.name = "TimeoutError";
        throw error;
      }
      if (options.channel === "hold-launch") await barrier("release-launch");
      if (options.channel === "shutdown-launch") await barrier("release-shutdown");
      const browser = new EventEmitter();
      let connected = true;
      browser.isConnected = () => connected;
      browser.close = async () => {
        console.log("[fixture] close " + options.channel);
        if (options.channel === "hold-close") await barrier("release-close");
        connected = false;
        browser.emit("disconnected");
      };
      if (options.channel === "fail-after-launch") browser.on = () => { throw new Error("Injected post-launch setup failure"); };
      return browser;
    };
  `);
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1", PORT: String(port), API_TOKEN: token,
      SCRIPTS_DIR: path.join(scratch, "scripts"), RUNS_DIR: path.join(scratch, "runs"),
      ARTIFACTS_DIR: artifactsDir, STORAGE_STATE_DIR: path.join(scratch, "storage"),
      ENVIRONMENTS_DIR: path.join(scratch, "environments"), DATASETS_DIR: path.join(scratch, "datasets"),
      SCHEDULES_DIR: path.join(scratch, "schedules"), SECRETS_DIR: path.join(scratch, "secrets"),
      PRINCIPALS_FILE: "", SCHEDULE_TICK_MS: "0", SESSION_CLEANUP_INTERVAL_MS: "60000",
      DEFAULT_BROWSER_TYPE: "chromium", MAX_SESSIONS: "1", BROWSER_LAUNCH_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  }, "Server did not start", 60_000);

  await check("pending launches reserve capacity before concurrent HTTP requests", async () => {
    const launching = create({ channel: "hold-launch" });
    await until(async () => (await health()).pendingSessionCount === 1, "Launch never reserved capacity");
    const results = await Promise.all(Array.from({ length: 12 }, () => create()));
    for (const result of results) {
      assert.equal(result.status, 429, JSON.stringify(result.body));
      assert.equal(result.body.error.code, "SESSION_LIMIT_EXCEEDED");
    }
    assert.equal(launchCount(), 1, "Capacity rejection still started extra browsers");
    await fs.writeFile(path.join(scratch, "release-launch"), "");
    const created = await launching;
    assert.equal(created.status, 201);
    assert.equal((await health()).pendingSessionCount, 0);
    assert.equal((await close(created.body.data.sessionId)).status, 200);
    await expectIdle();
  });

  await check("closing browsers retain capacity and concurrent closes share teardown", async () => {
    const created = await create({ channel: "hold-close" });
    const first = close(created.body.data.sessionId);
    await until(async () => (await health()).closingSessionCount === 1, "Close never reserved capacity");
    const second = close(created.body.data.sessionId);
    assert.equal((await create()).status, 429);
    await fs.writeFile(path.join(scratch, "release-close"), "");
    const results = await Promise.all([first, second]);
    assert.equal(results[0].status, 200);
    assert.deepEqual(results[0], results[1]);
    assert.equal((log.match(/\[fixture\] close hold-close/g) || []).length, 1);
    await expectIdle();
    const next = await create();
    assert.equal(next.status, 201, "Capacity was not released after browser close");
    await close(next.body.data.sessionId);
  });

  await check("missing browser and startup timeout errors are actionable and release reservations", async () => {
    const missing = await create({ channel: "missing-browser" });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error.code, "BROWSER_NOT_INSTALLED");
    assert.match(missing.body.error.message, /playwright install.*offline/);
    assert.match(missing.body.error.details.remediation, /PLAYWRIGHT_BROWSERS_PATH/);
    await expectIdle();
    const timeout = await create({ channel: "timeout-browser", timeoutMs: 45 });
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.error.code, "BROWSER_LAUNCH_TIMEOUT");
    assert.match(timeout.body.error.message, /45 ms/);
    await expectIdle();
  });

  await check("failed post-launch setup closes its browser and removes incomplete artifacts", async () => {
    const before = closeCount();
    const previousArtifacts = (await fs.readdir(artifactsDir)).sort();
    const failed = await create({ channel: "fail-after-launch" });
    assert.equal(failed.status, 500);
    assert.equal(closeCount(), before + 1, "Failed startup leaked its browser");
    assert.equal((await request("GET", "/api/sessions")).body.data.sessions.length, 0);
    assert.deepEqual((await fs.readdir(artifactsDir)).sort(), previousArtifacts);
    await expectIdle();
  });

  await check("artifact directory failures start no browser and do not consume capacity", async () => {
    const backup = `${artifactsDir}-saved`;
    const before = launchCount();
    await fs.rename(artifactsDir, backup);
    await fs.writeFile(artifactsDir, "not a directory");
    try {
      assert.equal((await create()).status, 500);
      assert.equal(launchCount(), before);
      await expectIdle();
    } finally {
      await fs.unlink(artifactsDir);
      await fs.rename(backup, artifactsDir);
    }
    const created = await create();
    assert.equal(created.status, 201);
    await close(created.body.data.sessionId);
  });

  await check("launch time budgets are validated and cannot exceed the operator limit", async () => {
    const before = launchCount();
    for (const timeoutMs of [0, -1, "1000"]) {
      const invalid = await create({ timeoutMs });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_BROWSER_TIMEOUT");
    }
    assert.equal((await create({ browserType: "toString" })).status, 400);
    assert.equal(launchCount(), before);
    const created = await create({ timeoutMs: 999999 });
    assert.equal(created.status, 201);
    const launches = [...log.matchAll(/\[fixture\] launch (.+)/g)];
    assert.equal(JSON.parse(launches.at(-1)[1]).timeout, 10000);
    assert.equal((await health()).limits.browserLaunchTimeoutMs, 10000);
    await close(created.body.data.sessionId);
  });

  await check("shutdown waits for an in-flight launch and closes the late browser", async () => {
    const before = closeCount();
    const launching = create({ channel: "shutdown-launch" });
    await until(async () => (await health()).pendingSessionCount === 1, "Launch never reserved capacity");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    // The HTTP drain lasts at most five seconds. Keep startup in flight past it
    // to exercise SessionManager.shutdown, rather than ordinary HTTP draining.
    await delay(5300);
    assert.equal(child.exitCode, null, "Shutdown exited before the pending browser could be cleaned up");
    await fs.writeFile(path.join(scratch, "release-shutdown"), "");
    const result = await launching;
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "SERVER_SHUTTING_DOWN");
    const [code] = await exited;
    assert.equal(code, 0, log);
    assert.equal(closeCount(), before + 1);
  });
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
