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
import http from "node:http";
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

// Runs are queued, so a test that needs them finished has to wait for the whole
// set rather than assume the first one started immediately.
async function waitForRuns(runIds, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(runIds);
  while (pending.size && Date.now() < deadline) {
    for (const runId of [...pending]) {
      const { status, payload } = await call("GET", `/api/runs/${runId}`);
      if (status !== 200 || ["completed", "failed", "cancelled", "interrupted"].includes(payload.data.status)) {
        pending.delete(runId);
      }
    }
    if (pending.size) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (pending.size) {
    throw new Error(`runs did not finish within ${timeoutMs}ms: ${[...pending].join(", ")}`);
  }
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

// The point of persisting runs is surviving a restart, so this starts a server,
// produces history, kills it without a graceful shutdown, starts a new process
// against the same RUNS_DIR, and queries what came back.
// Stands in for a business system: submitting creates a record with a reference
// number that can be fetched back, and a receipt that can be downloaded. The
// outcome assertions are meaningless unless they are checked against something
// that can actually be right or wrong.
function startBusinessStub() {
  const records = new Map();
  let seq = 1000;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body>
        <button data-testid="submit">Submit</button>
        <div data-testid="status">idle</div>
        <div data-testid="reference"></div>
        <a data-testid="receipt" style="display:none">receipt</a>
        <script>
          document.querySelector('[data-testid=submit]').onclick = async () => {
            const r = await (await fetch('/api/orders', { method: 'POST' })).json();
            document.querySelector('[data-testid=reference]').textContent = r.reference;
            document.querySelector('[data-testid=status]').textContent = 'Submitted';
            const a = document.querySelector('[data-testid=receipt]');
            a.href = '/api/orders/' + r.reference + '/receipt';
            a.download = r.reference + '.json';
            a.style.display = '';
          };
        </script></body>`);
      return;
    }
    if (url.pathname === "/api/orders" && req.method === "POST") {
      const reference = `ORD-${++seq}`;
      records.set(reference, { reference, status: "ACCEPTED", amount: 42 });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reference }));
      return;
    }
    const match = url.pathname.match(/^\/api\/orders\/([^/]+)(\/receipt)?$/);
    if (match) {
      const record = records.get(match[1]);
      if (!record) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      const headers = { "content-type": "application/json" };
      if (match[2]) {
        headers["content-disposition"] = `attachment; filename="${record.reference}.json"`;
      }
      res.writeHead(200, headers).end(JSON.stringify({ data: { order: record } }));
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runRestartChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-restart-"));
  const scriptsDir = path.join(dataDir, "scripts");
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(scriptsDir, "restart.spec.js"),
    "import { test, expect } from \"@playwright/test\";\n\ntest(\"restart evidence\", async () => {\n  expect(1).toBe(1);\n});\n",
    "utf8",
  );

  const restartPort = port + 2;
  const restartUrl = `http://127.0.0.1:${restartPort}`;
  const env = {
    PORT: String(restartPort),
    HOST: "127.0.0.1",
    SCRIPTS_DIR: scriptsDir,
    RUNS_DIR: path.join(dataDir, "runs"),
    ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
    STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
    MAX_CONCURRENT_RUNS: "1",
  };

  const spawnServer = async () => {
    const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const log = [];
    proc.stdout.on("data", (chunk) => log.push(chunk.toString()));
    proc.stderr.on("data", (chunk) => log.push(chunk.toString()));
    await waitForHealth(restartUrl);
    return { proc, log };
  };

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${restartUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const waitFor = async (runId) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const { payload } = await api("GET", `/api/runs/${runId}`);
      if (["completed", "failed", "cancelled", "interrupted"].includes(payload.data.status)) {
        return payload.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`run ${runId} never finished`);
  };

  let first;
  try {
    first = await spawnServer();
  } catch (error) {
    record("restart recovery checks", "fail", error.message);
    await fsPromises.rm(dataDir, { recursive: true, force: true });
    return;
  }

  let finishedRunId;
  let queuedRunId;
  let runningRunId;
  try {
    const done = await api("POST", "/api/runs", { scriptKey: "restart", project: "chromium" });
    if (done.status !== 201) {
      record("restart recovery checks", "fail", done.payload?.error?.message || `HTTP ${done.status}`);
      return;
    }
    finishedRunId = done.payload.data.runId;
    const finished = await waitFor(finishedRunId);
    if (finished.status !== "completed") {
      const message = (await api("GET", `/api/runs/${finishedRunId}/logs`)).payload.data.logs
        .map((entry) => entry.line).join(" ").slice(0, 200);
      const browserMissing = /Executable doesn't exist|playwright install/i.test(message);
      if (browserMissing && !requireBrowser) {
        record("restart recovery checks", "skip", "no Playwright browser installed");
        return;
      }
      record("restart recovery checks", "fail", `seed run ${finished.status}: ${message}`);
      return;
    }

    // One running and one queued when the process dies.
    runningRunId = (await api("POST", "/api/runs", { scriptKey: "restart", project: "chromium" })).payload.data.runId;
    queuedRunId = (await api("POST", "/api/runs", { scriptKey: "restart", project: "chromium" })).payload.data.runId;
  } finally {
    // SIGKILL: no graceful shutdown, no chance to write anything on the way out.
    first.proc.kill("SIGKILL");
    await new Promise((resolve) => first.proc.on("exit", resolve));
  }

  let second;
  try {
    second = await spawnServer();
  } catch (error) {
    record("restart recovery checks", "fail", `restart failed: ${error.message}`);
    await fsPromises.rm(dataDir, { recursive: true, force: true });
    return;
  }

  try {
    await check("a completed run's result survives a hard restart", async () => {
      const { status, payload } = await api("GET", `/api/runs/${finishedRunId}`);
      assert(status === 200, `run lookup returned ${status}`);
      assert(payload.data.status === "completed", payload.data.status);
      assert(payload.data.tests.length > 0, "per-test results were lost");
      assert(payload.data.tests[0].title.includes("restart evidence"), JSON.stringify(payload.data.tests[0]));
      assert(payload.data.script?.sha256, "the pinned script hash was lost");
    });

    await check("evidence stays downloadable after a hard restart", async () => {
      const artifacts = await api("GET", `/api/runs/${finishedRunId}/artifacts`);
      const names = artifacts.payload.data.artifacts.map((entry) => entry.relativePath);
      assert(names.includes("report.json"), `artifacts lost: ${names.join(", ")}`);
      const download = await fetch(`${restartUrl}/api/runs/${finishedRunId}/artifacts/report.json`);
      assert(download.ok, `artifact download returned ${download.status}`);
    });

    await check("logs written by the previous process are still readable", async () => {
      const { payload } = await api("GET", `/api/runs/${finishedRunId}/logs`);
      assert(payload.data.source === "file", `read from ${payload.data.source}, expected the on-disk log`);
      assert(payload.data.logs.length > 0, "no log lines recovered");
      assert(payload.data.logs.some((entry) => entry.line.includes("passed")), "the run output was lost");
    });

    await check("a run interrupted by the restart is reported, not silently lost", async () => {
      const { payload } = await api("GET", `/api/runs/${runningRunId}`);
      assert(payload.data.status === "interrupted", payload.data.status);
      assert(payload.data.interruptedReason, "no reason recorded");
      assert(payload.data.endedAt, "no end time recorded");
    });

    await check("a run that was still queued is picked back up", async () => {
      const { payload } = await api("GET", `/api/runs/${queuedRunId}`);
      assert(["queued", "running", "completed"].includes(payload.data.status),
        `queued run came back as ${payload.data.status}`);
      const finished = await waitFor(queuedRunId);
      assert(finished.status === "completed", `requeued run ended as ${finished.status}`);
    });

    await check("history can be filtered by status after a restart", async () => {
      const interrupted = await api("GET", "/api/runs?status=interrupted");
      assert(interrupted.payload.data.runs.length === 1, `${interrupted.payload.data.runs.length} interrupted runs`);
      assert(interrupted.payload.data.runs[0].runId === runningRunId, "wrong run reported as interrupted");

      const completed = await api("GET", "/api/runs?status=completed&limit=1");
      assert(completed.payload.data.limit === 1, "limit was ignored");
      assert(completed.payload.data.total >= 1, "no completed runs in history");
    });
  } finally {
    second.proc.kill("SIGKILL");
    await new Promise((resolve) => second.proc.on("exit", resolve));
  }

  // RUNS_DIR is normally a mounted volume, so the same data can legitimately
  // appear at a different absolute path in the next lifetime. Stored records
  // hold absolute paths, so this checks they are re-derived and not trusted.
  const movedRuns = path.join(dataDir, "runs-moved");
  let third;
  try {
    await fsPromises.rename(path.join(dataDir, "runs"), movedRuns);
    env.RUNS_DIR = movedRuns;
    third = await spawnServer();

    await check("history survives RUNS_DIR being remounted at a new path", async () => {
      const { status, payload } = await api("GET", `/api/runs/${finishedRunId}`);
      assert(status === 200, `run lookup returned ${status}`);
      assert(payload.data.paths.runDir.startsWith(movedRuns),
        `stale path kept: ${payload.data.paths.runDir}`);

      const download = await fetch(`${restartUrl}/api/runs/${finishedRunId}/artifacts/report.json`);
      assert(download.ok, `artifact download returned ${download.status}`);

      const logs = await api("GET", `/api/runs/${finishedRunId}/logs`);
      assert(logs.payload.data.logs.length > 0, "logs unreadable after the move");
    });
  } catch (error) {
    record("history survives RUNS_DIR being remounted at a new path", "fail", error.message);
  } finally {
    if (third) {
      third.proc.kill("SIGKILL");
      await new Promise((resolve) => third.proc.on("exit", resolve));
    }
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

// Retention used to drop any run that was not "running", which after the queue
// landed also matched "queued" - a waiting run could be deleted out from under
// the queue.
// "The button turned green" is not "the task completed". These exercise the
// assertions that look past the screen: the API, a captured reference number,
// and the downloaded file.
// A credential passed in `variables` used to be written into run.json and
// returned by the API, permanently. These need their own instance so SECRETS_DIR
// and the stores point somewhere disposable.
// Cron is hand-rolled here because no scheduling dependency is available, so the
// parser is checked directly rather than only through a live schedule — waiting
// for wall-clock minutes cannot cover 29 cases.
function checkCronParsing() {
  const fixtures = [
    ["* * * * *", "2026-10-01T13:05:00", true],
    ["0 2 * * *", "2026-10-01T02:00:00", true],
    ["0 2 * * *", "2026-10-01T02:01:00", false],
    ["0 2 * * *", "2026-10-01T03:00:00", false],
    ["*/15 * * * *", "2026-10-01T13:30:00", true],
    ["*/15 * * * *", "2026-10-01T13:31:00", false],
    ["30 9 * * 1-5", "2026-10-01T09:30:00", true],
    ["30 9 * * 1-5", "2026-10-03T09:30:00", false],
    ["0 0 1 * *", "2026-10-01T00:00:00", true],
    ["0 0 1 * *", "2026-10-02T00:00:00", false],
    ["0,30 * * * *", "2026-10-01T13:30:00", true],
    ["0,30 * * * *", "2026-10-01T13:15:00", false],
    ["0 9-17/4 * * *", "2026-10-01T13:00:00", true],
    ["0 9-17/4 * * *", "2026-10-01T14:00:00", false],
    // Both day fields restricted: either may match, as standard cron does.
    ["0 0 1 * 0", "2026-10-01T00:00:00", true],
    ["0 0 1 * 0", "2026-10-04T00:00:00", true],
    ["0 0 1 * 0", "2026-10-02T00:00:00", false],
  ];
  const invalid = ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *", "*/0 * * * *", "a * * * *", "5-1 * * * *"];
  return { fixtures, invalid };
}

async function runScheduleChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-sched-"));
  const scriptsDir = path.join(dataDir, "scripts");
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(scriptsDir, "ok.spec.js"),
    'import { test, expect } from "@playwright/test";\n\ntest("passes", async () => { expect(1).toBe(1); });\n',
    "utf8",
  );
  await fsPromises.writeFile(
    path.join(scriptsDir, "bad.spec.js"),
    'import { test, expect } from "@playwright/test";\n\ntest("fails", async () => { expect(1).toBe(2); });\n',
    "utf8",
  );

  // A stub webhook receiver, so the callback is checked against something that
  // actually records what arrived.
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        received.push(JSON.parse(body || "{}"));
      } catch {
        received.push({ unparseable: body });
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

  const schedPort = port + 6;
  const schedUrl = `http://127.0.0.1:${schedPort}`;
  const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(schedPort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: scriptsDir,
      RUNS_DIR: path.join(dataDir, "runs"),
      ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
      ENVIRONMENTS_DIR: path.join(dataDir, "environments"),
      DATASETS_DIR: path.join(dataDir, "datasets"),
      SCHEDULES_DIR: path.join(dataDir, "schedules"),
      SCHEDULE_TICK_MS: "3000",
      NOTIFY_ALLOWLIST: "127.0.0.1",
    },
  });

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${schedUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const waitFor = async (runId, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { payload } = await api("GET", `/api/runs/${runId}`);
      if (["completed", "failed", "cancelled", "interrupted"].includes(payload.data.status)) {
        return payload.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`run ${runId} never finished`);
  };

  try {
    await waitForHealth(schedUrl);

    await check("the cron parser accepts and rejects the right expressions", async () => {
      const { fixtures, invalid } = checkCronParsing();
      // Exercised through the API: saving validates the expression, so a
      // rejected save means the parser rejected it.
      for (const expression of invalid) {
        const response = await api("PUT", "/api/schedules/probe", {
          cron: expression,
          request: { scriptKey: "ok" },
        });
        assert(response.status === 400, `accepted invalid cron ${JSON.stringify(expression)}`);
        assert(response.payload.error.code === "INVALID_CRON", `${expression}: ${response.payload.error.code}`);
      }
      for (const [expression] of fixtures) {
        const response = await api("PUT", "/api/schedules/probe", {
          cron: expression,
          request: { scriptKey: "ok", project: "chromium" },
          enabled: false,
        });
        assert(response.status === 200, `rejected valid cron ${expression}: ${JSON.stringify(response.payload.error)}`);
      }
      await api("DELETE", "/api/schedules/probe");
    });

    await check("a schedule is validated when saved, not at the scheduled time", async () => {
      const unknownScript = await api("PUT", "/api/schedules/bad1", { cron: "0 2 * * *", request: { scriptKey: "nope" } });
      assert(unknownScript.status === 404 || unknownScript.status === 400, `got ${unknownScript.status}`);
      assert(unknownScript.payload.error.code === "SCRIPT_NOT_FOUND", unknownScript.payload.error.code);

      const unknownEnv = await api("PUT", "/api/schedules/bad2", {
        cron: "0 2 * * *",
        request: { scriptKey: "ok", environment: "nope" },
      });
      assert(unknownEnv.payload.error.code === "ENVIRONMENT_NOT_FOUND", unknownEnv.payload.error.code);

      const noScript = await api("PUT", "/api/schedules/bad3", { cron: "0 2 * * *", request: {} });
      assert(noScript.status === 400, `got ${noScript.status}`);
    });

    await check("a notify URL cannot be used to reach an arbitrary host", async () => {
      // Without this the server is an SSRF proxy for anything it can route to.
      const blocked = await api("PUT", "/api/schedules/ssrf", {
        cron: "0 2 * * *",
        request: { scriptKey: "ok" },
        notify: { url: "http://169.254.169.254/latest/meta-data/" },
      });
      assert(blocked.status === 403, `expected 403, got ${blocked.status}`);
      assert(blocked.payload.error.code === "NOTIFY_URL_NOT_ALLOWED", blocked.payload.error.code);

      const scheme = await api("PUT", "/api/schedules/ssrf", {
        cron: "0 2 * * *",
        request: { scriptKey: "ok" },
        notify: { url: "file:///etc/passwd" },
      });
      assert(scheme.status === 400, `expected 400, got ${scheme.status}`);
      assert(scheme.payload.error.code === "INVALID_NOTIFY_URL", scheme.payload.error.code);
    });

    await check("triggering a schedule runs it now and calls back with the failure", async () => {
      received.length = 0;
      const saved = await api("PUT", "/api/schedules/gate", {
        cron: "0 2 * * *",
        request: { scriptKey: "bad", project: "chromium" },
        notify: { url: hookUrl, on: "always" },
      });
      assert(saved.status === 200, `save returned ${saved.status}: ${JSON.stringify(saved.payload.error)}`);

      const triggered = await api("POST", "/api/schedules/gate/trigger", { variables: { buildId: "build-42" } });
      assert(triggered.status === 201, `trigger returned ${triggered.status}`);
      assert(triggered.payload.data.schedule === "gate", "the run does not record its schedule");
      assert(triggered.payload.data.request.variables.buildId === "build-42", "the override was not merged");

      const finished = await waitFor(triggered.payload.data.runId);
      assert(finished.status === "failed", `expected failed, got ${finished.status}`);

      for (let attempt = 0; attempt < 30 && !received.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert(received.length === 1, `${received.length} callbacks received`);
      const payload = received[0];
      assert(payload.event === "run.finished", payload.event);
      assert(payload.status === "failed", payload.status);
      assert(payload.schedule === "gate", payload.schedule);
      assert(payload.request.variables.buildId === "build-42", "the callback lost the build id");
      assert(payload.failedTests.length > 0, "the callback did not name the failing tests");

      // The delivery outcome has to be visible, or a silently failing hook looks
      // like a passing pipeline.
      const stored = await api("GET", `/api/runs/${triggered.payload.data.runId}`);
      assert(stored.payload.data.notification?.delivered === true, JSON.stringify(stored.payload.data.notification));
      assert(stored.payload.data.notification.status === 200, JSON.stringify(stored.payload.data.notification));
    });

    await check("on: failure stays quiet when the run passes", async () => {
      received.length = 0;
      const created = await api("POST", "/api/runs", {
        scriptKey: "ok",
        project: "chromium",
        notify: { url: hookUrl, on: "failure" },
      });
      const finished = await waitFor(created.payload.data.runId);
      assert(finished.status === "completed", `run ${finished.status}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert(received.length === 0, `a passing run sent ${received.length} callbacks`);
      assert(finished.notification === null, JSON.stringify(finished.notification));
    });

    await check("an undeliverable callback is recorded rather than swallowed", async () => {
      // A port nothing is listening on: the run still finishes, and the failure
      // to notify is on the record.
      const created = await api("POST", "/api/runs", {
        scriptKey: "ok",
        project: "chromium",
        notify: { url: "http://127.0.0.1:9/nope", on: "always" },
      });
      const finished = await waitFor(created.payload.data.runId);
      assert(finished.status === "completed", `run ${finished.status}`);
      assert(finished.notification?.delivered === false, JSON.stringify(finished.notification));
      assert(finished.notification.error, "no error recorded for the failed delivery");
    });

    await check("the scheduler fires on its cron and only once per minute", async () => {
      const before = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      const saved = await api("PUT", "/api/schedules/everyminute", {
        cron: "* * * * *",
        request: { scriptKey: "ok", project: "chromium" },
      });
      assert(saved.status === 200, `save returned ${saved.status}`);

      // Minute granularity, so this has to wait out a wall-clock minute.
      let after = before;
      for (let attempt = 0; attempt < 90 && after === before; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        after = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      }
      assert(after > before, "the schedule never fired");

      const schedule = await api("GET", "/api/schedules/everyminute");
      assert(schedule.payload.data.lastFiredMinute, "the fired minute was not recorded");

      // The tick runs every 3s here, so without the guard the same minute would
      // fire repeatedly.
      const settled = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      await new Promise((resolve) => setTimeout(resolve, 12000));
      const later = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      assert(later === settled, `fired again within the same minute: ${settled} -> ${later}`);

      await api("PUT", "/api/schedules/everyminute", {
        cron: "* * * * *",
        enabled: false,
        request: { scriptKey: "ok", project: "chromium" },
      });
      const disabled = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      await new Promise((resolve) => setTimeout(resolve, 12000));
      const stillDisabled = (await api("GET", "/api/runs?limit=200")).payload.data.total;
      assert(stillDisabled === disabled, "a disabled schedule fired");
    });
  } catch (error) {
    record("schedule and callback checks", "fail", error.message);
  } finally {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.on("exit", resolve));
    await new Promise((resolve) => hook.close(resolve));
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

async function runEnvironmentChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-env-"));
  const scriptsDir = path.join(dataDir, "scripts");
  const secretsDir = path.join(dataDir, "secrets");
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.mkdir(secretsDir, { recursive: true });
  const SECRET = "hunter2-from-the-secret-store";
  await fsPromises.writeFile(path.join(secretsDir, "customer-password"), SECRET, "utf8");
  await fsPromises.writeFile(
    path.join(scriptsDir, "echo.spec.js"),
    [
      'import { test, expect } from "@playwright/test";',
      "",
      'const variables = JSON.parse(process.env.PW_PLAYER_VARIABLES_JSON || "{}");',
      "",
      'test("sees what it was given", async () => {',
      '  console.log("VARS=" + JSON.stringify(variables));',
      "  expect(variables.username).toBeTruthy();",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const envPort = port + 5;
  const envUrl = `http://127.0.0.1:${envPort}`;
  const runsDir = path.join(dataDir, "runs");
  const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(envPort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: scriptsDir,
      RUNS_DIR: runsDir,
      ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
      ENVIRONMENTS_DIR: path.join(dataDir, "environments"),
      DATASETS_DIR: path.join(dataDir, "datasets"),
      SECRETS_DIR: secretsDir,
    },
  });

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${envUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const waitFor = async (runId, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { payload } = await api("GET", `/api/runs/${runId}`);
      if (["completed", "failed", "cancelled", "interrupted"].includes(payload.data.status)) {
        return payload.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`run ${runId} never finished`);
  };

  const grepTree = async (dir, needle) => {
    const hits = [];
    const walk = async (current) => {
      const entries = await fsPromises.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const body = await fsPromises.readFile(full, "utf8").catch(() => "");
          if (body.includes(needle)) {
            hits.push(path.relative(dir, full));
          }
        }
      }
    };
    await walk(dir);
    return hits;
  };

  try {
    await waitForHealth(envUrl);

    await check("an environment supplies baseURL, project and variables", async () => {
      const saved = await api("PUT", "/api/environments/staging", {
        baseURL: "https://stg.example.com",
        project: "chromium",
        variables: { locale: "ko-KR", username: "operator", password: "{{secret.customer-password}}" },
      });
      assert(saved.status === 200, `save returned ${saved.status}`);

      const listed = await api("GET", "/api/environments");
      assert(listed.payload.data.environments.some((entry) => entry.name === "staging"), "not listed");

      const created = await api("POST", "/api/runs", { scriptKey: "echo", environment: "staging" });
      assert(created.status === 201, `run create returned ${created.status}`);
      assert(created.payload.data.request.baseURL === "https://stg.example.com", "baseURL was not applied");
      assert(created.payload.data.environment?.name === "staging", "the run does not record its environment");

      const finished = await waitFor(created.payload.data.runId);
      const logs = await api("GET", `/api/runs/${created.payload.data.runId}/logs`);
      const text = logs.payload.data.logs.map((entry) => entry.line).join("\n");
      assert(finished.status === "completed", `run ${finished.status}: ${text.slice(0, 300)}`);
      // The environment's variables have to reach the script.
      assert(/"locale":"ko-KR"/.test(text), `variables not delivered: ${text.slice(0, 300)}`);
      await api("DELETE", `/api/runs/${created.payload.data.runId}`);
    });

    await check("an explicit field wins over the environment", async () => {
      const created = await api("POST", "/api/runs", {
        scriptKey: "echo",
        environment: "staging",
        baseURL: "https://override.example.com",
        variables: { locale: "en-US" },
      });
      assert(created.payload.data.request.baseURL === "https://override.example.com", "baseURL was not overridden");
      await api("POST", `/api/runs/${created.payload.data.runId}/cancel`);
      await waitFor(created.payload.data.runId);
      const finished = await api("GET", `/api/runs/${created.payload.data.runId}`);
      assert(finished.payload.data.request.variables.locale === "en-US", "the request variable was not preferred");
      await api("DELETE", `/api/runs/${created.payload.data.runId}`);
    });

    await check("a secret reference never reaches the record, the API, or the log", async () => {
      const created = await api("POST", "/api/runs", { scriptKey: "echo", environment: "staging" });
      const runId = created.payload.data.runId;
      const finished = await waitFor(runId);
      assert(finished.status === "completed", `run ${finished.status}`);

      // The reference is kept; the value is not.
      assert(finished.request.variables.password === "{{secret.customer-password}}",
        `stored ${finished.request.variables.password}`);

      const asJson = JSON.stringify(finished);
      assert(!asJson.includes(SECRET), "the API response contains the secret value");

      const listed = await api("GET", "/api/runs?limit=50");
      assert(!JSON.stringify(listed.payload).includes(SECRET), "the run list contains the secret value");

      // The script prints the value, so the captured log has to be scrubbed.
      const logs = await api("GET", `/api/runs/${runId}/logs`);
      const text = logs.payload.data.logs.map((entry) => entry.line).join("\n");
      assert(/"password":"\*\*\*"/.test(text), `the log was not scrubbed: ${text.slice(0, 300)}`);
      assert(!text.includes(SECRET), "the log contains the secret value");

      const onDisk = await grepTree(path.join(runsDir, runId), SECRET);
      // Playwright writes its own report; that limitation is documented.
      const unexpected = onDisk.filter((file) => !file.startsWith("report.json") && !file.startsWith("html-report"));
      assert(unexpected.length === 0, `the secret reached ${unexpected.join(", ")}`);

      await api("DELETE", `/api/runs/${runId}`);
    });

    await check("a literal credential is masked by variable name", async () => {
      const created = await api("POST", "/api/runs", {
        scriptKey: "echo",
        variables: { username: "operator", password: "literal-password-value" },
      });
      await api("POST", `/api/runs/${created.payload.data.runId}/cancel`);
      await waitFor(created.payload.data.runId);
      const stored = await api("GET", `/api/runs/${created.payload.data.runId}`);
      assert(stored.payload.data.request.variables.password === "***",
        `stored ${stored.payload.data.request.variables.password}`);
      assert(stored.payload.data.request.variables.username === "operator", "a harmless name was masked");
      await api("DELETE", `/api/runs/${created.payload.data.runId}`);
    });

    await check("a missing secret is reported instead of running with a blank", async () => {
      const { status, payload } = await api("POST", "/api/runs", {
        scriptKey: "echo",
        variables: { username: "x", password: "{{secret.not-provisioned}}" },
      });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "SECRET_NOT_FOUND", payload.error.code);
      assert(payload.error.message.includes("not-provisioned"), payload.error.message);
    });

    await check("a dataset queues one run per row, each with its own values", async () => {
      await api("PUT", "/api/datasets/orders", {
        rows: [{ sku: "ABC-1", qty: "1" }, { sku: "ABC-2", qty: "5" }, { sku: "ABC-3", qty: "9" }],
      });
      const listed = await api("GET", "/api/datasets");
      const entry = listed.payload.data.datasets.find((item) => item.name === "orders");
      assert(entry.rowCount === 3, `rowCount ${entry.rowCount}`);
      assert(entry.columns.includes("sku"), JSON.stringify(entry.columns));
      // The listing must not carry the rows themselves.
      assert(entry.rows === undefined, "the dataset listing returned its rows");

      const created = await api("POST", "/api/runs", { scriptKey: "echo", environment: "staging", dataset: "orders" });
      assert(created.status === 201, `returned ${created.status}`);
      assert(created.payload.data.rowCount === 3, `queued ${created.payload.data.rowCount} runs`);

      const runIds = created.payload.data.runs.map((run) => run.runId);
      assert(new Set(runIds).size === 3, "duplicate run ids");
      const rows = created.payload.data.runs.map((run) => run.request.variables.sku);
      assert(new Set(rows).size === 3, `rows not distinct: ${rows.join(", ")}`);

      for (const runId of runIds) {
        const finished = await waitFor(runId);
        assert(finished.status === "completed", `row run ${finished.status}`);
        assert(finished.datasetRow !== null, "the run does not record which row it came from");
      }
      for (const runId of runIds) {
        await api("DELETE", `/api/runs/${runId}`);
      }
    });

    await check("one dataset row can be selected, and a bad index is rejected", async () => {
      const single = await api("POST", "/api/runs", { scriptKey: "echo", dataset: "orders", datasetRow: 1, variables: { username: "x" } });
      assert(single.payload.data.rowCount === 1, `queued ${single.payload.data.rowCount}`);
      assert(single.payload.data.runs[0].request.variables.sku === "ABC-2", "the wrong row was used");
      await api("POST", `/api/runs/${single.payload.data.runs[0].runId}/cancel`);
      await waitFor(single.payload.data.runs[0].runId);
      await api("DELETE", `/api/runs/${single.payload.data.runs[0].runId}`);

      const bad = await api("POST", "/api/runs", { scriptKey: "echo", dataset: "orders", datasetRow: 99 });
      assert(bad.status === 400, `expected 400, got ${bad.status}`);
      assert(bad.payload.error.code === "DATASET_ROW_NOT_FOUND", bad.payload.error.code);
    });

    await check("environment and dataset names cannot escape their directory", async () => {
      for (const [label, response] of [
        ["environment", await api("PUT", "/api/environments/..%2F..%2Fpwned", { baseURL: "http://x" })],
        ["dataset", await api("PUT", "/api/datasets/..%2F..%2Fpwned", { rows: [{ a: "1" }] })],
      ]) {
        assert(response.status === 400, `${label} traversal returned ${response.status}`);
        assert(["INVALID_NAME", "PATH_OUTSIDE_ROOT"].includes(response.payload.error.code),
          `${label}: ${response.payload.error.code}`);
      }
    });
  } catch (error) {
    record("environment and dataset checks", "fail", error.message);
  } finally {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.on("exit", resolve));
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

async function runOutcomeChecks() {
  let stub;
  let sessionId;
  try {
    stub = await startBusinessStub();
  } catch (error) {
    record("outcome verification checks", "fail", error.message);
    return;
  }

  try {
    const session = await call("POST", "/api/sessions", {});
    if (session.status !== 201) {
      const message = session.payload?.error?.message || `HTTP ${session.status}`;
      if (/Executable doesn't exist|playwright install/i.test(message) && !requireBrowser) {
        record("outcome verification checks", "skip", "no Playwright browser installed");
        return;
      }
      record("outcome verification checks", "fail", message.split("\n")[0]);
      return;
    }

    sessionId = session.payload.data.sessionId;
    const contextId = (await call("POST", `/api/sessions/${sessionId}/contexts`, { baseURL: stub.baseUrl }))
      .payload.data.contextId;
    const pageId = (await call("POST", `/api/sessions/${sessionId}/contexts/${contextId}/pages`, {}))
      .payload.data.pageId;

    const submitSteps = [
      { action: "goto", url: `${stub.baseUrl}/` },
      { action: "click", locator: { testId: "submit" } },
      { action: "assertText", locator: { testId: "status" }, expected: "Submitted", timeoutMs: 5000 },
      { action: "locatorQuery", locator: { testId: "reference" }, operation: "textContent", saveAs: "ref" },
    ];

    await check("one batch can submit, capture the reference, and verify it against the API", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          ...submitSteps,
          { action: "assertValue", value: "{{ref}}", expected: "/^ORD-\\d+$/", match: "equals" },
          { action: "assertApiResponse", url: "/api/orders/{{ref}}", status: 200, jsonPath: "data.order.status", expected: "ACCEPTED" },
        ],
      });
      assert(status === 200, `execute returned ${status}: ${JSON.stringify(payload.error)}`);
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
      assert(/^ORD-\d+$/.test(payload.data.captured.ref), `captured ${JSON.stringify(payload.data.captured)}`);

      const apiStep = payload.data.results.find((entry) => entry.action === "assertApiResponse");
      assert(apiStep.result.status === 200, `api step status ${apiStep.result.status}`);
      // The request goes through the context, so it carries its cookies.
      assert(apiStep.result.artifact?.artifactId, "the response body was not kept as evidence");
    });

    await check("a download is captured and its contents checked", async () => {
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          ...submitSteps,
          { action: "click", locator: { testId: "receipt" } },
          {
            action: "assertDownload",
            fileName: "{{ref}}",
            minBytes: 10,
            jsonPath: "data.order.reference",
            expected: "{{ref}}",
            timeoutMs: 15000,
          },
        ],
      });
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
      const downloadStep = payload.data.results.find((entry) => entry.action === "assertDownload");
      assert(downloadStep.result.sizeBytes > 10, `download was ${downloadStep.result.sizeBytes} bytes`);

      // Downloads used to be accepted and then discarded with no way to reach them.
      const listed = await call("GET", `/api/sessions/${sessionId}/downloads`);
      assert(listed.payload.data.downloads.length > 0, "the download was not recorded");
      const entry = listed.payload.data.downloads.at(-1);
      assert(entry.downloadPath, "no download path");
      const fetched = await fetch(`${baseUrl}${entry.downloadPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(fetched.ok, `fetching the download returned ${fetched.status}`);
      const body = await fetched.json();
      assert(body.data.order.reference === payload.data.captured.ref, "the downloaded file is not the expected one");
    });

    // Every one of these must fail. An assertion that cannot fail is worse than
    // no assertion, and the first version of this feature threw a ReferenceError
    // on the error path, which only a negative case exposes.
    const mustFail = [
      ["a wrong jsonPath value", { action: "assertApiResponse", url: "/api/orders/{{ref}}", jsonPath: "data.order.status", expected: "REJECTED" }, "API_ASSERTION_FAILED"],
      ["a record that does not exist", { action: "assertApiResponse", url: "/api/orders/NOPE", status: 200 }, "API_ASSERTION_FAILED"],
      ["an absent jsonPath", { action: "assertApiResponse", url: "/api/orders/{{ref}}", jsonPath: "data.order.missingField" }, "API_ASSERTION_FAILED"],
      ["a captured value mismatch", { action: "assertValue", value: "{{ref}}", expected: "ORD-does-not-exist" }, "VALUE_ASSERTION_FAILED"],
      ["a download smaller than required", { action: "assertDownload", minBytes: 1000000, timeoutMs: 3000 }, "DOWNLOAD_ASSERTION_FAILED"],
      ["a download missing expected text", { action: "assertDownload", contains: "TOTALLY-ABSENT", timeoutMs: 3000 }, "DOWNLOAD_ASSERTION_FAILED"],
      ["an unsupported method", { action: "apiRequest", method: "TRACE", url: "/api/orders/{{ref}}" }, "INVALID_REQUEST"],
    ];

    for (const [label, step, expectedCode] of mustFail) {
      await check(`outcome assertions reject ${label}`, async () => {
        const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
          pageId,
          steps: [...submitSteps, { action: "click", locator: { testId: "receipt" } }, step],
        });
        assert(status >= 400, `the assertion passed when it should have failed (HTTP ${status})`);
        assert(payload.error.code === expectedCode,
          `expected ${expectedCode}, got ${payload.error.code}: ${payload.error.message}`);
        // The failure has to name which step broke, not just that something did.
        assert(payload.error.details?.failedStepIndex !== undefined, "no failedStepIndex in the error details");
      });
    }

    await check("capturing a value before the page produces it is reported, not substituted as empty", async () => {
      // Without the guard this substituted "" and produced a confusing 404 from
      // "/api/orders/" instead of naming the real problem.
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "goto", url: `${stub.baseUrl}/` },
          { action: "click", locator: { testId: "submit" } },
          { action: "locatorQuery", locator: { testId: "reference" }, operation: "textContent", saveAs: "ref" },
          { action: "assertApiResponse", url: "/api/orders/{{ref}}", status: 200 },
        ],
      });
      assert(status === 422, `expected 422, got ${status}`);
      assert(payload.error.code === "EMPTY_CAPTURED_VALUE", payload.error.code);
    });

    await check("an unknown {{reference}} is rejected before anything runs", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{ action: "assertValue", value: "{{neverCaptured}}", expected: "x" }],
      });
      assert(status === 400, `expected 400, got ${status}`);
      assert(payload.error.code === "UNKNOWN_CAPTURED_VALUE", payload.error.code);
    });

    await check("a context request is reachable on its own and kept as evidence", async () => {
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/contexts/${contextId}/request`, {
        method: "POST",
        url: "/api/orders",
      });
      assert(status === 200, `request returned ${status}`);
      assert(payload.data.ok === true, `response not ok: ${payload.data.status}`);
      assert(payload.data.json?.reference, `no reference in ${payload.data.text}`);
      assert(payload.data.durationMs >= 0, `durationMs was ${payload.data.durationMs}`);
      assert(payload.data.artifact?.downloadPath, "the response body was not stored");
    });
  } catch (error) {
    record("outcome verification checks", "fail", error.message);
  } finally {
    if (sessionId) {
      await call("DELETE", `/api/sessions/${sessionId}`);
    }
    await stub.stop();
  }
}

// Suspended workflows live in memory with their whole program and captured
// values, so the number of them has to be bounded. Runs on its own instance
// because the limit is read at boot.
async function runApprovalLimitChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-gates-"));
  const gatesPort = port + 7;
  const gatesUrl = `http://127.0.0.1:${gatesPort}`;
  const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(gatesPort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: path.join(dataDir, "scripts"),
      RUNS_DIR: path.join(dataDir, "runs"),
      ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
      DATA_DIR: path.join(dataDir, "data"),
      SCHEDULE_TICK_MS: "0",
      MAX_PENDING_APPROVALS: "2",
    },
  });

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${gatesUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  try {
    await waitForHealth(gatesUrl);
    const session = await api("POST", "/api/sessions", {});
    if (session.status !== 201) {
      const message = session.payload?.error?.message || `HTTP ${session.status}`;
      if (/Executable doesn't exist|playwright install/i.test(message) && !requireBrowser) {
        record("approval limit checks", "skip", "no Playwright browser installed");
        return;
      }
      record("approval limit checks", "fail", message.split("\n")[0]);
      return;
    }

    const sessionId = session.payload.data.sessionId;
    const contextId = (await api("POST", `/api/sessions/${sessionId}/contexts`, {})).payload.data.contextId;
    const pageId = (await api("POST", `/api/sessions/${sessionId}/contexts/${contextId}/pages`, {})).payload.data.pageId;
    await api("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${gatesUrl}/demo/test-page` });

    await check("waiting workflows cannot pile up without bound", async () => {
      const gate = (name) => api("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{ action: "approval", name }],
      });

      const first = await gate("one");
      const second = await gate("two");
      assert(first.payload.data.status === "awaiting_approval", JSON.stringify(first.payload.data.status));
      assert(second.payload.data.status === "awaiting_approval", JSON.stringify(second.payload.data.status));

      const third = await gate("three");
      assert(third.status === 429, `expected 429, got ${third.status}`);
      assert(third.payload.error.code === "APPROVAL_LIMIT_EXCEEDED", third.payload.error.code);

      // Deciding one frees the slot, so the limit is a queue depth and not a
      // dead end.
      const gateId = first.payload.data.approval.gateId;
      await api("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
        decision: "approve", decidedBy: "kim@example.com",
      });
      await api("POST", `/api/sessions/${sessionId}/execute/resume`, { gateId });
      const fourth = await gate("four");
      assert(fourth.payload.data.status === "awaiting_approval", JSON.stringify(fourth.payload));
    });

    await api("DELETE", `/api/sessions/${sessionId}`);
  } finally {
    proc.kill("SIGTERM");
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

// A pinned script used to be one file copied by basename, so a spec importing a
// sibling module could not run and a key with a directory lost its path. Runs on
// its own instance because it needs a scripts directory with a module graph.
async function runScriptBundleChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-bundle-"));
  const scriptsDir = path.join(dataDir, "scripts");
  await fsPromises.mkdir(path.join(scriptsDir, "auth"), { recursive: true });
  await fsPromises.mkdir(path.join(scriptsDir, "nested"), { recursive: true });

  // A secret beside the scripts directory, which no script may drag in.
  await fsPromises.writeFile(path.join(dataDir, "outside.js"), 'export const leaked = "SHOULD-NOT-BE-COPIED";\n', "utf8");
  await fsPromises.writeFile(
    path.join(scriptsDir, "helpers.js"),
    'export const greeting = "from the helper";\nexport { extra } from "./nested/extra.js";\n',
    "utf8",
  );
  await fsPromises.writeFile(path.join(scriptsDir, "nested", "extra.js"), "export const extra = 7;\n", "utf8");
  await fsPromises.writeFile(
    path.join(scriptsDir, "auth", "login.spec.js"),
    'import { test, expect } from "@playwright/test";\n'
    + 'import { greeting, extra } from "../helpers.js";\n'
    // A commented-out import is why an unresolvable specifier is recorded
    // rather than raised: a regex over JavaScript cannot tell the difference.
    + '// import { gone } from "./not-here.js";\n'
    + 'test("uses a sibling helper", async ({ page }) => {\n'
    + '  await page.goto("data:text/html,<h1>" + greeting + " " + extra + "</h1>");\n'
    + '  await expect(page.getByRole("heading")).toContainText("from the helper 7");\n'
    + "});\n",
    "utf8",
  );
  await fsPromises.writeFile(
    path.join(scriptsDir, "escape.spec.js"),
    'import { test, expect } from "@playwright/test";\n'
    + 'import { leaked } from "../outside.js";\n'
    + 'test("reaches outside", async () => { expect(leaked).toBeTruthy(); });\n',
    "utf8",
  );
  await fsPromises.writeFile(path.join(scriptsDir, "cycle-a.js"), 'import "./cycle-b.js";\nexport const a = 1;\n', "utf8");
  await fsPromises.writeFile(path.join(scriptsDir, "cycle-b.js"), 'import "./cycle-a.js";\nexport const b = 2;\n', "utf8");
  await fsPromises.writeFile(
    path.join(scriptsDir, "cycle.spec.js"),
    'import { test, expect } from "@playwright/test";\n'
    + 'import { a } from "./cycle-a.js";\n'
    + 'test("cycle", async () => { expect(a).toBe(1); });\n',
    "utf8",
  );

  const bundlePort = port + 8;
  const bundleUrl = `http://127.0.0.1:${bundlePort}`;
  const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(bundlePort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: scriptsDir,
      RUNS_DIR: path.join(dataDir, "runs"),
      ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
      DATA_DIR: path.join(dataDir, "data"),
      SCHEDULE_TICK_MS: "0",
      MAX_CONCURRENT_RUNS: "2",
    },
  });

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${bundleUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const settle = async (runId) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = (await api("GET", `/api/runs/${runId}`)).payload.data.status;
      if (status !== "running" && status !== "queued") {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return "timed-out";
  };

  try {
    await waitForHealth(bundleUrl);

    await check("a script that imports a sibling module runs", async () => {
      const keys = (await api("GET", "/api/scripts")).payload.data.scripts.map((script) => script.scriptKey);
      assert(keys.includes("auth/login"), `a nested key lost its path: ${keys.join(", ")}`);

      const created = await api("POST", "/api/runs", { scriptKey: "auth/login", project: "chromium" });
      const runId = created.payload.data.runId;
      const status = await settle(runId);
      if (status !== "completed") {
        const logs = (await api("GET", `/api/runs/${runId}/logs`)).payload.data.logs.map((entry) => entry.line).join("\n");
        if (/Executable doesn't exist|playwright install/i.test(logs) && !requireBrowser) {
          record("script bundle checks", "skip", "no Playwright browser installed");
          return "skip";
        }
        assert(false, `run ${status}: ${logs.split("\n").slice(0, 3).join(" | ")}`);
      }

      const run = (await api("GET", `/api/runs/${runId}`)).payload.data;
      const pinned = (run.script.files || []).map((file) => file.relativePath).sort();
      // The pin only means something if it covers everything the run loads: a
      // helper edited between two runs would otherwise be invisible.
      assert(
        JSON.stringify(pinned) === JSON.stringify(["auth/login.spec.js", "helpers.js", "nested/extra.js"]),
        JSON.stringify(pinned),
      );
      assert(typeof run.script.bundleSha256 === "string" && run.script.bundleSha256.length === 64,
        String(run.script.bundleSha256));

      const snapshot = (await api("GET", `/api/runs/${runId}/artifacts`)).payload.data.artifacts
        .map((artifact) => artifact.relativePath)
        .filter((relativePath) => relativePath.startsWith("script/"))
        .sort();
      assert(
        JSON.stringify(snapshot) === JSON.stringify([
          "script/auth/login.spec.js", "script/helpers.js", "script/nested/extra.js",
        ]),
        JSON.stringify(snapshot),
      );

      // A commented-out import still matches the scanner, so an unresolvable
      // specifier is reported instead of refusing to queue a working script.
      assert(
        JSON.stringify(run.script.unresolvedImports) === '[{"from":"auth/login.spec.js","specifier":"./not-here.js"}]',
        JSON.stringify(run.script.unresolvedImports),
      );
      return undefined;
    });

    await check("an import reaching outside SCRIPTS_DIR is not snapshotted", async () => {
      const created = await api("POST", "/api/runs", { scriptKey: "escape", project: "chromium" });
      const runId = created.payload.data.runId;
      await settle(runId);
      const run = (await api("GET", `/api/runs/${runId}`)).payload.data;
      const pinned = (run.script.files || []).map((file) => file.relativePath);
      assert(JSON.stringify(pinned) === JSON.stringify(["escape.spec.js"]), JSON.stringify(pinned));
      assert(
        JSON.stringify(run.script.unresolvedImports) === '[{"from":"escape.spec.js","specifier":"../outside.js"}]',
        JSON.stringify(run.script.unresolvedImports),
      );
      const snapshot = (await api("GET", `/api/runs/${runId}/artifacts`)).payload.data.artifacts
        .map((artifact) => artifact.relativePath)
        .filter((relativePath) => relativePath.startsWith("script/"));
      assert(JSON.stringify(snapshot) === JSON.stringify(["script/escape.spec.js"]), JSON.stringify(snapshot));
    });

    await check("a circular import does not hang the snapshot walker", async () => {
      const created = await api("POST", "/api/runs", { scriptKey: "cycle", project: "chromium" });
      const runId = created.payload.data.runId;
      const status = await settle(runId);
      const run = (await api("GET", `/api/runs/${runId}`)).payload.data;
      const pinned = (run.script.files || []).map((file) => file.relativePath).sort();
      assert(
        JSON.stringify(pinned) === JSON.stringify(["cycle-a.js", "cycle-b.js", "cycle.spec.js"]),
        JSON.stringify(pinned),
      );
      if (status !== "completed" && requireBrowser) {
        assert(false, `cycle run ${status}`);
      }
    });
  } finally {
    proc.kill("SIGTERM");
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

async function runRetentionChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-retain-"));
  const scriptsDir = path.join(dataDir, "scripts");
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(scriptsDir, "retain.spec.js"),
    "import { test, expect } from \"@playwright/test\";\n\ntest(\"retain\", async () => {\n  expect(1).toBe(1);\n});\n",
    "utf8",
  );

  const retainPort = port + 3;
  const retainUrl = `http://127.0.0.1:${retainPort}`;
  const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(retainPort),
      HOST: "127.0.0.1",
      SCRIPTS_DIR: scriptsDir,
      RUNS_DIR: path.join(dataDir, "runs"),
      ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
      STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
      MAX_CONCURRENT_RUNS: "1",
      MAX_RETAINED_RUNS: "2",
    },
  });

  const api = async (method, urlPath, body) => {
    const response = await fetch(`${retainUrl}${urlPath}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  try {
    await waitForHealth(retainUrl);

    await check("retention never prunes a run that is still queued", async () => {
      // Four runs, one slot, retention of two: pruning is forced to happen while
      // other runs are still waiting. `status !== "running"` used to match
      // "queued" too, so those waiting runs were deleted out from under the queue.
      const created = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await api("POST", "/api/runs", { scriptKey: "retain", project: "chromium" });
        assert(response.status === 201, `create ${index} returned ${response.status}`);
        created.push(response.payload.data.runId);
      }

      // Waiting for every run to finish is slow and unnecessary; the invariant
      // only concerns runs while they are queued.
      const deadline = Date.now() + 300_000;
      const seenQueued = new Set();
      let pending = new Set(created);
      while (pending.size && Date.now() < deadline) {
        for (const runId of [...pending]) {
          const { status, payload } = await api("GET", `/api/runs/${runId}`);
          assert(status === 200, `run ${runId} disappeared from history while queued (HTTP ${status})`);
          if (payload.data.status === "queued") {
            seenQueued.add(runId);
          } else {
            pending.delete(runId);
          }
        }
        if (pending.size) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      assert(pending.size === 0, `runs never left the queue: ${[...pending].join(", ")}`);
      assert(seenQueued.size >= 2, `only ${seenQueued.size} runs were ever queued; pruning was not exercised`);

      // Retention really did fire: with a cap of two, the earliest finished runs
      // must be gone even though later ones were queued the whole time.
      const remaining = await api("GET", "/api/runs?limit=500");
      assert(remaining.payload.data.total <= 3,
        `retention did not prune: ${remaining.payload.data.total} records kept with MAX_RETAINED_RUNS=2`);

      const missing = [];
      for (const runId of created) {
        const { status } = await api("GET", `/api/runs/${runId}`);
        if (status === 404) {
          missing.push(runId);
        }
      }
      assert(missing.length > 0, "nothing was pruned, so the regression could not have been detected");
    });

  } catch (error) {
    record("retention never prunes a run that is still queued", "fail", error.message);
  } finally {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.on("exit", resolve));
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

// URL_ALLOWLIST was enforced on session browsers but not on script runs, which
// are separate processes - the one security asymmetry left after v0.3.0.
//
// Two instances, because the policy checks need a generous RUN_TIMEOUT_MS while
// the timeout check needs a short one, and that setting is per server.
async function runWorkerIsolationChecks() {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pw-player-worker-"));
  const scriptsDir = path.join(dataDir, "scripts");
  await fsPromises.mkdir(scriptsDir, { recursive: true });

  const workerPort = port + 4;
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  await fsPromises.writeFile(
    path.join(scriptsDir, "netprobe.spec.js"),
    [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("reaches outside the policy", async ({ page }) => {',
      '  const outside = await page.goto("http://blocked.example/").then(',
      '    (response) => `status ${response?.status()}`,',
      // No backslash escapes in generated fixtures: a \n here becomes a real
      // newline and breaks the string literal in the file that gets written.
      '    (error) => `error ${String(error).slice(0, 80)}`,',
      "  );",
      "  console.log(`PROBE_OUTSIDE=${outside}`);",
      "",
      `  await page.goto("${workerUrl}/demo/test-page");`,
      '  await expect(page.getByTestId("status")).toBeVisible();',
      '  console.log("PROBE_LOOPBACK=ok");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsPromises.writeFile(
    path.join(scriptsDir, "hang.spec.js"),
    [
      'import { test } from "@playwright/test";',
      "",
      'test("hangs well past the run timeout", async () => {',
      "  test.setTimeout(0);",
      "  await new Promise((resolve) => setTimeout(resolve, 600000));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const spawnWorker = async (extraEnv, instancePort) => {
    const proc = spawn(process.execPath, [path.join(rootDir, "server.js")], {
      cwd: rootDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PORT: String(instancePort),
        HOST: "127.0.0.1",
        SCRIPTS_DIR: scriptsDir,
        RUNS_DIR: path.join(dataDir, `runs-${instancePort}`),
        ARTIFACTS_DIR: path.join(dataDir, `artifacts-${instancePort}`),
        STORAGE_STATE_DIR: path.join(dataDir, "storage-states"),
        ...extraEnv,
      },
    });
    const instanceUrl = `http://127.0.0.1:${instancePort}`;
    await waitForHealth(instanceUrl);

    const api = async (method, urlPath, body) => {
      const response = await fetch(`${instanceUrl}${urlPath}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    };

    const waitFor = async (runId, timeoutMs = 240_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { payload } = await api("GET", `/api/runs/${runId}`);
        if (["completed", "failed", "cancelled", "interrupted"].includes(payload.data.status)) {
          return payload.data;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`run ${runId} never finished`);
    };

    return {
      api,
      waitFor,
      async stop() {
        proc.kill("SIGKILL");
        await new Promise((resolve) => proc.on("exit", resolve));
      },
    };
  };

  // --- instance A: the network policy -------------------------------------
  let policy;
  try {
    policy = await spawnWorker(
      { URL_ALLOWLIST: "allowed.example", RUN_TIMEOUT_MS: "300000" },
      workerPort,
    );
  } catch (error) {
    record("worker isolation checks", "fail", error.message);
    await fsPromises.rm(dataDir, { recursive: true, force: true });
    return;
  }

  try {
    await check("health reports that the allowlist covers runs, not just sessions", async () => {
      const { payload } = await policy.api("GET", "/health");
      const coverage = payload.data.features.urlAllowlistCoverage;
      assert(coverage.includes("sessions") && coverage.includes("runs"), JSON.stringify(coverage));
    });

    await check("a per-run allowlist can narrow the policy but never widen it", async () => {
      const { payload } = await policy.api("POST", "/api/runs", {
        scriptKey: "netprobe",
        project: "chromium",
        urlAllowlist: ["evil.example", "*.evil.example", "allowed.example"],
      });
      const network = payload.data.network;
      assert(network.allowlist.length === 1 && network.allowlist[0] === "allowed.example",
        `effective policy widened: ${JSON.stringify(network.allowlist)}`);
      assert(network.rejectedAllowlistEntries.includes("evil.example"), JSON.stringify(network.rejectedAllowlistEntries));
      assert(network.rejectedAllowlistEntries.includes("*.evil.example"), "wildcard widening was accepted");
      await policy.api("POST", `/api/runs/${payload.data.runId}/cancel`);
      await policy.waitFor(payload.data.runId);
      await policy.api("DELETE", `/api/runs/${payload.data.runId}`);
    });

    await check("a script run cannot reach a host outside the allowlist", async () => {
      const created = await policy.api("POST", "/api/runs", { scriptKey: "netprobe", project: "chromium" });
      const runId = created.payload.data.runId;
      assert(created.payload.data.network.enforced === true, "the run reported no network policy");

      const finished = await policy.waitFor(runId);
      const logs = await policy.api("GET", `/api/runs/${runId}/logs`);
      const text = logs.payload.data.logs.map((entry) => entry.line).join("\n");

      // The proxy answers 403, so the navigation resolves rather than erroring.
      assert(/PROBE_OUTSIDE=status 403/.test(text), `the run reached outside the policy: ${text.slice(0, 400)}`);
      // Loopback has to keep working or the policy is unusable for local targets.
      assert(text.includes("PROBE_LOOPBACK=ok"), `loopback was blocked too: ${text.slice(0, 400)}`);
      assert(finished.status === "completed", `run ${finished.status}: ${text.slice(0, 400)}`);

      const network = finished.network;
      assert(network.blockedRequests >= 1, `guard recorded ${network.blockedRequests} blocked requests`);
      assert(network.blocked.some((entry) => entry.host === "blocked.example"),
        `blocked list did not name the host: ${JSON.stringify(network.blocked)}`);
      assert(!network.proxyUrl || network.proxyUrl.startsWith("http://127.0.0.1:"),
        `the guard proxy must be loopback-only: ${network.proxyUrl}`);

      await policy.api("DELETE", `/api/runs/${runId}`);
    });
  } catch (error) {
    record("worker isolation checks", "fail", error.message);
  } finally {
    await policy.stop();
  }

  // --- instance B: the run wall-clock limit --------------------------------
  let timeout;
  try {
    timeout = await spawnWorker({ RUN_TIMEOUT_MS: "25000" }, workerPort + 1);

    await check("a hung run is killed and releases its slot", async () => {
      const created = await timeout.api("POST", "/api/runs", { scriptKey: "hang", project: "chromium" });
      const runId = created.payload.data.runId;
      const started = Date.now();
      const finished = await timeout.waitFor(runId, 120_000);
      const elapsed = Date.now() - started;

      assert(finished.status === "failed", `expected failed, got ${finished.status}`);
      assert(/RUN_TIMEOUT_MS/.test(finished.interruptedReason || ""), finished.interruptedReason);
      assert(elapsed < 90_000, `took ${elapsed}ms; the timeout should have fired at 25000ms`);

      const queue = await timeout.api("GET", "/api/queue");
      assert(queue.payload.data.running === 0, `${queue.payload.data.running} runs still hold a slot`);
    });
  } catch (error) {
    record("a hung run is killed and releases its slot", "fail", error.message);
  } finally {
    if (timeout) {
      await timeout.stop();
    }
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  }
}

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

  await check("health reports the version in package.json", async () => {
    // A hand-edited version constant shipped v0.13.0 reporting "0.12.0".
    const declared = JSON.parse(await fsPromises.readFile(path.join(rootDir, "package.json"), "utf8")).version;
    const { payload } = await call("GET", "/health", undefined, { auth: false });
    assert(payload.data.version === declared, `/health says ${payload.data.version}, package.json says ${declared}`);
  });

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

  await check("excess runs queue instead of being rejected, and the limit holds", async () => {
    // MAX_CONCURRENT_RUNS is 2 for this harness. Every request is accepted; the
    // ones that cannot start yet wait in the queue.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" })),
    );
    assert(responses.every((entry) => entry.status === 201),
      `not all accepted: ${JSON.stringify(responses.map((entry) => entry.status))}`);

    const running = responses.filter((entry) => entry.payload.data.status === "running");
    const queued = responses.filter((entry) => entry.payload.data.status === "queued");
    assert(running.length <= 2, `${running.length} started at once, limit is 2`);
    assert(queued.length === 6 - running.length, "the rest should be queued");

    const snapshot = await call("GET", "/api/queue");
    assert(snapshot.payload.data.running <= 2, `queue reports ${snapshot.payload.data.running} running`);
    assert(snapshot.payload.data.entries.every((entry, index) => entry.position === index),
      "queue positions must be contiguous");

    const runIds = responses.map((entry) => entry.payload.data.runId);
    await waitForRuns(runIds);
    for (const runId of runIds) {
      await call("DELETE", `/api/runs/${runId}`);
    }
  });

  await check("a queued run can be cancelled before it starts", async () => {
    const created = await Promise.all(
      Array.from({ length: 4 }, () => call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" })),
    );
    const queued = created.find((entry) => entry.payload.data.status === "queued");
    assert(queued, "nothing was queued, cannot exercise the cancel path");

    const runId = queued.payload.data.runId;
    const cancelled = await call("POST", `/api/runs/${runId}/cancel`);
    assert(cancelled.payload.data.status === "cancelled", cancelled.payload.data.status);

    const after = await call("GET", `/api/runs/${runId}`);
    assert(after.payload.data.status === "cancelled", after.payload.data.status);
    assert(after.payload.data.startedAt === null, "a cancelled queued run must never have started");

    const queueNow = await call("GET", "/api/queue");
    assert(!queueNow.payload.data.entries.some((entry) => entry.runId === runId), "still in the queue");

    const runIds = created.map((entry) => entry.payload.data.runId);
    await waitForRuns(runIds);
    for (const id of runIds) {
      await call("DELETE", `/api/runs/${id}`);
    }
  });

  await check("higher priority runs ahead of what is already waiting", async () => {
    const filler = await Promise.all(
      Array.from({ length: 4 }, () => call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" })),
    );
    const urgent = await call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium", priority: 10 });
    const snapshot = await call("GET", "/api/queue");
    const entries = snapshot.payload.data.entries;
    assert(entries.length > 1, "need a queue to test ordering");
    assert(entries[0].runId === urgent.payload.data.runId,
      `priority 10 sat at position ${entries.findIndex((entry) => entry.runId === urgent.payload.data.runId)}`);

    const runIds = [...filler.map((entry) => entry.payload.data.runId), urgent.payload.data.runId];
    for (const runId of runIds) {
      await call("POST", `/api/runs/${runId}/cancel`);
    }
    await waitForRuns(runIds);
    for (const runId of runIds) {
      await call("DELETE", `/api/runs/${runId}`);
    }
  });

  await check("a run pins the script it was queued with", async () => {
    await call("PUT", "/api/scripts/pinned", {
      content: "import { test, expect } from \"@playwright/test\";\n\ntest(\"original\", async () => { expect(1).toBe(1); });\n",
    });
    const created = await call("POST", "/api/runs", { scriptKey: "pinned", project: "chromium" });
    const runId = created.payload.data.runId;
    const pinned = created.payload.data.script;
    assert(pinned?.sha256, "no script hash recorded");

    // Change the file out from under the run.
    await call("PUT", "/api/scripts/pinned", {
      content: "import { test, expect } from \"@playwright/test\";\n\ntest(\"edited\", async () => { expect(2).toBe(2); });\n",
    });

    await waitForRuns([runId]);
    const finished = await call("GET", `/api/runs/${runId}`);
    assert(finished.payload.data.script.sha256 === pinned.sha256, "the recorded hash changed");
    const titles = finished.payload.data.tests.map((entry) => entry.title).join(" ");
    assert(titles.includes("original"), `the run used the edited script: ${titles}`);

    await call("DELETE", `/api/runs/${runId}`);
    await call("DELETE", "/api/scripts/pinned");
  });

  await check("a finished run can be retried as a new run", async () => {
    const created = await call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" });
    const runId = created.payload.data.runId;
    await waitForRuns([runId]);

    const retried = await call("POST", `/api/runs/${runId}/retry`);
    assert(retried.status === 201, `retry returned ${retried.status}`);
    assert(retried.payload.data.runId !== runId, "retry must create a new run");
    assert(retried.payload.data.retryOf === runId, retried.payload.data.retryOf);
    assert(retried.payload.data.attempt === 2, `attempt=${retried.payload.data.attempt}`);

    await waitForRuns([retried.payload.data.runId]);
    const original = await call("GET", `/api/runs/${runId}`);
    assert(original.status === 200, "the original run must survive a retry");

    await call("DELETE", `/api/runs/${runId}`);
    await call("DELETE", `/api/runs/${retried.payload.data.runId}`);
  });

  await check("run bookkeeping is not served as an artifact", async () => {
    const created = await call("POST", "/api/runs", { scriptKey: "smoke", project: "chromium" });
    const runId = created.payload.data.runId;
    await waitForRuns([runId]);

    const artifacts = await call("GET", `/api/runs/${runId}/artifacts`);
    const names = artifacts.payload.data.artifacts.map((entry) => entry.relativePath);
    assert(!names.includes("run.json"), "run.json listed as an artifact");
    assert(!names.includes("logs.jsonl"), "logs.jsonl listed as an artifact");
    assert(names.includes("report.json"), "report.json should still be evidence");

    const blocked = await call("GET", `/api/runs/${runId}/artifacts/run.json`);
    assert(blocked.status === 400, `expected 400, got ${blocked.status}`);
    assert(blocked.payload.error.code === "NOT_AN_ARTIFACT", blocked.payload.error.code);

    await call("DELETE", `/api/runs/${runId}`);
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

  await check("a run records per-step durations and the step that failed", async () => {
    await call("PUT", "/api/scripts/timeline", {
      content: [
        'import { test, expect } from "@playwright/test";',
        "",
        'test("multi step", async ({ page }) => {',
        `  await page.goto("${baseUrl}/demo/test-page");`,
        '  await page.getByTestId("message-input").fill("timeline");',
        '  await page.getByTestId("send-message").click();',
        '  await expect(page.getByTestId("status")).toContainText("will not match", { timeout: 1500 });',
        "});",
        "",
      ].join("\n"),
    });

    const created = await call("POST", "/api/runs", { scriptKey: "timeline", project: "chromium" });
    const runId = created.payload.data.runId;
    await waitForRuns([runId]);

    const { payload } = await call("GET", `/api/runs/${runId}`);
    const test = payload.data.tests[0];
    assert(test, "no test result recorded");
    assert(test.status === "failed", `expected the test to fail, got ${test.status}`);

    // Playwright's json reporter emits no steps at all, so these come from a
    // reporter the server generates; without them "the test took 12s" says
    // nothing about which click or assertion was slow.
    const flatten = (steps) => (steps || []).flatMap((step) => [step, ...flatten(step.steps)]);
    const steps = flatten(test.steps);
    assert(steps.length > 0, "no steps recorded for the run");
    assert(steps.every((step) => step.durationMs === null || step.durationMs >= 0),
      `negative step duration: ${JSON.stringify(steps.filter((step) => step.durationMs < 0))}`);
    assert(steps.some((step) => typeof step.durationMs === "number" && step.durationMs > 0),
      "every step duration was null; the reporter output was dropped");

    assert(steps.some((step) => /Fill/i.test(step.title)), `no fill step: ${steps.map((s) => s.title).join(" | ")}`);
    assert(steps.some((step) => /Click/i.test(step.title)), "no click step");

    const failing = steps.find((step) => step.error);
    assert(failing, "the failing step was not identified");
    assert(/Expect/i.test(failing.title), `the error landed on the wrong step: ${failing.title}`);

    // Evidence for the failure, addressable through the run artifact route.
    assert((test.attachments || []).length > 0, "no attachments linked to the test");
    const screenshot = test.attachments.find((entry) => entry.name === "screenshot");
    assert(screenshot?.path, `no screenshot attachment: ${JSON.stringify(test.attachments)}`);
    const download = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/${screenshot.path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(download.ok, `attachment download returned ${download.status}`);

    await call("DELETE", `/api/runs/${runId}`);
    await call("DELETE", "/api/scripts/timeline");
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

  // A workflow is compiled before the session lock is taken, so these checks
  // need no browser: a malformed workflow comes back as a 400 either way.
  await check("a malformed workflow is rejected before any browser work", async () => {
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      steps: [{ action: "if", when: { value: "a", equals: "a" }, then: [] }],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "INVALID_STEP", payload.error.code);
    assert(/non-empty/.test(payload.error.message), payload.error.message);
  });

  await check("break outside a loop is rejected", async () => {
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      steps: [{ action: "break" }],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(/only valid inside/.test(payload.error.message), payload.error.message);
  });

  await check("a workflow nested past the depth limit is rejected", async () => {
    let node = { action: "click", locator: { testId: "x" } };
    for (let depth = 0; depth < 12; depth += 1) {
      node = { action: "repeat", times: 1, steps: [node] };
    }
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      steps: [node],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "WORKFLOW_TOO_DEEP", payload.error.code);
  });

  await check("a request cannot raise the server's loop limit", async () => {
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      limits: { maxIterations: 100000 },
      steps: [{ action: "repeat", times: 100000, maxIterations: 100000, steps: [{ action: "click", locator: { testId: "x" } }] }],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "LOOP_LIMIT_EXCEEDED", payload.error.code);
    // Silently running only the first 200 rows of a 100000-row loop would
    // report success for work that never happened.
    assert(/exceeds the limit of 200/.test(payload.error.message), payload.error.message);
  });

  await check("matches needs a regular expression literal, not a bare string", async () => {
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      variables: { code: "ORD-1" },
      steps: [{ action: "if", when: { value: "{{code}}", matches: "ORD" }, then: [{ action: "click", locator: { testId: "x" } }] }],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(payload.error.code === "INVALID_CONDITION", payload.error.code);
    assert(/regular expression literal/.test(payload.error.message), payload.error.message);
  });

  await check("a condition with two operators is rejected", async () => {
    const { status, payload } = await call("POST", "/api/sessions/no-such-session/execute", {
      pageId: "page_nothing",
      steps: [{ action: "if", when: { value: "a", equals: "a", contains: "a" }, then: [{ action: "click", locator: { testId: "x" } }] }],
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(/one operator at a time/.test(payload.error.message), payload.error.message);
  });

  await check("mcp session_execute advertises control flow and the approval loop", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const mcpSessionId = init.headers.get("mcp-session-id");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": mcpSessionId, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const tools = await response.json();
    const byName = new Map(tools.result.tools.map((tool) => [tool.name, tool]));
    const execute = byName.get("session_execute");
    const actions = execute.inputSchema.properties.steps.items.properties.action.enum;
    for (const action of ["if", "repeat", "forEach", "while", "break", "continue", "approval"]) {
      assert(actions.includes(action), `session_execute does not advertise ${action}`);
    }
    const stepProps = execute.inputSchema.properties.steps.items.properties;
    for (const field of ["when", "then", "else", "steps", "times", "items", "as"]) {
      assert(stepProps[field], `session_execute step schema is missing ${field}`);
    }
    // An agent that cannot find these three has no way to clear a gate.
    for (const name of ["session_approvals", "session_approval_decide", "session_execute_resume"]) {
      assert(byName.has(name), `mcp is missing ${name}`);
    }
    assert(byName.get("session_approval_decide").inputSchema.required.includes("decidedBy"),
      "a decision can be recorded without saying who made it");
  });

  await check("health reports the workflow limits and that gates do not survive a restart", async () => {
    const { payload } = await call("GET", "/health", undefined, { auth: false });
    assert(payload.data.limits.maxWorkflowIterations === 200, JSON.stringify(payload.data.limits));
    assert(payload.data.features.approvalGatesPersistAcrossRestart === false,
      JSON.stringify(payload.data.features.approvalGatesPersistAcrossRestart));
    assert(payload.data.features.workflowControlFlow.includes("approval"),
      JSON.stringify(payload.data.features.workflowControlFlow));
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

  // ---- schedules and callbacks ---------------------------------------------
  await runScheduleChecks();

  // ---- environments, datasets and secrets -----------------------------------
  await runEnvironmentChecks();

  // ---- outcome verification ------------------------------------------------
  await runOutcomeChecks();

  // ---- restart recovery and retention (need their own server instances) ----
  await runRestartChecks();
  await runRetentionChecks();
  await runApprovalLimitChecks();
  await runScriptBundleChecks();

  // ---- URL allowlist (needs its own server instance) -----------------------
  await runAllowlistChecks();
  await runWorkerIsolationChecks();

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

    await check("inspect reports real match counts, not just strategy confidence", async () => {
      // Three identical buttons plus one with a testId: role+name looks like a
      // 0.95-confidence locator for all four, but matches three of them.
      const fixture = "data:text/html," + encodeURIComponent(
        "<button>Save</button><button>Save</button><button>Save</button>"
        + "<button data-testid=\"only-save\">Save</button>"
        + "<label for=\"a\">Amount</label><input id=\"a\">"
        + "<label for=\"b\">Amount</label><input id=\"b\" data-testid=\"second\">",
      );
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: fixture });
      const { payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/inspect`, { maxElements: 20 });
      const data = payload.data;

      assert(data.locatorVerification, "no locatorVerification summary");
      assert(data.locatorVerification.errors === 0, `${data.locatorVerification.errors} candidates failed to evaluate`);

      const buttons = data.interactiveElements.filter((entry) => entry.tagName === "button");
      assert(buttons.length === 4, `expected 4 buttons, got ${buttons.length}`);
      assert(buttons.every((entry) => entry.locatorUnique),
        `not every button got a unique locator: ${JSON.stringify(buttons.map((b) => b.bestLocator))}`);

      // The one with a testId must keep it rather than fall back to an index.
      const tagged = buttons.find((entry) => entry.testId === "only-save");
      assert(tagged.bestLocator.testId === "only-save", JSON.stringify(tagged.bestLocator));
      assert(tagged.bestLocator.nth === undefined, "a uniquely identifiable element should not need nth");

      // The untagged ones are only distinguishable by position.
      const positional = buttons.filter((entry) => entry.bestLocator?.nth !== undefined);
      assert(positional.length === 3, `expected 3 nth-disambiguated buttons, got ${positional.length}`);
      assert(new Set(positional.map((entry) => entry.bestLocator.nth)).size === 3, "nth values must be distinct");

      // An ambiguous label must not win over a unique locator for the element.
      const firstInput = data.interactiveElements.find((entry) => entry.tagName === "input" && entry.id === "a");
      assert(firstInput.locatorUnique, JSON.stringify(firstInput.bestLocator));
      assert(firstInput.bestLocator.label === undefined, `ambiguous label was chosen: ${JSON.stringify(firstInput.bestLocator)}`);

      assert(!("domPath" in firstInput), "internal domPath must not be exposed as if it were a locator");
    });

    await check("every verified bestLocator actually resolves to one node", async () => {
      const { payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/inspect`, { maxElements: 20 });
      for (const element of payload.data.interactiveElements) {
        if (!element.locatorUnique) {
          continue;
        }
        const query = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/locator/query`, {
          locator: element.bestLocator,
          operation: "count",
        });
        assert(query.payload.data.count === 1,
          `${JSON.stringify(element.bestLocator)} matched ${query.payload.data.count}`);
      }
    });

    await check("a numeric id yields a usable CSS locator", async () => {
      // `#123abc` is a valid id but not a valid CSS selector, so it threw.
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
        url: "data:text/html," + encodeURIComponent('<button id="123abc" aria-label="numeric">x</button>'),
      });
      const { payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/inspect`, { maxElements: 5 });
      assert(payload.data.locatorVerification.errors === 0, "a candidate threw while being verified");
      const cssCandidates = payload.data.interactiveElements
        .flatMap((entry) => entry.locatorCandidates || [])
        .filter((entry) => entry.strategy === "css");
      assert(cssCandidates.length > 0, "no css candidate generated");
      assert(cssCandidates.every((entry) => !entry.locator.css.startsWith("#")),
        `raw #id selector emitted: ${JSON.stringify(cssCandidates.map((c) => c.locator.css))}`);
    });

    await check("verifyLocators can be turned off", async () => {
      const { payload } = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/inspect`, {
        maxElements: 5,
        verifyLocators: false,
      });
      assert(payload.data.locatorVerification === null, "verification ran when it was disabled");
    });

    await check("a dialog no longer blocks the click that opened it", async () => {
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${baseUrl}/demo/test-page` });
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

    await check("the session timeline reports a duration for every action", async () => {
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${baseUrl}/demo/test-page` });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/fill`, {
        locator: { testId: "message-input" },
        value: "timeline",
      });
      const { status, payload } = await call("GET", `/api/sessions/${sessionId}/timeline?includeEvents=false`);
      assert(status === 200, `timeline returned ${status}`);

      const timed = payload.data.entries.filter((entry) => typeof entry.durationMs === "number");
      assert(timed.length >= 2, `only ${timed.length} entries carried a duration`);
      // Durations came from Date.now(), which can step backwards and produced
      // negative values; a negative duration also sorted a failed step last in
      // "slowest", which is exactly backwards.
      assert(timed.every((entry) => entry.durationMs >= 0),
        `negative duration: ${JSON.stringify(timed.filter((entry) => entry.durationMs < 0))}`);
      assert(payload.data.totalDurationMs >= 0, `total was ${payload.data.totalDurationMs}`);
      assert(timed.every((entry) => entry.startedAt && entry.endedAt), "an entry had no start/end time");
    });

    await check("the timeline credits console and network errors to the action that caused them", async () => {
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${baseUrl}/demo/test-page` });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: 'async () => { console.error("boom from the page"); try { await fetch("/does-not-exist"); } catch (error) {} return 1; }',
      });
      const { payload } = await call("GET", `/api/sessions/${sessionId}/timeline`);

      const culprit = [...payload.data.entries].reverse().find((entry) => entry.type === "page.evaluate");
      assert(culprit, "the evaluate action is missing from the timeline");
      assert(culprit.issueCount > 0, "the evaluate action was credited with no issues");
      assert(culprit.issues.some((issue) => (issue.message || "").includes("boom from the page")),
        `console error not attributed: ${JSON.stringify(culprit.issues)}`);
      // The harness runs with API_TOKEN set, so an unauthenticated in-page fetch
      // is answered 401 rather than 404. Any 4xx/5xx proves the attribution.
      assert(culprit.issues.some((issue) => issue.type === "response" && Number(issue.status) >= 400),
        `failed request not attributed: ${JSON.stringify(culprit.issues)}`);

      // The surrounding actions must not inherit them.
      const neighbours = payload.data.entries.filter((entry) => entry.type === "page.goto");
      assert(neighbours.every((entry) => entry.issueCount === 0),
        "issues leaked onto a neighbouring action");
    });

    await check("a failing action links its artifacts and tops the slowest list", async () => {
      const before = await call("GET", `/api/sessions/${sessionId}/timeline?includeEvents=false`);
      const baseline = before.payload.data.failedCount;

      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/visible`, {
        locator: { testId: "definitely-not-here" },
        timeoutMs: 1200,
      });

      const { payload } = await call("GET", `/api/sessions/${sessionId}/timeline?includeEvents=false`);
      assert(payload.data.failedCount === baseline + 1, "the failure was not recorded");

      const failed = [...payload.data.entries].reverse().find((entry) => entry.status === "error");
      assert(failed, "no failed entry in the timeline");
      assert(failed.error, "the failed entry carries no error");
      assert((failed.artifacts || []).length >= 1,
        "the failure artifacts were not linked to the action that produced them");
      assert(failed.artifacts.every((artifact) => artifact.downloadPath), "an artifact had no downloadPath");

      // A ~1200ms timeout must rank above the millisecond-scale actions. With
      // the old wall-clock arithmetic it could land negative and sort last.
      assert(payload.data.slowest[0].durationMs >= 1000,
        `slowest was ${JSON.stringify(payload.data.slowest[0])}`);
    });

    // The built-in pages moved out of server.js into public/. "Returns 200" was
    // the only coverage they ever had, which would not notice a page that renders
    // but no longer works. This drives them with the server's own session API.
    await check("the built-in pages still work after being served from public/", async () => {
      for (const [label, pagePath] of [["home", "/?lang=en"], ["demo", "/demo/test-page?lang=ko"], ["playground", "/playground?lang=ko"], ["runs", "/runs?lang=ko"], ["runs-en", "/runs?lang=en"]]) {
        const response = await fetch(`${baseUrl}${pagePath}`);
        assert(response.ok, `${label} returned ${response.status}`);
        const body = await response.text();
        assert(!body.includes("{{"), `${label} rendered an unsubstituted placeholder`);
        assert(!/UI_TEMPLATE/.test(body), `${label} failed to render: ${body.slice(0, 200)}`);
      }

      for (const asset of ["common.js", "home.css", "playground.css", "playground.js", "demo.css", "demo.js", "docs.css", "docs.js", "runs.css", "runs.js"]) {
        const response = await fetch(`${baseUrl}/ui/${asset}`);
        assert(response.ok, `/ui/${asset} returned ${response.status}`);
        const body = await response.text();
        // A static asset cannot carry a template placeholder: nothing substitutes it.
        assert(!body.includes("{{"), `/ui/${asset} contains an unsubstituted placeholder`);
      }

      const pageErrors = [];
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${baseUrl}/demo/test-page?lang=ko` });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/fill`, {
        locator: { testId: "message-input" },
        value: "extracted",
      });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, { locator: { testId: "send-message" } });
      const demoStatus = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/locator/query`, {
        locator: { testId: "status" },
        operation: "textContent",
      });
      assert(demoStatus.payload.data.value?.trim(), "the demo page's script did not update the status");

      // The playground's config now arrives through an inline bootstrap because
      // its script is served statically; check the script actually received it.
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, { url: `${baseUrl}/playground?lang=ko` });
      const bootstrapped = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: '() => ({ hasConfig: typeof window.__PW_PLAYER__?.clientConfig?.apiBasePath === "string", wiredButtons: !!document.getElementById("healthBtn") })',
      });
      assert(bootstrapped.payload.data.result.hasConfig, "the playground never received its config");
      assert(bootstrapped.payload.data.result.wiredButtons, "the playground markup is missing its controls");

      const clicked = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, { locator: { css: "#healthBtn" } });
      assert(clicked.status === 200, `clicking the playground button returned ${clicked.status}`);
      const result = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/text`, {
        locator: { css: "#resultBox" },
        expected: "uptimeSec",
        timeoutMs: 10000,
      });
      assert(result.status === 200, "the playground's own API call did not populate the result box");
      assert(pageErrors.length === 0, pageErrors.join("; "));
    });

    // The run history page consumes the timeline API added in v0.7.1. Asserting
    // it returns 200 would not notice a page that renders an empty timeline.
    await check("the run history page renders a real timeline from a real run", async () => {
      await call("PUT", "/api/scripts/ui-timeline", {
        content: [
          'import { test, expect } from "@playwright/test";',
          "",
          'test("fails on the last assertion", async ({ page }) => {',
          `  await page.goto("${baseUrl}/demo/test-page");`,
          '  await page.getByTestId("message-input").fill("ui");',
          '  await page.getByTestId("send-message").click();',
          '  await expect(page.getByTestId("status")).toContainText("will not match", { timeout: 1500 });',
          "});",
          "",
        ].join("\n"),
      });
      const created = await call("POST", "/api/runs", { scriptKey: "ui-timeline", project: "chromium" });
      const runId = created.payload.data.runId;
      await waitForRuns([runId]);

      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
        url: `${baseUrl}/runs?lang=ko&runId=${runId}`,
      });

      // This harness runs with API_TOKEN set, so the page's own calls are 401
      // until its token field is filled — which is what an operator would do.
      // The page fetches asynchronously, so this has to wait rather than read
      // the status box the instant the navigation returns.
      const unauthorised = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/assert/text`, {
        locator: { css: "#statusBox" },
        expected: "/token|토큰/i",
        timeoutMs: 15000,
      });
      assert(unauthorised.status === 200,
        `the page never said a token was required: ${JSON.stringify(unauthorised.payload.error)}`);

      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/fill`, {
        locator: { css: "#apiToken" },
        value: token,
      });
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, { locator: { css: "#refreshBtn" } });

      // `first` because the page renders many .step rows and an ambiguous
      // locator is rejected on purpose.
      const rendered = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/wait-for`, {
        locator: { css: ".step", first: true },
        timeoutMs: 20000,
      });
      assert(rendered.status === 200, "the timeline never rendered any steps");

      const summary = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/evaluate`, {
        expression: `() => ({
          steps: document.querySelectorAll(".step").length,
          failed: document.querySelectorAll(".step.is-failed").length,
          errorShown: (document.querySelector(".step-error")?.textContent || "").length,
          evidence: document.querySelectorAll(".evidence figure").length,
          slowest: document.querySelectorAll(".chip").length,
          placeholders: document.body.innerHTML.includes("{{"),
        })`,
      });
      const data = summary.payload.data.result;
      assert(data.steps > 3, `only ${data.steps} steps rendered`);
      // The whole point is pinpointing the failure, not just showing a duration.
      assert(data.failed === 1, `${data.failed} steps marked as failing`);
      assert(data.errorShown > 20, "the failing step's error was not shown");
      assert(data.evidence > 0, "no evidence linked to the run");
      assert(data.slowest > 0, "no slowest-step summary");
      assert(data.placeholders === false, "the page rendered an unsubstituted placeholder");

      // Waiting for a locator that matches many elements used to surface
      // Playwright's "strict mode violation", which says nothing about the fix.
      const ambiguous = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/wait-for`, {
        locator: { css: ".step" },
        timeoutMs: 5000,
      });
      assert(ambiguous.status === 400, `expected 400, got ${ambiguous.status}`);
      assert(ambiguous.payload.error.code === "AMBIGUOUS_LOCATOR", ambiguous.payload.error.code);
      assert(ambiguous.payload.error.details.matchCount > 1, JSON.stringify(ambiguous.payload.error.details));
      assert(/first, last, or nth/.test(ambiguous.payload.error.message), ambiguous.payload.error.message);

      // Logs are behind a toggle so the page does not fetch them unprompted.
      await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/click`, {
        locator: { testId: "log-toggle" },
      });
      const logs = await call("POST", `/api/sessions/${sessionId}/pages/${pageId}/wait-for`, {
        locator: { css: "#logBox" },
        state: "visible",
        timeoutMs: 15000,
      });
      assert(logs.status === 200, "the log panel never opened");

      await call("DELETE", `/api/runs/${runId}`);
      await call("DELETE", "/api/scripts/ui-timeline");
    });

    // The shared page is wherever the previous check left it, so every check
    // below that uses the demo test ids navigates for itself rather than
    // depending on the one before it.
    const gotoDemo = () => call("POST", `/api/sessions/${sessionId}/pages/${pageId}/goto`, {
      url: `${baseUrl}/demo/test-page`,
      waitUntil: "domcontentloaded",
    });

    await check("a workflow branches on what the page actually shows", async () => {
      await gotoDemo();
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          {
            action: "if",
            when: { locator: { testId: "counter-value" }, state: "visible" },
            then: [{ action: "click", locator: { testId: "increment-counter" } }],
            else: [{ action: "click", locator: { testId: "primary-action" } }],
          },
          { action: "assertText", locator: { testId: "counter-value" }, expected: "1", match: "equals", timeoutMs: 5000 },
        ],
      });
      assert(status === 200, `execute returned ${status}`);
      assert(payload.data.status === "completed", payload.data.status);
      assert(payload.data.results[0].result.branch === "then", JSON.stringify(payload.data.results[0]));
      // The path says where in the tree a result came from, which a flat index
      // cannot once steps nest.
      assert(payload.data.results[1].path === "0.then.0", payload.data.results[1].path);
    });

    await check("a condition that is simply false is an answer, not a failure", async () => {
      await gotoDemo();
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{
          action: "if",
          when: { locator: { testId: "not-on-this-page" }, state: "visible", timeoutMs: 500 },
          then: [{ action: "click", locator: { testId: "primary-action" } }],
          else: [{ action: "click", locator: { testId: "secondary-action" } }],
        }],
      });
      assert(status === 200, `execute returned ${status}`);
      assert(payload.data.results[0].result.matched === false, JSON.stringify(payload.data.results[0]));
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
    });

    await check("a locator the page cannot evaluate still fails the workflow", async () => {
      await gotoDemo();
      // The distinction that matters: "not visible" is false, but a selector
      // Playwright cannot parse is a mistake worth surfacing.
      const { status } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{
          action: "if",
          when: { locator: { css: "###" }, state: "visible", timeoutMs: 500 },
          then: [{ action: "click", locator: { testId: "primary-action" } }],
        }],
      });
      assert(status >= 400, `a broken selector returned ${status}`);
    });

    await check("repeat and forEach drive the page", async () => {
      await gotoDemo();
      const repeated = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          { action: "repeat", times: 5, steps: [{ action: "click", locator: { testId: "increment-counter" } }] },
          { action: "assertText", locator: { testId: "counter-value" }, expected: "5", match: "equals", timeoutMs: 5000 },
        ],
      });
      assert(repeated.payload.data.failedCount === 0, JSON.stringify(repeated.payload.data.results));

      const each = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        variables: { rows: [{ text: "첫째" }, { text: "둘째" }, { text: "셋째" }] },
        steps: [
          {
            action: "forEach", items: "{{rows}}", as: "row",
            steps: [
              { action: "fill", locator: { testId: "message-input" }, value: "{{row.text}}" },
              { action: "click", locator: { testId: "send-message" } },
            ],
          },
          // The summary names the last row, which pins both the count and the order.
          { action: "assertText", locator: { testId: "chat-summary" }, expected: "셋째", timeoutMs: 5000 },
        ],
      });
      assert(each.payload.data.failedCount === 0, JSON.stringify(each.payload.data.results));
      const loop = each.payload.data.results.find((entry) => entry.action === "forEach");
      assert(loop.result.iterations === 3, JSON.stringify(loop));
    });

    await check("while waits for the page to reach a state", async () => {
      await gotoDemo();
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          {
            action: "while",
            when: { not: { locator: { testId: "counter-value" }, text: "3", match: "equals" } },
            maxIterations: 10,
            steps: [{ action: "click", locator: { testId: "increment-counter" } }],
          },
          { action: "assertText", locator: { testId: "counter-value" }, expected: "3", match: "equals", timeoutMs: 5000 },
        ],
      });
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
      const loop = payload.data.results.find((entry) => entry.action === "while");
      assert(loop.result.iterations === 3, JSON.stringify(loop));
    });

    await check("a while loop whose condition never settles fails instead of passing", async () => {
      await gotoDemo();
      const { status, payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{
          action: "while",
          when: { locator: { testId: "counter-value" }, state: "visible" },
          maxIterations: 3,
          steps: [{ action: "click", locator: { testId: "increment-counter" } }],
        }],
      });
      assert(status === 408, `expected 408, got ${status}`);
      assert(payload.error.code === "LOOP_LIMIT_EXCEEDED", payload.error.code);
    });

    await check("break leaves a loop early", async () => {
      await gotoDemo();
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          {
            action: "repeat", times: 10, indexAs: "i",
            steps: [
              { action: "click", locator: { testId: "increment-counter" } },
              { action: "if", when: { value: "{{i}}", gte: 2 }, then: [{ action: "break" }] },
            ],
          },
          { action: "assertText", locator: { testId: "counter-value" }, expected: "3", match: "equals", timeoutMs: 5000 },
        ],
      });
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
    });

    await check("an approval gate suspends the workflow and resumes inside the same iteration", async () => {
      await gotoDemo();
      const started = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          {
            action: "repeat", times: 2,
            steps: [
              { action: "approval", name: "supervisor", message: "증가를 승인해 주세요", approvers: ["kim@example.com"] },
              { action: "click", locator: { testId: "increment-counter" } },
            ],
          },
        ],
      });
      assert(started.payload.data.status === "awaiting_approval", started.payload.data.status);
      let gateId = started.payload.data.approval.gateId;
      assert(started.payload.data.approval.message === "증가를 승인해 주세요", JSON.stringify(started.payload.data.approval));

      const listed = await call("GET", `/api/sessions/${sessionId}/approvals`);
      assert(listed.payload.data.approvals.length === 1, JSON.stringify(listed.payload.data.approvals));

      // Resuming without a decision would defeat the point of the gate.
      const early = await call("POST", `/api/sessions/${sessionId}/execute/resume`, { gateId });
      assert(early.status === 409 && early.payload.error.code === "APPROVAL_PENDING",
        `${early.status} ${early.payload.error?.code}`);

      const stranger = await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
        decision: "approve", decidedBy: "park@example.com",
      });
      assert(stranger.status === 403 && stranger.payload.error.code === "APPROVER_NOT_LISTED",
        `${stranger.status} ${stranger.payload.error?.code}`);

      const anonymous = await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, { decision: "approve" });
      assert(anonymous.status === 400, `an unattributed decision returned ${anonymous.status}`);

      let outcome;
      for (let guard = 0; guard < 4 && gateId; guard += 1) {
        const decided = await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
          decision: "approve", decidedBy: "kim@example.com", comment: "확인했습니다",
        });
        assert(decided.status === 200, `decide returned ${decided.status}`);
        const twice = await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
          decision: "reject", decidedBy: "kim@example.com",
        });
        assert(twice.status === 409, `a second decision returned ${twice.status}`);

        outcome = await call("POST", `/api/sessions/${sessionId}/execute/resume`, { gateId });
        gateId = outcome.payload.data.approval?.gateId;
        if (outcome.payload.data.status === "completed") {
          break;
        }
      }
      assert(outcome.payload.data.status === "completed", JSON.stringify(outcome.payload.data.status));
      assert(outcome.payload.data.captured.supervisor === "approved", JSON.stringify(outcome.payload.data.captured));

      // Both iterations must have run their body, not just the one that was
      // waiting when the gate opened.
      const counted = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{ action: "assertText", locator: { testId: "counter-value" }, expected: "2", match: "equals", timeoutMs: 5000 }],
      });
      assert(counted.payload.data.failedCount === 0, JSON.stringify(counted.payload.data.results));
    });

    await check("a rejected gate stops the workflow and records who rejected it", async () => {
      await gotoDemo();
      const started = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          { action: "approval", name: "finance" },
          { action: "click", locator: { testId: "increment-counter" } },
        ],
      });
      const gateId = started.payload.data.approval.gateId;
      await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
        decision: "reject", decidedBy: "lee@example.com", comment: "금액 불일치",
      });
      const resumed = await call("POST", `/api/sessions/${sessionId}/execute/resume`, { gateId });
      assert(resumed.payload.data.status === "rejected", resumed.payload.data.status);
      assert(resumed.payload.data.approval.decidedBy === "lee@example.com", JSON.stringify(resumed.payload.data.approval));
      assert(resumed.payload.data.approval.comment === "금액 불일치", JSON.stringify(resumed.payload.data.approval));

      const counted = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [{ action: "assertText", locator: { testId: "counter-value" }, expected: "0", match: "equals", timeoutMs: 5000 }],
      });
      assert(counted.payload.data.failedCount === 0, "the step after a rejected gate ran anyway");
    });

    await check("onReject continue hands the decision to the workflow", async () => {
      await gotoDemo();
      const started = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          { action: "approval", name: "review", onReject: "continue" },
          {
            action: "if", when: { value: "{{review}}", equals: "approved" },
            then: [{ action: "click", locator: { testId: "increment-counter" } }],
            else: [{ action: "fill", locator: { testId: "message-input" }, value: "반려 처리" }],
          },
        ],
      });
      const gateId = started.payload.data.approval.gateId;
      await call("POST", `/api/sessions/${sessionId}/approvals/${gateId}/decide`, {
        decision: "reject", decidedBy: "lee@example.com",
      });
      const resumed = await call("POST", `/api/sessions/${sessionId}/execute/resume`, { gateId });
      assert(resumed.payload.data.status === "completed", resumed.payload.data.status);
      const branch = resumed.payload.data.results.find((entry) => entry.action === "if");
      assert(branch.result.branch === "else", JSON.stringify(branch));
    });

    await check("a condition reads inside a forEach row the same way substitution does", async () => {
      await gotoDemo();
      // An object substituted into a string becomes JSON, so a text comparison
      // against one has to see the same thing and not "[object Object]".
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        variables: { rows: [{ id: "A-1", qty: 3 }, { id: "B-2", qty: 0 }] },
        steps: [
          { action: "click", locator: { testId: "reset-counter" } },
          {
            action: "forEach", items: "{{rows}}", as: "row",
            steps: [{
              action: "if",
              when: { all: [{ value: "{{row.qty}}", gt: 0 }, { value: "{{row}}", contains: "A-" }] },
              then: [{ action: "click", locator: { testId: "increment-counter" } }],
            }],
          },
          // Only the first row satisfies both halves.
          { action: "assertText", locator: { testId: "counter-value" }, expected: "1", match: "equals", timeoutMs: 5000 },
        ],
      });
      assert(payload.data.failedCount === 0, JSON.stringify(payload.data.results));
      const branches = payload.data.results.filter((entry) => entry.action === "if");
      assert(branches.length === 2, JSON.stringify(branches));
      assert(branches[0].result.matched === true && branches[1].result.matched === false, JSON.stringify(branches));
    });

    await check("a numeric comparison on non-numeric text names the problem", async () => {
      await gotoDemo();
      // "17" < "9" is true for strings. Guessing which was meant is how a
      // quantity check silently passes on the wrong rows.
      const { payload } = await call("POST", `/api/sessions/${sessionId}/execute`, {
        pageId,
        variables: { qty: "약간" },
        steps: [{ action: "if", when: { value: "{{qty}}", gt: 5 }, then: [{ action: "click", locator: { testId: "primary-action" } }] }],
      });
      assert(payload.error.code === "INVALID_CONDITION", JSON.stringify(payload));
      assert(/compares numbers/.test(payload.error.message), payload.error.message);
    });

    await check("closing a session drops the gates that were waiting on it", async () => {
      // The continuation needs the page it suspended on. Keeping the gate after
      // the session is gone would leave a decision that can never be applied.
      const other = await call("POST", "/api/sessions", {});
      const otherId = other.payload.data.sessionId;
      const otherContext = (await call("POST", `/api/sessions/${otherId}/contexts`, {})).payload.data.contextId;
      const otherPage = (await call("POST", `/api/sessions/${otherId}/contexts/${otherContext}/pages`, {})).payload.data.pageId;
      await call("POST", `/api/sessions/${otherId}/pages/${otherPage}/goto`, { url: `${baseUrl}/demo/test-page` });

      const gated = await call("POST", `/api/sessions/${otherId}/execute`, {
        pageId: otherPage,
        steps: [{ action: "approval", name: "orphan" }],
      });
      const gateId = gated.payload.data.approval.gateId;
      assert((await call("GET", `/api/sessions/${otherId}/approvals/${gateId}`)).status === 200, "the gate was not registered");

      await call("DELETE", `/api/sessions/${otherId}`);
      const afterClose = await call("GET", `/api/sessions/${otherId}/approvals/${gateId}`);
      assert(afterClose.status === 404, `expected 404 after close, got ${afterClose.status}`);
      assert(afterClose.payload.error.code === "APPROVAL_NOT_FOUND", afterClose.payload.error.code);
    });

    await check("a person can clear an approval gate from the playground page", async () => {
      // An approval whose only interface is curl is not an approval: the whole
      // point of stopping is that somebody looks at it.
      const act = (action, body) => call("POST", `/api/sessions/${sessionId}/pages/${pageId}/${action}`, body);
      const settle = (fragment) => act("assert/text", {
        locator: { css: "#statusBox" }, expected: fragment, match: "contains", timeoutMs: 20000,
      });

      await act("goto", { url: `${baseUrl}/playground?lang=ko`, waitUntil: "domcontentloaded" });
      await act("fill", { locator: { css: "#apiToken" }, value: token });
      // Each button stores its id only after its fetch resolves, so the next
      // click has to wait for the status line instead of firing immediately.
      await act("click", { locator: { css: "#createSessionBtn" } });
      await settle("/api/sessions completed");
      await act("click", { locator: { css: "#createContextBtn" } });
      await settle("/contexts completed");
      await act("click", { locator: { css: "#createPageBtn" } });
      await settle("/pages completed");

      await act("fill", { locator: { css: "#decidedBy" }, value: "kim@example.com" });
      await act("click", { locator: { css: "#runWorkflowBtn" } });
      const listed = await act("wait-for", {
        locator: { css: "[data-testid='approval-row']" }, state: "visible", timeoutMs: 25000,
      });
      assert(listed.status === 200, `the gate never appeared: ${listed.payload.error?.message}`);
      // The status the person needs must survive the queue refresh that follows it.
      const waiting = await act("assert/text", {
        locator: { css: "#statusBox" }, expected: "awaiting_approval", match: "contains", timeoutMs: 10000,
      });
      assert(waiting.status === 200, "the page did not report that it is waiting for approval");

      for (let pass = 0; pass < 2; pass += 1) {
        await act("click", { locator: { css: "[data-testid='approve-approval']" } });
        await settle("execute/resume completed");
      }
      const finished = await act("assert/text", {
        locator: { css: "#statusBox" }, expected: "completed", match: "contains", timeoutMs: 10000,
      });
      assert(finished.status === 200, "approving twice did not finish the workflow");

      // The server refuses an unattributed decision; the page should say so
      // rather than send a request it knows will fail.
      await act("click", { locator: { css: "#runWorkflowBtn" } });
      await act("wait-for", { locator: { css: "[data-testid='approval-row']" }, state: "visible", timeoutMs: 25000 });
      await act("fill", { locator: { css: "#decidedBy" }, value: "" });
      await act("click", { locator: { css: "[data-testid='approve-approval']" } });
      const refused = await act("assert/text", {
        locator: { css: "#statusBox" }, expected: "승인자", match: "contains", timeoutMs: 10000,
      });
      assert(refused.status === 200, "an unattributed decision was not refused on the page");

      await act("click", { locator: { css: "#closeSessionBtn" } });
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
