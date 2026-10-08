// Browser lifecycle regressions use only a private local fixture and temporary data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pw-player-resilience-"));
const token = "mcp-resilience-test";
const hits = new Map();
let child;
let base;
let log = "";
let seq = 0;
const fixture = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) || 0) + 1);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>${req.url}</title><h1>Page ${req.url}</h1>
    <a id="popup" target="_blank" href="/popup">Open popup</a>
    <button id="close" onclick="window.close()">Close popup</button>
    <form target="_blank" action="/submitted"><input id="submitname" name="name"></form>
    <input id="upload" type="file">
    <button id="dialog" onclick="prompt('Pending dialog')">Open dialog</button>`);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

async function request(method, pathname, body, mcpSession) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  return { response, data };
}

async function initialize() {
  const result = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method: "initialize", params: {} });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.response.headers.get("mcp-session-id");
}

async function call(session, name, args = {}, { error = false } = {}) {
  const result = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }, session);
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.ok(!result.data.error, JSON.stringify(result.data.error));
  assert.equal(Boolean(result.data.result.isError), error, JSON.stringify(result.data.result));
  return result.data.result.structuredContent;
}

async function check(name, fn) {
  await fn();
  console.log(`PASS  ${name}`);
}

async function sessions() {
  const result = await request("GET", "/api/sessions");
  assert.equal(result.response.status, 200);
  return result.data.data.sessions;
}

try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", API_TOKEN: token,
      SCRIPTS_DIR: path.join(scratch, "scripts"), RUNS_DIR: path.join(scratch, "runs"),
      ARTIFACTS_DIR: path.join(scratch, "artifacts"), STORAGE_STATE_DIR: path.join(scratch, "storage"),
      ENVIRONMENTS_DIR: path.join(scratch, "environments"), DATASETS_DIR: path.join(scratch, "datasets"),
      SCHEDULES_DIR: path.join(scratch, "schedules"), SECRETS_DIR: path.join(scratch, "secrets"), PRINCIPALS_FILE: "",
      URL_ALLOWLIST: "127.0.0.1", ENABLE_EVALUATE: "true", SCHEDULE_TICK_MS: "0", SESSION_CLEANUP_INTERVAL_MS: "100",
      SESSION_TTL_MS: "60000", MCP_SESSION_TTL_MS: "60000", CAPTURE_FAILURE_ARTIFACTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  }, `Server did not start: ${log}`, 60_000);

  const mcp = await initialize();
  const started = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: "browser_navigate", arguments: { url: `${fixtureUrl}/first` } } }, mcp);
  if (started.data.result?.isError && /Executable doesn't exist|playwright install|Failed to launch.*ENOENT/i.test(JSON.stringify(started.data))) {
    assert.notEqual(process.env.SMOKE_REQUIRE_BROWSER, "1", JSON.stringify(started.data));
    console.log("SKIP  MCP resilience checks: install the pinned Playwright browser before running");
  } else {
    assert.equal(started.response.status, 200);
    assert.ok(!started.data.result?.isError, JSON.stringify(started.data));

    await check("popup click returns the selected popup snapshot and its refs", async () => {
      await call(mcp, "browser_tabs", { action: "new", url: `${fixtureUrl}/second` });
      const result = await call(mcp, "browser_click", { target: "#popup" });
      assert.equal(result.url, `${fixtureUrl}/popup`);
      assert.match(result.snapshot, /Page \/popup/);
      const tabs = await call(mcp, "browser_tabs", { action: "list" });
      assert.equal(tabs.tabs.length, 3);
      assert.equal(tabs.tabs.filter((tab) => tab.current).length, 1);
      assert.equal(tabs.tabs.find((tab) => tab.current).pageId, result.pageId);
      const ref = /button "Close popup" \[ref=([^\]]+)\]/.exec(result.snapshot)?.[1];
      assert.ok(ref, result.snapshot);
      const closed = await call(mcp, "browser_click", { ref });
      assert.equal(closed.url, `${fixtureUrl}/second`);
      assert.match(closed.snapshot, /Page \/second/);
    });

    await check("closing a selected tab returns to the previous live selection", async () => {
      await call(mcp, "browser_tabs", { action: "new", url: `${fixtureUrl}/third` });
      const closed = await call(mcp, "browser_tabs", { action: "close" });
      assert.equal(closed.url, `${fixtureUrl}/second`);
      assert.equal(closed.tabs.find((tab) => tab.current).url, closed.url);
      await call(mcp, "browser_tabs", { action: "select", index: 0 });
      const removed = await call(mcp, "browser_tabs", { action: "close", index: 1 });
      assert.equal(removed.url, `${fixtureUrl}/first`);
      assert.equal(removed.tabs.length, 1);
    });

    await check("script popups and form submission snapshots follow the resulting tab", async () => {
      const opened = await call(mcp, "browser_evaluate", { function: "() => { window.open('/script-popup'); return 'opened'; }" });
      assert.equal(opened.result, "opened");
      assert.equal(opened.url, `${fixtureUrl}/script-popup`);
      assert.match(opened.snapshot, /Page \/script-popup/);
      await call(mcp, "browser_tabs", { action: "close" });
      const submitted = await call(mcp, "browser_type", { target: "#submitname", text: "once", submit: true });
      assert.equal(submitted.url, `${fixtureUrl}/submitted?name=once`);
      assert.equal(hits.get("/submitted?name=once"), 1);
      const restored = await call(mcp, "browser_tabs", { action: "close" });
      assert.equal(restored.url, `${fixtureUrl}/first`);
    });

    await check("REST navigation clears a pending chooser from the prior document", async () => {
      const chooser = await call(mcp, "browser_click", { target: "#upload" });
      assert.equal(chooser.fileChooser.nextTool, "browser_file_upload");
      const moved = await request("POST", `/api/sessions/${chooser.sessionId}/pages/${chooser.pageId}/goto`, { url: `${fixtureUrl}/navigated`, waitUntil: "domcontentloaded" });
      assert.equal(moved.response.status, 200, JSON.stringify(moved.data));
      const snapshot = await call(mcp, "browser_snapshot");
      assert.match(snapshot.snapshot, /Page \/navigated/);
      assert.ok(!snapshot.fileChooser);
    });

    await check("closing a page with a dialog leaves no orphan modal on the surviving tab", async () => {
      await call(mcp, "browser_tabs", { action: "new", url: `${fixtureUrl}/modal` });
      const dialog = await call(mcp, "browser_click", { target: "#dialog" });
      assert.equal(dialog.dialog.type, "prompt");
      const closed = await request("DELETE", `/api/sessions/${dialog.sessionId}/pages/${dialog.pageId}`);
      assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
      const snapshot = await call(mcp, "browser_snapshot");
      assert.equal(snapshot.url, `${fixtureUrl}/navigated`);
      assert.ok(!snapshot.dialog);
      assert.match(snapshot.snapshot, /Page \/navigated/);
    });

    await check("REST deletion of the owned context creates a usable replacement", async () => {
      const current = await call(mcp, "browser_tabs", { action: "list" });
      const browser = (await sessions()).find((entry) => entry.sessionId === current.sessionId);
      const contextId = browser.contextIds[0];
      const closed = await request("DELETE", `/api/sessions/${browser.sessionId}/contexts/${contextId}`);
      assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
      const recovered = await call(mcp, "browser_navigate", { url: `${fixtureUrl}/new-context` });
      assert.equal(recovered.sessionId, browser.sessionId);
      assert.match(recovered.snapshot, /Page \/new-context/);
    });

    await check("REST browser deletion recovers on the next explicit command", async () => {
      const current = await call(mcp, "browser_snapshot");
      const closed = await request("DELETE", `/api/sessions/${current.sessionId}`);
      assert.equal(closed.response.status, 200);
      const recovered = await call(mcp, "browser_navigate", { url: `${fixtureUrl}/new-browser` });
      assert.notEqual(recovered.sessionId, current.sessionId);
      assert.match(recovered.snapshot, /Page \/new-browser/);
    });

    await check("browser TTL expiration preserves the MCP connection for a fresh command", async () => {
      const current = await call(mcp, "browser_snapshot");
      const ttl = await request("POST", `/api/sessions/${current.sessionId}/keepalive`, { ttlMs: 100 });
      assert.equal(ttl.response.status, 200);
      await until(async () => !(await sessions()).some((entry) => entry.sessionId === current.sessionId), "Browser did not expire");
      const recovered = await call(mcp, "browser_navigate", { url: `${fixtureUrl}/after-expiry` });
      assert.notEqual(recovered.sessionId, current.sessionId);
      assert.match(recovered.snapshot, /Page \/after-expiry/);
    });

    if (process.platform === "linux") await check("a disconnected browser recovers without replaying an interrupted side effect", async () => {
      const current = await call(mcp, "browser_snapshot");
      const pending = call(mcp, "browser_evaluate", { function: "async () => { await fetch('/committed-once'); return new Promise(() => {}); }" }, { error: true });
      await until(() => hits.has("/committed-once"), "Evaluation did not reach the fixture");
      // Only kill a Chromium child belonging to this suite's isolated server.
      const children = (await fs.readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
      const browsers = [];
      for (const pid of children) {
        const command = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        if (command.includes("--remote-debugging-pipe") && !command.includes("--type=")) browsers.push(Number(pid));
      }
      assert.equal(browsers.length, 1, `Expected one owned Chromium browser: ${browsers}`);
      process.kill(browsers[0], "SIGKILL");
      await pending;
      await until(async () => (await sessions()).some((entry) => entry.sessionId === current.sessionId && entry.status === "disconnected"), "Browser disconnect was not recorded");
      const recovered = await call(mcp, "browser_navigate", { url: `${fixtureUrl}/after-crash` });
      assert.notEqual(recovered.sessionId, current.sessionId);
      assert.equal(hits.get("/committed-once"), 1, "The interrupted action was replayed");
      assert.ok(!(await sessions()).some((entry) => entry.sessionId === current.sessionId));
    });

    await check("DELETE interrupts unresolved evaluation and rejects queued calls promptly", async () => {
      const current = await call(mcp, "browser_snapshot");
      const pending = call(mcp, "browser_evaluate", { function: "async () => { await fetch('/delete-barrier'); return new Promise(() => {}); }" }, { error: true });
      await until(() => hits.has("/delete-barrier"), "Evaluation did not start");
      const queued = call(mcp, "browser_navigate", { url: `${fixtureUrl}/must-not-run` }, { error: true });
      await delay(100);
      const before = Date.now();
      const deleted = await request("DELETE", "/mcp", undefined, mcp);
      assert.equal(deleted.response.status, 204, JSON.stringify(deleted.data));
      assert.ok(Date.now() - before < 3000, "DELETE waited for the unresolved evaluation");
      const [interrupted, cancelled] = await Promise.all([pending, queued]);
      assert.equal(interrupted.error.code, "MCP_SESSION_NOT_FOUND");
      assert.equal(cancelled.error.code, "MCP_SESSION_NOT_FOUND");
      assert.equal(hits.get("/must-not-run") || 0, 0);
      assert.ok(!(await sessions()).some((entry) => entry.sessionId === current.sessionId));
      const reused = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }, mcp);
      assert.equal(reused.response.status, 404);
    });
  }
} finally {
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
