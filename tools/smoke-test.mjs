// End-to-end smoke test for playwright-player.
//
// Boots the server on a scratch port with scratch data directories, exercises
// the REST API, the MCP endpoint and one real browser session, then reports a
// pass/fail summary. Run with `npm test`.
//
// Browser-dependent checks are skipped (not failed) when no Playwright browser
// is installed, so the suite stays useful in an offline checkout.
import { spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.SMOKE_PORT || 3911);
const baseUrl = `http://127.0.0.1:${port}`;
const token = "smoke-token";

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

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy on ${baseUrl}`);
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
    const created = await call("POST", "/api/runs", { scriptKey: "smoke" });
    assert(created.status === 201, `create returned ${created.status}`);
    const runId = created.payload.data.runId;

    let status = "running";
    for (let attempt = 0; attempt < 120 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const polled = await call("GET", `/api/runs/${runId}`);
      status = polled.payload.data.status;
    }
    assert(status !== "running", "run never finished");

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

  // ---- browser-dependent checks --------------------------------------------
  const session = await call("POST", "/api/sessions", {});
  if (session.status !== 201) {
    record("browser session checks", "skip", `session create returned ${session.status} (no browser installed?)`);
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
