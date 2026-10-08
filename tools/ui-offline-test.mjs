// Browser checks for authenticated artifact previews and an offline intranet UI.
// Run with `node tools/ui-offline-test.mjs`; no external service is contacted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token = "ui-offline-test-token";

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chromium" });
  } catch (error) {
    if (process.env.SMOKE_REQUIRE_BROWSER !== "1" && /Executable doesn't exist|playwright install|Failed to launch.*ENOENT/i.test(error.message)) {
      console.log("SKIP  Offline UI checks: install the pinned Playwright browser before running");
      return;
    }
    throw error;
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pw-player-ui-offline-"));
  let child;
  let log = "";
  try {
    const reservation = http.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1", API_TOKEN: token,
        SCRIPTS_DIR: path.join(scratch, "scripts"), RUNS_DIR: path.join(scratch, "runs"),
        ARTIFACTS_DIR: path.join(scratch, "artifacts"), STORAGE_STATE_DIR: path.join(scratch, "storage"),
        ENVIRONMENTS_DIR: path.join(scratch, "environments"), DATASETS_DIR: path.join(scratch, "datasets"),
        SCHEDULES_DIR: path.join(scratch, "schedules"), SECRETS_DIR: path.join(scratch, "secrets"),
        PRINCIPALS_FILE: "", URL_ALLOWLIST: "127.0.0.1", SCHEDULE_TICK_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 60_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${log}`);
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error(`Server did not start: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const context = await browser.newContext();
    const externalRequests = [];
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await context.addInitScript(() => {
      window.revokedPreviewUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        window.revokedPreviewUrls.push(url);
        revoke(url);
      };
    });
    const page = await context.newPage();
    const click = async (id) => {
      await page.locator(`#${id}`).click();
      await page.waitForFunction((id) => !document.getElementById(id).disabled, id);
    };

    await page.goto(`${base}/playground?lang=en`);
    await page.locator("#apiToken").fill(token);
    for (const id of ["createSessionBtn", "createContextBtn", "createPageBtn", "gotoDemoBtn", "takeScreenshotBtn"]) {
      await click(id);
      assert.ok(!(await page.locator("#statusBox").getAttribute("class")).includes("error"),
        `${id}: ${await page.locator("#statusBox").textContent()}`);
    }
    await page.waitForFunction(() => document.querySelector("#preview img")?.naturalWidth > 0);
    const previousUrl = await page.locator("#preview img").getAttribute("src");
    await click("takeScreenshotBtn");
    await page.waitForFunction(() => document.querySelector("#preview img")?.naturalWidth > 0);
    assert.ok(await page.evaluate((url) => window.revokedPreviewUrls.includes(url), previousUrl));
    const imageBytes = await page.locator("#preview img").evaluate(async (image) =>
      Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
    console.log("PASS  Authenticated screenshots with external requests blocked; replaced preview is released");

    const sessionBeforeCheck = await page.locator("#sessionId").inputValue();
    const previewBeforeCheck = await page.locator("#preview img").getAttribute("src");
    await click("diagnosticsBtn");
    assert.equal(await page.locator("#diagnosticsSummary").getAttribute("data-status"), "ok",
      await page.locator("#resultBox").textContent());
    assert.equal(await page.locator("#diagnosticsChecks [data-status='passed']").count(), 6);
    assert.equal(await page.locator("#sessionId").inputValue(), sessionBeforeCheck);
    assert.equal(await page.locator("#preview img").getAttribute("src"), previewBeforeCheck);
    const reportDownloading = page.waitForEvent("download");
    await click("downloadDiagnosticsBtn");
    const reportFile = await reportDownloading;
    const reportText = await fs.readFile(await reportFile.path(), "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.status, "ok");
    assert.equal(report.checks.length, 6);
    assert.ok(!reportText.includes(token));
    assert.ok(!reportText.includes(scratch));
    console.log("PASS  Environment checks render six real results and download a safe report without changing the user's session");

    await page.route("**/api/sessions/*/artifacts/*", (route) => route.fulfill({
      status: 401, contentType: "application/json",
      body: JSON.stringify({ error: { message: "artifact authentication test failure" } }),
    }));
    await click("takeScreenshotBtn");
    assert.match(await page.locator("#statusBox").textContent(), /artifact authentication test failure/);
    assert.match(await page.locator("#preview").textContent(), /artifact authentication test failure/);
    assert.match(await page.locator("#statusBox").getAttribute("class"), /error/);
    console.log("PASS  Artifact fetch errors appear in preview and status");
    await page.unroute("**/api/sessions/*/artifacts/*");
    await click("closeSessionBtn");

    // A recorded run can include arbitrary attachment filenames from test code.
    await page.route("**/api/runs/fixture", (route) => {
      const authorized = route.request().headers().authorization === `Bearer ${token}`;
      return route.fulfill({
        status: authorized ? 200 : 401, contentType: "application/json",
        body: JSON.stringify(authorized ? { data: {
          runId: "fixture", status: "completed", scriptKey: "fixture.spec.js",
          tests: [{ title: "screenshot", status: "passed", attachments: [{
            name: "special screenshot", path: "test-results/question?#한글.png", contentType: "image/png",
          }] }],
        } } : { error: { message: "Unauthorized" } }),
      });
    });
    const artifactRequests = [];
    await page.route("**/api/runs/fixture/artifacts/**", (route) => {
      artifactRequests.push({ url: route.request().url(), authorization: route.request().headers().authorization });
      return route.fulfill({ contentType: "image/png", body: Buffer.from(imageBytes) });
    });
    await page.goto(`${base}/runs?runId=fixture&lang=en`);
    await page.locator("#apiToken").fill(token);
    await click("refreshBtn");
    await page.waitForFunction(() => document.querySelector(".evidence img")?.naturalWidth > 0);
    assert.equal(artifactRequests.length, 1);
    assert.equal(artifactRequests[0].authorization, `Bearer ${token}`);
    assert.equal(decodeURIComponent(new URL(artifactRequests[0].url).pathname),
      "/api/runs/fixture/artifacts/test-results/question?#한글.png");
    const evidenceUrl = await page.locator(".evidence img").getAttribute("src");
    const downloading = page.waitForEvent("download");
    await page.getByTestId("evidence-download").click();
    const download = await downloading;
    // Browsers may replace the '?' for filesystem compatibility.
    assert.match(download.suggestedFilename(), /^question.*#한글\.png$/);
    assert.equal(await download.failure(), null);
    assert.deepEqual(await fs.readFile(await download.path()), Buffer.from(imageBytes));
    await click("backBtn");
    assert.ok(await page.evaluate((url) => window.revokedPreviewUrls.includes(url), evidenceUrl));
    console.log("PASS  Authenticated run evidence and download preserve #, ?, and Korean filenames; preview is released");

    // Route an ordinary HTTP intranet hostname locally, without DNS or a proxy.
    const intranet = "http://player.offline.test";
    await page.route(`${intranet}/**`, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: `${base}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), host: url.host },
      });
      await route.fulfill({ response });
    });
    await page.goto(`${intranet}/docs`);
    await page.waitForFunction(() => Boolean(window.ui?.specSelectors?.specJson()?.get("openapi")));
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.equal(await page.evaluate(() => window.ui.getConfigs().validatorUrl), null);
    assert.deepEqual(externalRequests, []);
    console.log("PASS  Swagger loads over intranet HTTP with no external requests or public validator");

    await page.goto(`${base}/playground?lang=ko`);
    await page.locator("#apiToken").fill(token);
    await page.route("**/api/diagnostics", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { status: "failed", durationMs: 12, checks: [{
        id: "browser_launch", status: "failed", durationMs: 10, errorCode: "BROWSER_NOT_INSTALLED",
        message: "Missing browser", remediation: "Install the pinned browser in a connected build environment.",
      }] } }),
    }));
    await click("diagnosticsBtn");
    assert.equal(await page.locator("#diagnosticsSummary").getAttribute("data-status"), "failed");
    assert.match(await page.locator("#diagnosticsChecks").textContent(), /브라우저 실행/);
    assert.match(await page.locator(".diagnostics-remediation").textContent(), /반입/);
    assert.match(await page.locator("#statusBox").getAttribute("class"), /error/);
    console.log("PASS  Korean diagnostics shows remediation and treats HTTP 200 failed reports as failures");
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    await browser.close();
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

await main();
