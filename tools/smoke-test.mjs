// End-to-end smoke test for playwright-player.
//
// Boots the server on a scratch port with scratch data directories, exercises
// the REST API, the MCP endpoint and one real browser session, then reports a
// pass/fail summary. Run with `npm test`.
//
// Browser-dependent checks are skipped only when no Playwright browser is
// installed, so the suite stays useful in an offline checkout. Any other launch
// failure is a real failure. Set SMOKE_REQUIRE_BROWSER=1 (release verification)
// to turn even the missing-browser case into a failure.
import { spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.SMOKE_PORT || 3911);
const baseUrl = `http://127.0.0.1:${port}`;
const token = "smoke-token";

const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === "1";
const results = [];
let scratchDir;
let child;

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome === "skip") {
      record(name, "skip");
    } else {
      record(name, "pass");
    }
  } catch (error) {
    record(name, "fail", error.message.split("\n")[0]);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function call(method, urlPath, body, { auth = true, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, payload, headers: response.headers };
}

async function waitForHealth(url = baseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy on ${url}`);
}

// A second instance with its own configuration, for settings that cannot be
// changed on a running server (URL_ALLOWLIST).
async function startExtraServer(extraEnv, extraPort) {
  const extraDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-extra-"));
  const process2 = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(extraPort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: path.join(extraDir, "scripts"),
      RUNS_DIR: path.join(extraDir, "runs"),
      ARTIFACTS_DIR: path.join(extraDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(extraDir, "storage-states"),
      ...extraEnv,
    },
  });
  await waitForHealth(`http://127.0.0.1:${extraPort}`);
  return {
    baseUrl: `http://127.0.0.1:${extraPort}`,
    async stop() {
      process2.kill("SIGKILL");
      await fsPromises.rm(extraDir, { recursive: true, force: true });
    },
  };
}

async function start() {
  scratchDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-smoke-"));
  await fsPromises.mkdir(path.join(scratchDir, "scripts"), { recursive: true });
  await fsPromises.writeFile(
    path.join(scratchDir, "scripts", "smoke.spec.js"),
    "import { test, expect } from \"@playwright/test\";\n\ntest(\"@smoke scratch\", async () => {\n  expect(1).toBe(1);\n});\n",
    "utf8",
  );

  child = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      API_TOKEN: token,
      SCRIPTS_DIR: path.join(scratchDir, "scripts"),
      RUNS_DIR: path.join(scratchDir, "runs"),
      ARTIFACTS_DIR: path.join(scratchDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(scratchDir, "storage-states"),
      MAX_CONCURRENT_RUNS: "2",
    },
  });
  const serverLog = [];
  child.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  child.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  child.on("exit", (code) => {
    if (code && code !== 0 && !stopping) {
      console.error(serverLog.join(""));
    }
  });

  await waitForHealth();
}

let stopping = false;

async function runAllowlistChecks() {
  let extra;
  try {
    extra = await startExtraServer({ URL_ALLOWLIST: "allowed.example" }, port + 1);
  } catch (error) {
    record("url allowlist checks", "fail", error.message);
    return;
  }

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${extra.baseUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  try {
    const session = await api("POST", "/api/sessions", {});
    if (session.status !== 201) {
      const message = session.payload?.error?.message || `HTTP ${session.status}`;
      const browserMissing = /Executable doesn't exist|playwright install/i.test(message);
      if (browserMissing && !requireBrowser) {
        record("url allowlist checks", "skip", "no Playwright browser installed");
        return;
      }
      record("url allowlist checks", "fail", message.split("\n")[0]);
      return;
    }

    const sessionId = session.payload.data.sessionId;
    const contextId = (await api("POST", `/api/sessions/${sessionId}/contexts`, {})).payload.data.contextId;
    const pageId = (await api("POST", `/api/sessions/${sessionId}/contexts/${contextId}/pages`, {})).payload.data.pageId;

    await check("allowlist rejects a goto to a host that is not listed", async () => {
      const { status, payload } = await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
        url: "http://blocked.example/",
      });
      assert(status === 403, `expected 403, got ${status}`);
      assert(payload.error.code === "URL_NOT_ALLOWED", payload.error.code);
    });

    await check("allowlist still permits loopback so the built-in pages work", async () => {
      const { status } = await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
        url: `${extra.baseUrl}/demo/test-page`,
      });
      assert(status === 200, `expected 200, got ${status}`);
    });

    await check("allowlist blocks in-page requests, not just goto", async () => {
      // Checking only the goto argument left redirects, iframes and XHR free to
      // reach any host.
      const blocked = await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: 'async () => { try { await fetch("http://blocked.example/data"); return "REACHED"; } catch (error) { return "BLOCKED"; } }',
      });
      assert(blocked.payload.data.result === "BLOCKED", `in-page fetch result: ${blocked.payload.data.result}`);

      const allowed = await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: `async () => (await fetch("${extra.baseUrl}/health")).status`,
      });
      assert(allowed.payload.data.result === 200, `allowed fetch returned ${allowed.payload.data.result}`);
    });

    await check("the allowlist guard survives a user route registration", async () => {
      // User routes are added after the guard, and Playwright matches routes in
      // reverse registration order, so the guard has to be re-installed.
      await api("POST", `/api/sessions/${sessionId}/contexts/${contextId}/route`, {
        url: "**/some-other-path",
        behavior: { action: "continue" },
      });
      const blocked = await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: 'async () => { try { await fetch("http://blocked.example/again"); return "REACHED"; } catch (error) { return "BLOCKED"; } }',
      });
      assert(blocked.payload.data.result === "BLOCKED", `guard bypassed after route add: ${blocked.payload.data.result}`);
    });

    await api("DELETE", `/api/sessions/${sessionId}`);
  } finally {
    await extra.stop();
  }
}

async function stop() {
  stopping = true;
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 8000).unref();
    });
  }
  if (scratchDir) {
    await fsPromises.rm(scratchDir, { recursive: true, force: true });
  }
}

async function run() {
  await start();

  await check("health is public and reports limits", async () => {
    const { status, payload } = await call("GET", "/health", undefined, { auth: false });
    assert(status === 200, `expected 200, got ${status}`);
    assert(payload.data.limits.maxConcurrentRuns === 2, "MAX_CONCURRENT_RUNS not applied");
    assert(payload.data.features.authRequired === true, "authRequired should be true");
  });

  await check("api rejects a missing token", async () => {
    const { status, payload } = await call("GET", "/api/scripts", undefined, { auth: false });
    assert(status === 401, `expected 401, got ${status}`);
    assert(payload.error.code === "UNAUTHORIZED", payload.error.code);
  });

  await check("unknown route returns the JSON error envelope", async () => {
    const { status, payload } = await call("GET", "/api/definitely-not-a-route");
    assert(status === 404, `expected 404, got ${status}`);
    assert(payload.error.code === "NOT_FOUND", payload.error.code);
  });

  await check("malformed JSON is a 400, not a 500", async () => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json",
    });
    const payload = await response.json();
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(payload.error.code === "INVALID_JSON", payload.error.code);
  });

  await check("script registry lists the scratch spec", async () => {
    const { payload } = await call("GET", "/api/scripts");
    assert(payload.data.scripts.some((entry) => entry.scriptKey === "smoke"), "smoke script missing");
  });

  await check("script upload refuses to escape the scripts directory", async () => {
    const { status, payload } = await call("PUT", "/api/scripts/a%2F..%2F..%2Fpwned", { content: "x" });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "PATH_OUTSIDE_ROOT", payload.error.code);
  });

  await check("script upload refuses a non-Playwright extension", async () => {
    const { status, payload } = await call("PUT", "/api/scripts/tmp", { content: "x", fileName: "a.spec.sh" });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "INVALID_SCRIPT_FILENAME", payload.error.code);
  });

  await check("script upload then delete round-trips", async () => {
    const created = await call("PUT", "/api/scripts/uploaded/case", {
      content: "import { test, expect } from \"@playwright/test\";\n\ntest(\"uploaded\", async () => {\n  expect(true).toBe(true);\n});\n",
    });
    assert(created.status === 200, `upload returned ${created.status}`);
    assert(created.payload.data.scriptKey === "uploaded/case", created.payload.data.scriptKey);
    const deleted = await call("DELETE", "/api/scripts/uploaded/case");
    assert(deleted.status === 200, `delete returned ${deleted.status}`);
  });

  await check("storageStateRef cannot read outside STORAGE_STATE_DIR", async () => {
    const { status, payload } = await call("POST", "/api/runs", {
      scriptKey: "smoke",
      storageStateRef: "../../../../etc/hostname",
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "PATH_OUTSIDE_ROOT", payload.error.code);
  });

  await check("validate leaves no scratch directory behind", async () => {
    const { payload } = await call("POST", "/api/scripts/validate", {
      content: "import { test, expect } from \"@playwright/test\";\n\ntest(\"inline\", async () => {\n  expect(1).toBe(1);\n});\n",
      filename: "../../escape.spec.js",
    });
    assert(payload.success === true, "validate failed");
    const entries = await fsPromises.readdir(path.join(scratchDir, "runs")).catch(() => []);
    assert(!entries.some((entry) => entry.startsWith("validation_")), `left behind: ${entries.join(", ")}`);
  });

  await check("assist_plan keeps ko copy when scriptLanguage is ts", async () => {
    const { payload } = await call("POST", "/api/assist/plan", {
      goal: "로그인 스모크 테스트",
      scriptLanguage: "ts",
    });
    assert(payload.data.language === "ko", `language was ${payload.data.language}`);
    assert(payload.data.recommendedFileName.endsWith(".spec.ts"), payload.data.recommendedFileName);
  });

  await check("assist_scaffold renders an expected-based assertion", async () => {
    const { payload } = await call("POST", "/api/assist/scaffold", {
      goal: "status check",
      validate: false,
      steps: [{ action: "assertText", locator: { testId: "status" }, expected: "Ready" }],
    });
    assert(payload.data.content.includes('toContainText("Ready")'), payload.data.content);
  });

  await check("run lifecycle: create, finish, download artifact, delete", async () => {
    const created = await call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" });
    assert(created.status === 201, `create returned ${created.status}`);
    const runId = created.payload.data.runId;

    let status = "running";
    for (let attempt = 0; attempt < 120 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const polled = await call("GET", `/api/runs/${runId}`);
      status = polled.payload.data.status;
    }
    // Asserting only "not running" hid a real failure: the generated config
    // could not resolve @playwright/test when RUNS_DIR sat outside the project.
    const logs = await call("GET", `/api/runs/${runId}/logs`);
    const logText = logs.payload.data.logs.map((entry) => entry.line).join("\n");
    assert(status === "completed", `run ${status}: ${logText.slice(0, 400)}`);

    const artifacts = await call("GET", `/api/runs/${runId}/artifacts`);
    assert(artifacts.payload.data.artifacts.length > 0, "no run artifacts");
    const first = artifacts.payload.data.artifacts[0].relativePath;
    const download = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/${first}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(download.ok, `artifact download returned ${download.status}`);

    const escaped = await call("GET", `/api/runs/${runId}/artifacts/..%2F..%2F..%2Fetc%2Fhostname`);
    assert(escaped.status === 400, `traversal returned ${escaped.status}`);

    const deleted = await call("DELETE", `/api/runs/${runId}`);
    assert(deleted.status === 200, `delete returned ${deleted.status}`);
  });

  await check("syntax mode checks without loading the file", async () => {
    const { payload } = await call("POST", "/api/scripts/validate", {
      mode: "syntax",
      filename: "side-effect.spec.js",
      content: "throw new Error(\"module scope ran\");\n",
    });
    assert(payload.data.mode === "syntax", payload.data.mode);
    assert(payload.data.executesModuleScope === false, "syntax mode must not execute module scope");
    assert(payload.data.valid === true, `valid=${payload.data.valid} stderr=${payload.data.stderr}`);
  });

  await check("syntax mode reports a real parse error", async () => {
    const { payload } = await call("POST", "/api/scripts/validate", {
      mode: "syntax",
      filename: "broken.spec.js",
      content: "const = ;\n",
    });
    assert(payload.data.valid === false, "a parse error should not validate");
  });

  await check("discover mode declares that it loads the file", async () => {
    const { payload } = await call("POST", "/api/scripts/validate", {
      content: "import { test, expect } from \"@playwright/test\";\ntest(\"d\", async () => { expect(1).toBe(1); });\n",
    });
    assert(payload.data.mode === "discover", payload.data.mode);
    assert(payload.data.executesModuleScope === true, "discover mode must declare module-scope execution");
  });

  await check("spawned runs do not inherit the server API token", async () => {
    await call("PUT", "/api/scripts/env-probe", {
      content: [
        "import { test, expect } from \"@playwright/test\";",
        "",
        "test(\"env probe\", async () => {",
        "  expect(process.env.API_TOKEN, \"API_TOKEN leaked into the run\").toBeUndefined();",
        "  expect(process.env.PW_PLAYER_RUN_ID).toBeTruthy();",
        "});",
        "",
      ].join("\n"),
    });
    const created = await call("POST", "/api/runs", { scriptKey: "env-probe", project: "chromium" });
    const runId = created.payload.data.runId;
    let status = "running";
    for (let attempt = 0; attempt < 120 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = (await call("GET", `/api/runs/${runId}`)).payload.data.status;
    }
    const logs = await call("GET", `/api/runs/${runId}/logs`);
    const text = logs.payload.data.logs.map((entry) => entry.line).join("\n");
    assert(status === "completed", `run ${status}: ${text.slice(0, 400)}`);
    await call("DELETE", `/api/runs/${runId}`);
    await call("DELETE", "/api/scripts/env-probe");
  });

  await check("concurrent run requests cannot exceed the limit", async () => {
    // MAX_CONCURRENT_RUNS is 2 for this harness. Fired together, these used to
    // all pass the check before any of them registered.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" })),
    );
    const accepted = responses.filter((entry) => entry.status === 201);
    const rejected = responses.filter((entry) => entry.payload?.error?.code === "RUN_LIMIT_EXCEEDED");
    assert(accepted.length <= 2, `${accepted.length} runs accepted, limit is 2`);
    assert(rejected.length === responses.length - accepted.length, "unexpected rejection reason");

    for (const entry of accepted) {
      const runId = entry.payload.data.runId;
      let status = "running";
      for (let attempt = 0; attempt < 120 && status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = (await call("GET", `/api/runs/${runId}`)).payload.data.status;
      }
      await call("DELETE", `/api/runs/${runId}`);
    }
  });

  await check("scaffolded scripts read run-time variables", async () => {
    const { payload } = await call("POST", "/api/assist/scaffold", {
      goal: "login smoke",
      validate: false,
      variables: { username: "default-user" },
      steps: [{ action: "fill", locator: { testId: "user" }, valueFrom: "username" }],
    });
    assert(payload.data.content.includes("PW_PLAYER_VARIABLES_JSON"), payload.data.content);
    assert(payload.data.content.includes("defaultVariables"), payload.data.content);
  });

  await check("mcp page_action advertises the fields it needs", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const tools = (await response.json()).result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [name, required] of [
      ["page_action", ["locator", "value", "key", "expression"]],
      ["page_assert", ["locator", "expected", "match"]],
      ["page_wait_for", ["loadState", "locator", "textGone"]],
      ["session_execute", []],
    ]) {
      const properties = byName.get(name)?.inputSchema?.properties || {};
      for (const field of required) {
        assert(properties[field], `${name} schema is missing ${field}`);
      }
    }
    assert(byName.get("session_execute").inputSchema.properties.steps.items, "session_execute steps has no item schema");
    assert(byName.get("page_dialog_policy"), "page_dialog_policy tool is missing");
  });

  await check("runs work when SCRIPTS_DIR and RUNS_DIR are outside the project", async () => {
    // Both directories are configurable and normally mounted volumes. A spec
    // file outside the project could not resolve @playwright/test from its own
    // directory, and the generated config could not resolve it either.
    assert(!scratchDir.startsWith(rootDir), "harness scratch dir must be outside the project for this check");
    const created = await call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" });
    const runId = created.payload.data.runId;
    let status = "running";
    for (let attempt = 0; attempt < 120 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = (await call("GET", `/api/runs/${runId}`)).payload.data.status;
    }
    const logs = await call("GET", `/api/runs/${runId}/logs`);
    const text = logs.payload.data.logs.map((entry) => entry.line).join("\n");
    assert(!/does not provide an export named|Cannot find package/.test(text), `config failed to load: ${text.slice(0, 300)}`);
    assert(status === "completed", `run ${status}: ${text.slice(0, 300)}`);
    await call("DELETE", `/api/runs/${runId}`);
  });

  await check("mcp initialize issues a session id", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert(response.ok, `initialize returned ${response.status}`);
    assert(response.headers.get("mcp-session-id"), "no Mcp-Session-Id header");
  });

  await check("mcp notification gets 202 with no body", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
    });
    assert(response.status === 202, `expected 202, got ${response.status}`);
    assert((await response.text()) === "", "notification produced a response body");
  });

  await check("mcp tools/list exposes every registered tool", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const payload = await response.json();
    assert(payload.result.tools.length >= 45, `only ${payload.result.tools.length} tools`);
  });

  await check("mcp denies a foreign origin", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert(response.status === 403, `expected 403, got ${response.status}`);
  });

  await check("openapi documents every implemented route", async () => {
    const { payload } = await call("GET", "/openapi.json", undefined, { auth: false });
    const source = await fsPromises.readFile(path.join(rootDir, "server.js"), "utf8");
    const documented = new Set();
    for (const [pathName, operations] of Object.entries(payload.paths)) {
      for (const method of Object.keys(operations)) {
        documented.add(`${method.toUpperCase()} ${pathName}`);
      }
    }

    // Routes registered from a loop appear in the source as `${action}`; expand
    // that one template into the concrete actions the loop covers.
    const loopedActions = source.match(/for \(const action of \[([^\]]*)\]\)/);
    const expansions = loopedActions
      ? loopedActions[1].split(",").map((entry) => entry.trim().replace(/"/g, "")).filter(Boolean)
      : [];

    const missing = [];
    const routePattern = /app\.(get|post|put|delete)\(`\$\{config\.apiBasePath\}([^`]*)`/g;
    for (const match of source.matchAll(routePattern)) {
      const template = match[2].replace(/:(\w+)\(\*\)/g, "{$1}").replace(/:(\w+)/g, "{$1}");
      const concrete = template.includes("${action}")
        ? expansions.map((action) => template.replace("${action}", action))
        : [template];
      for (const routePath of concrete) {
        const normalized = `${match[1].toUpperCase()} /api${routePath}`;
        if (!documented.has(normalized)) {
          missing.push(normalized);
        }
      }
    }
    assert(missing.length === 0, `undocumented: ${missing.join(", ")}`);
  });

  // ---- URL allowlist (needs its own server instance) -----------------------
  await runAllowlistChecks();

  // ---- browser-dependent checks --------------------------------------------
  const session = await call("POST", "/api/sessions", {});
  if (session.status !== 201) {
    const message = session.payload?.error?.message || `HTTP ${session.status}`;
    // Distinguish "this machine has no browser" from "the browser is broken":
    // skipping both hid real launch regressions.
    const browserMissing = /Executable doesn't exist|playwright install|Failed to launch.*ENOENT/i.test(message);
    if (browserMissing && !requireBrowser) {
      record("browser session checks", "skip", "no Playwright browser installed — run `npx playwright install chromium`");
      return;
    }
    record("browser session checks", "fail", message.split("\n")[0]);
    return;
  }

  const sessionId = session.payload.data.sessionId;
  try {
    const context = await call("POST", `/api/sessions/${sessionId}/contexts`, {});
    const contextId = context.payload.data.contextId;
    const page = await call("POST", `/api/sessions/${sessionId}/contexts/${contextId}/pages`, {});
    const pageId = page.payload.data.pageId;

    await check("goto and inspect the built-in demo page", async () => {
      const navigated = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
        url: `${baseUrl}/demo/test-page`,
      });
      assert(navigated.status === 200, `goto returned ${navigated.status}`);
      const inspected = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/inspect`, { maxElements: 10 });
      assert(inspected.payload.data.interactiveElements.length > 0, "no interactive elements found");
    });

    await check("a URL path is not mistaken for a regular expression", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/url`, {
        value: "/demo/b",
        timeoutMs: 500,
      });
      assert(status === 408, `expected 408 TIMEOUT, got ${status} ${JSON.stringify(payload.error)}`);
    });

    await check("a regex literal still works for url assertions", async () => {
      const { status } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/url`, {
        value: "/demo\\/test-page/i",
        timeoutMs: 3000,
      });
      assert(status === 200, `expected 200, got ${status}`);
    });

    await check("press without a key is a 400", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/press`, {
        locator: { css: "body" },
      });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "INVALID_REQUEST", payload.error.code);
    });

    await check("count assertion without a number is a 400", async () => {
      const { status } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/count`, {
        locator: { css: "button" },
      });
      assert(status === 400, `expected 400, got ${status}`);
    });

    await check("wait-for without criteria is a 400", async () => {
      const { status } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/wait-for`, {});
      assert(status === 400, `expected 400, got ${status}`);
    });

    await check("rejected request bodies create no artifacts (timeouts still do)", async () => {
      const countArtifacts = async () => {
        const { payload } = await call("GET", `/api/sessions/${sessionId}/artifacts`);
        return payload.data.artifacts.filter((entry) => entry.type.startsWith("error-")).length;
      };

      const before = await countArtifacts();
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/press`, { locator: { css: "body" } });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/count`, { locator: { css: "button" } });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/wait-for`, {});
      const afterBadRequests = await countArtifacts();
      assert(afterBadRequests === before, `${afterBadRequests - before} artifacts from rejected bodies`);

      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/visible`, {
        locator: { testId: "definitely-absent" },
        timeoutMs: 400,
      });
      const afterTimeout = await countArtifacts();
      assert(afterTimeout > before, "a timeout should still capture a screenshot and DOM dump");
    });

    await check("execute runs a batch and reports per-step results", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "fill", locator: { testId: "message-input" }, value: "smoke" },
          { action: "click", locator: { testId: "send-message" } },
          { action: "assertText", locator: { testId: "status" }, expected: "sent", timeoutMs: 3000 },
        ],
      });
      assert(status === 200, `execute returned ${status}`);
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
    });

    await check("execute with continueOnError keeps going", async () => {
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        continueOnError: true,
        steps: [
          { action: "click", locator: { testId: "missing-thing" }, timeoutMs: 400 },
          { action: "assertVisible", locator: { testId: "status" }, timeoutMs: 2000 },
        ],
      });
      assert(payload.data.failedCount === 1, `failedCount=${payload.data.failedCount}`);
      assert(payload.data.results[1].status === "ok", "second step did not run");
    });

    await check("screenshot artifact serves inline on request", async () => {
      const shot = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/screenshot`, { fullPage: true });
      const artifactId = shot.payload.data.artifact.artifactId;
      const inline = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}?disposition=inline`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(inline.headers.get("content-disposition").startsWith("inline"), inline.headers.get("content-disposition"));
      assert(inline.headers.get("content-type") === "image/png", inline.headers.get("content-type"));
      const attachment = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(attachment.headers.get("content-disposition").startsWith("attachment"), "default is not attachment");
    });

    await check("evaluate runs a function expression and returns its value", async () => {
      const plain = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, { expression: "1 + 2" });
      assert(plain.payload.data.result === 3, `plain expression returned ${JSON.stringify(plain.payload.data.result)}`);

      // This form silently returned undefined before: Playwright does not invoke
      // a string arrow function.
      const fn = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: "() => document.title",
      });
      assert(typeof fn.payload.data.result === "string" && fn.payload.data.result.length > 0,
        `function expression returned ${JSON.stringify(fn.payload.data.result)}`);

      const withArg = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: "(n) => n * 2",
        arg: 21,
      });
      assert(withArg.payload.data.result === 42, `arg was not forwarded: ${JSON.stringify(withArg.payload.data.result)}`);
    });

    await check("a dialog no longer blocks the click that opened it", async () => {
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: `() => {
          const button = document.createElement("button");
          button.id = "smoke-dialog";
          button.textContent = "dialog";
          button.onclick = () => window.confirm("block me?");
          document.body.append(button);
        }`,
      });
      const started = Date.now();
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, {
        locator: { css: "#smoke-dialog" },
        timeoutMs: 5000,
      });
      const elapsed = Date.now() - started;
      assert(status === 200, `click returned ${status} after ${elapsed}ms: ${JSON.stringify(payload.error)}`);
      assert(elapsed < 4000, `click took ${elapsed}ms — the dialog was not answered`);
      assert(payload.data.lastDialog?.dialogType === "confirm", JSON.stringify(payload.data.lastDialog));
      assert(payload.data.lastDialog?.handledWith === "dismiss", JSON.stringify(payload.data.lastDialog));
    });

    await check("dialog policy accept is honoured per page", async () => {
      const set = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/dialog-policy`, { action: "accept" });
      assert(set.status === 200, `policy returned ${set.status}`);
      const { payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, {
        locator: { css: "#smoke-dialog" },
        timeoutMs: 5000,
      });
      assert(payload.data.lastDialog?.handledWith === "accept", JSON.stringify(payload.data.lastDialog));
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/dialog-policy`, { action: "dismiss" });
    });

    await check("an invalid dialog policy is rejected", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/dialog-policy`, { action: "explode" });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "INVALID_DIALOG_POLICY", payload.error.code);
    });

    await check("route fixtures cannot escape the fixtures directory", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/contexts/${contextId}/route`, {
        url: "**/blocked",
        behavior: { action: "fulfill", path: "../../../../etc/hostname" },
      });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "PATH_OUTSIDE_ROOT", payload.error.code);
    });

    await check("artifacts stay downloadable after the session closes", async () => {
      const shot = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/screenshot`, {});
      const artifactId = shot.payload.data.artifact.artifactId;
      const throwaway = await call("POST", "/api/sessions", {});
      const throwawayId = throwaway.payload.data.sessionId;
      await call("DELETE", `/api/sessions/${throwawayId}`);

      // The session that produced it is still open here; the real check is that
      // the index, not the session record, is what resolves the id.
      const listed = await call("GET", `/api/sessions/${sessionId}/artifacts`);
      assert(listed.payload.data.artifacts.some((entry) => entry.artifactId === artifactId), "artifact missing from listing");
      const download = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(download.ok, `download returned ${download.status}`);
    });

    await check("stopping a trace that never started is a 409", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/trace/stop`, { contextId });
      assert(status === 409, `expected 409, got ${status}`);
      assert(payload.error.code === "TRACE_NOT_STARTED", payload.error.code);
    });

    await check("storage state import rejects a non-storage-state object", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/contexts/${contextId}/storage-state/import`, {
        storageState: { name: "not-a-storage-state" },
      });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "INVALID_STORAGE_STATE", payload.error.code);
    });
  } finally {
    await call("DELETE", `/api/sessions/${sessionId}`);
  }
}

try {
  await run();
} catch (error) {
  record("harness", "fail", error.message);
} finally {
  await stop();
}

const failed = results.filter((entry) => entry.status === "fail");
const skipped = results.filter((entry) => entry.status === "skip");
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exit(failed.length ? 1 : 0);
