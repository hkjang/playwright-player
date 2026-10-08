// Local-only regressions: Microsoft tool contracts and stalled intranet assets.
// No npm/browser downloads or external website is needed to run this suite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pw-player-mcp-"));
const token = "offline-mcp-test";
let child;
let base;
let launchEnv;
let log = "";
let seq = 0;
const held = new Set();
const requested = new Set();
const fixture = http.createServer((req, res) => {
  requested.add(req.url);
  if (req.url === "/pending.woff2" || req.url === "/pending.js") {
    held.add(res);
    res.on("close", () => held.delete(res));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/frame") {
    res.end('<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>');
    return;
  }
  res.end(`<!doctype html><title>Offline MCP fixture</title>
    ${req.url === "/fonts" ? '<style>@font-face{font-family:pending;src:url(/pending.woff2)}body{font-family:pending,sans-serif}</style>' : ""}
    <h1>Offline fixture</h1><label>Name<input id="name"></label>
    <label>Enabled<input id="enabled" type="checkbox"></label>
    <label>Choice<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
    <button id="save" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button>
    <p id="result">Ready</p><input id="upload" type="file">
    <button id="prompt" onclick="document.querySelector('#result').textContent=prompt('Your value')">Prompt</button>
    ${req.url === "/frames" ? '<iframe src="/frame"></iframe>' : ""}
    <script>console.log('fixture loaded')</script>
    ${req.url === "/script" ? '<script src="/pending.js"></script>' : ""}`);
});

async function request(method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  return { response, data };
}

async function initialize() {
  const { response, data } = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method: "initialize", params: {} });
  assert.equal(response.status, 200, JSON.stringify(data));
  return response.headers.get("mcp-session-id");
}

async function rpc(session, method, params) {
  const { response, data } = await request("POST", "/mcp", { jsonrpc: "2.0", id: ++seq, method, params }, { "Mcp-Session-Id": session });
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.ok(!data.error, JSON.stringify(data.error));
  return data.result;
}

async function tool(session, name, args = {}, { error = false } = {}) {
  const result = await rpc(session, "tools/call", { name, arguments: args });
  assert.equal(Boolean(result.isError), error, JSON.stringify(result.structuredContent));
  return result;
}

async function check(name, fn) {
  await fn();
  console.log(`PASS  ${name}`);
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`Server did not start: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(force);
}

function imageBytes(result, format = "png") {
  const image = result.content.find((block) => block.type === "image");
  assert.ok(image, "MCP response has no image content");
  assert.equal(image.mimeType, `image/${format}`);
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length > 100);
  if (format === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  else assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
  assert.ok(!JSON.stringify(result.structuredContent).includes(image.data), "base64 was duplicated into text metadata");
  return bytes;
}

try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  // Reserve an ephemeral port, then release it immediately before server start.
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  launchEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", API_TOKEN: token,
      SCRIPTS_DIR: path.join(scratch, "scripts"), RUNS_DIR: path.join(scratch, "runs"),
      ARTIFACTS_DIR: path.join(scratch, "artifacts"), STORAGE_STATE_DIR: path.join(scratch, "storage"),
      ENVIRONMENTS_DIR: path.join(scratch, "environments"), DATASETS_DIR: path.join(scratch, "datasets"),
      SCHEDULES_DIR: path.join(scratch, "schedules"), SECRETS_DIR: path.join(scratch, "secrets"), PRINCIPALS_FILE: "",
      URL_ALLOWLIST: "127.0.0.1", ENABLE_EVALUATE: "true", SCHEDULE_TICK_MS: "0",
      SCREENSHOT_WAIT_FOR_FONTS: "false", CAPTURE_FAILURE_ARTIFACTS: "true",
    };
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: launchEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  await waitForServer();

  const first = await initialize();
  await check("official browser tool names coexist with legacy tools", async () => {
    const { tools } = await rpc(first, "tools/list");
    const names = tools.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type",
      "browser_hover", "browser_drag", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_wait_for",
      "browser_tabs", "browser_close", "browser_resize", "browser_evaluate", "browser_take_screenshot",
      "browser_console_messages", "browser_network_requests", "browser_handle_dialog", "browser_file_upload", "page_screenshot", "page_inspect"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    assert.ok(!tools.find((entry) => entry.name === "browser_navigate").inputSchema.required?.includes("sessionId"));
  });

  const nav = await rpc(first, "tools/call", { name: "browser_navigate", arguments: { url: fixtureUrl } });
  if (nav.isError && /Executable doesn't exist|playwright install|Failed to launch.*ENOENT/i.test(JSON.stringify(nav))) {
    assert.notEqual(process.env.SMOKE_REQUIRE_BROWSER, "1", JSON.stringify(nav.structuredContent));
    console.log("SKIP  MCP browser checks: install the pinned Playwright browser before running");
  } else {
    assert.ok(!nav.isError, JSON.stringify(nav.structuredContent));
    await check("snapshot refs drive old ref and current target calls", async () => {
      const snapshot = await tool(first, "browser_snapshot");
      const snapshotText = snapshot.structuredContent.snapshot;
      const ref = /textbox[^\n]*?\[ref=([^\]]+)\]/.exec(snapshotText)?.[1];
      assert.ok(ref, `no textbox ref in ${snapshotText}`);
      await tool(first, "browser_type", { element: "Name", ref, text: "offline" });
      await tool(first, "browser_click", { target: "#save" });
      await tool(first, "browser_wait_for", { text: "Saved offline" });
      const evaluated = await tool(first, "browser_evaluate", { function: "() => document.querySelector('#name').value" });
      assert.ok(JSON.stringify(evaluated.structuredContent).includes("offline"));
    });

    await check("PNG/JPEG and element screenshots return renderable MCP images", async () => {
      await tool(first, "browser_resize", { width: 640, height: 480 });
      const shot = await tool(first, "browser_take_screenshot", { filename: "offline.png" });
      const bytes = imageBytes(shot);
      assert.equal(bytes.readUInt32BE(16), 640);
      assert.equal(bytes.readUInt32BE(20), 480);
      const artifact = shot.structuredContent.artifact;
      const downloaded = await fetch(`${base}${artifact.downloadPath}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
      const unauthenticated = await fetch(`${base}${artifact.downloadPath}`);
      assert.equal(unauthenticated.status, 401);
      imageBytes(await tool(first, "browser_take_screenshot", { type: "jpeg", filename: "offline.jpg" }), "jpeg");
      const element = imageBytes(await tool(first, "browser_take_screenshot", { target: "#save" }));
      assert.ok(element.readUInt32BE(16) < 640);
      imageBytes(await tool(first, "page_screenshot", { sessionId: artifact.sessionId, pageId: artifact.pageId, fullPage: false }));
      await tool(first, "browser_take_screenshot", { target: "#save", fullPage: true }, { error: true });
    });

    await check("fill/select/keyboard and diagnostic tools work", async () => {
      await tool(first, "browser_fill_form", { fields: [
        { name: "Name", type: "textbox", target: "#name", value: "form" },
        { name: "Enabled", type: "checkbox", target: "#enabled", value: "true" },
      ] });
      await tool(first, "browser_select_option", { target: "#choice", values: ["b"] });
      await tool(first, "browser_hover", { target: "#save" });
      await tool(first, "browser_press_key", { key: "Tab" });
      const consoleResult = await tool(first, "browser_console_messages", { level: "info" });
      assert.ok(JSON.stringify(consoleResult.structuredContent).includes("fixture loaded"));
      const network = await tool(first, "browser_network_requests", { includeStatic: true, static: true });
      assert.ok(JSON.stringify(network.structuredContent).includes(fixtureUrl));
      await tool(first, "browser_navigate", { url: "http://disallowed.invalid/" }, { error: true });
      await tool(first, "browser_wait_for", { time: -1 }, { error: true });
    });

    await check("MCP clients have isolated tabs and DELETE releases their browsers", async () => {
      const second = await initialize();
      await tool(second, "browser_navigate", { url: `${fixtureUrl}/second` });
      await tool(first, "browser_tabs", { action: "new", url: `${fixtureUrl}/tab` });
      await tool(first, "browser_tabs", { action: "select", index: 0 });
      const secondTabs = await tool(second, "browser_tabs", { action: "list" });
      assert.ok(!JSON.stringify(secondTabs.structuredContent).includes(`${fixtureUrl}/tab`));
      const secondShot = await tool(second, "browser_take_screenshot");
      const owned = secondShot.structuredContent.artifact.sessionId;
      const removed = await request("DELETE", "/mcp", undefined, { "Mcp-Session-Id": second });
      assert.equal(removed.response.status, 204);
      const sessions = await request("GET", "/api/sessions");
      assert.ok(!JSON.stringify(sessions.data).includes(owned), "MCP browser survived DELETE");
      await tool(first, "browser_tabs", { action: "close", index: 1 });
    });

    await check("prompt and file chooser actions can complete in a later MCP call", async () => {
      const prompt = await tool(first, "browser_click", { target: "#prompt" });
      assert.equal(prompt.structuredContent.dialog.type, "prompt");
      await tool(first, "browser_handle_dialog", { accept: true, promptText: "Prompt accepted" });
      await tool(first, "browser_wait_for", { text: "Prompt accepted" });
      const chooser = await tool(first, "browser_click", { target: "#upload" });
      assert.equal(chooser.structuredContent.fileChooser.nextTool, "browser_file_upload");
      const uploadPath = path.join(scratch, "scripts", "upload.txt");
      await fs.writeFile(uploadPath, "offline upload");
      await tool(first, "browser_file_upload", { paths: [uploadPath] });
      const uploaded = await tool(first, "browser_evaluate", { function: "() => document.querySelector('#upload').files[0].name" });
      assert.equal(uploaded.structuredContent.result, "upload.txt");
      await tool(first, "browser_click", { target: "#upload" });
      // Existing files outside approved roots must also be rejected.
      const outside = path.join(scratch, "outside.txt");
      await fs.writeFile(outside, "not an upload");
      const denied = await tool(first, "browser_file_upload", { paths: [outside] }, { error: true });
      assert.equal(denied.structuredContent.error.code, "FILE_NOT_ALLOWED");
      await tool(first, "browser_file_upload", {});
    });

    await check("iframe refs and stale-reference errors preserve snapshot targeting", async () => {
      const nav = await tool(first, "browser_navigate", { url: `${fixtureUrl}/frames` });
      const ref = /button "Frame button" \[ref=([^\]]+)\]/.exec(nav.structuredContent.snapshot)?.[1];
      assert.ok(ref, nav.structuredContent.snapshot);
      const evaluated = await tool(first, "browser_evaluate", { ref, function: "(el) => el.textContent" });
      assert.equal(evaluated.structuredContent.result, "Frame button");
      await tool(first, "browser_click", { ref });
      const snapshot = await tool(first, "browser_snapshot");
      assert.ok(snapshot.structuredContent.snapshot.includes("Frame clicked"));
      await tool(first, "browser_navigate_back");
      const stale = await tool(first, "browser_click", { ref }, { error: true });
      assert.equal(stale.structuredContent.error.code, "STALE_ELEMENT_REFERENCE");
    });

    await check("stalled webfont does not block screenshots or failure evidence", async () => {
      await tool(first, "browser_navigate", { url: `${fixtureUrl}/fonts` });
      const deadline = Date.now() + 3000;
      while (!requested.has("/pending.woff2") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(requested.has("/pending.woff2"), "font fixture was not requested");
      const started = Date.now();
      const shot = await tool(first, "browser_take_screenshot");
      imageBytes(shot);
      assert.ok(Date.now() - started < 5000, "screenshot waited for font load");
      const { sessionId, pageId } = shot.structuredContent.artifact;
      const named = await tool(first, "page_screenshot", { sessionId, pageId, filename: "../../wrong.jpg", type: "png", timeoutMs: 0 });
      imageBytes(named);
      assert.ok(named.structuredContent.artifact.fileName.endsWith("-wrong.png"));
      const invalidQuality = await tool(first, "page_screenshot", { sessionId, pageId, quality: 80 }, { error: true });
      assert.equal(invalidQuality.structuredContent.error.code, "INVALID_SCREENSHOT_QUALITY");
      const failedAt = Date.now();
      const failed = await request("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/visible`, {
        locator: { css: "#absent" }, timeoutMs: 100,
      });
      assert.equal(failed.response.status, 408);
      assert.ok(Date.now() - failedAt < 7000, "failure artifacts waited for font load");
      assert.ok(failed.data.artifacts?.screenshot || failed.data.error?.artifacts?.screenshot, JSON.stringify(failed.data));
      const timedOut = await tool(first, "page_screenshot", { sessionId, pageId, locator: { css: "#absent" }, timeoutMs: 100 }, { error: true });
      assert.equal(timedOut.structuredContent.error.code, "TIMEOUT");
      assert.ok(!timedOut.structuredContent.artifacts?.screenshot, "failed capture was retried");
    });

    await check("screenshot works while a script blocks DOMContentLoaded", async () => {
      const current = await tool(first, "browser_take_screenshot");
      const { sessionId, pageId } = current.structuredContent.artifact;
      const nav = await request("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${fixtureUrl}/script`, waitUntil: "commit" });
      assert.equal(nav.response.status, 200, JSON.stringify(nav.data));
      const deadline = Date.now() + 3000;
      while (!requested.has("/pending.js") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(requested.has("/pending.js"));
      const started = Date.now();
      imageBytes(await tool(first, "page_screenshot", { sessionId, pageId, timeoutMs: 2000 }));
      assert.ok(Date.now() - started < 5000, "capture waited for DOMContentLoaded");
      await tool(first, "browser_close");
      const sessions = await request("GET", "/api/sessions");
      assert.equal(sessions.data.data.sessions.length, 0);
    });

    await stopServer();
    child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      env: { ...launchEnv, ENABLE_EVALUATE: "false", SCREENSHOT_WAIT_FOR_FONTS: "true", SCREENSHOT_TIMEOUT_MS: "200" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    await waitForServer();
    const restricted = await initialize();
    await check("browser_evaluate respects the disabled setting for page and element calls", async () => {
      await tool(restricted, "browser_navigate", { url: fixtureUrl });
      for (const args of [{ function: "() => document.title" }, { target: "#name", function: "(el) => el.value" }]) {
        const denied = await tool(restricted, "browser_evaluate", args, { error: true });
        assert.equal(denied.structuredContent.error.code, "EVALUATE_DISABLED");
      }
    });
    await check("explicit webfont waiting honors the configured capture deadline", async () => {
      await tool(restricted, "browser_navigate", { url: `${fixtureUrl}/fonts` });
      const started = Date.now();
      const failed = await tool(restricted, "browser_take_screenshot", {}, { error: true });
      assert.equal(failed.structuredContent.error.code, "TIMEOUT");
      assert.ok(Date.now() - started < 5000);
      await tool(restricted, "browser_close");
    });
  }
} finally {
  for (const res of held) res.destroy();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await stopServer();
  await fs.rm(scratch, { recursive: true, force: true });
}
