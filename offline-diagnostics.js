import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const WIDTH = 640;
const HEIGHT = 360;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHECKS = ["configuration", "browser_launch", "page_render", "screenshot_capture", "artifact_roundtrip"];
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Playwright Player offline readiness</title>
<style>html,body{margin:0;width:640px;height:360px;background:#f1f5f9;font:20px sans-serif}
h1{position:absolute;left:16px;top:16px;margin:0;font-size:24px}
.sample{position:absolute;top:100px;width:160px;height:120px}
#red{left:16px;background:rgb(239,68,68)}#green{left:200px;background:rgb(34,197,94)}
#blue{left:384px;background:rgb(59,130,246)}p{position:absolute;left:16px;top:250px}</style></head>
<body><h1>Offline readiness</h1><div class="sample" id="red"></div><div class="sample" id="green"></div>
<div class="sample" id="blue"></div><p>Local browser · rendering · screenshot · artifact storage</p></body></html>`;

const PROBLEMS = {
  SESSION_LIMIT_EXCEEDED: ["All browser session slots are in use.", "Close an idle session, or retry after the current work finishes."],
  BROWSER_NOT_INSTALLED: ["The configured Playwright browser is not installed.", "Transfer the browser bundled with the pinned Playwright version, or rebuild the offline image with its browsers included."],
  BROWSER_LAUNCH_TIMEOUT: ["The configured browser did not launch within the diagnostic time budget.", "Check local CPU and memory availability, browser dependencies, and BROWSER_LAUNCH_TIMEOUT_MS."],
  BROWSER_LAUNCH_FAILED: ["The configured browser could not launch.", "Check the installed browser and system libraries. For a server without a display, set DEFAULT_HEADLESS=true."],
  INVALID_BROWSER: ["The configured browser type is unsupported.", "Set DEFAULT_BROWSER_TYPE to chromium, firefox, or webkit and include that browser in the offline image."],
  CONTEXT_LIMIT_EXCEEDED: ["The configured context limit prevents a local rendering check.", "Set MAX_CONTEXTS_PER_SESSION to at least 1."],
  PAGE_LIMIT_EXCEEDED: ["The configured page limit prevents a local rendering check.", "Set MAX_PAGES_PER_SESSION to at least 1."],
  EACCES: ["The service cannot access its artifact storage.", "Grant the service user read and write access to the ARTIFACTS_DIR volume."],
  EPERM: ["The service cannot access its artifact storage.", "Grant the service user read and write access to the ARTIFACTS_DIR volume."],
  EROFS: ["The artifact storage is mounted read-only.", "Mount ARTIFACTS_DIR as a writable volume."],
  ENOSPC: ["The artifact storage is full.", "Free space or increase the capacity of the ARTIFACTS_DIR volume."],
  EMFILE: ["The service has reached its open-file limit.", "Close unused sessions and review the process file-descriptor limit."],
  DIAGNOSTIC_TIMEOUT: ["The local check exceeded its time budget.", "Check local browser processes, CPU, memory, and artifact volume responsiveness, then retry."],
  PAGE_RENDER_FAILED: ["The built-in page did not render its expected content.", "Check the browser installation and local runtime dependencies."],
  SCREENSHOT_INVALID: ["The captured screenshot did not contain the expected rendered pixels.", "Check the browser installation and rendering dependencies, then rerun this diagnostic."],
  ARTIFACT_MISMATCH: ["The screenshot read from artifact storage differs from the captured image.", "Check the ARTIFACTS_DIR volume and available storage capacity."],
};

// Raw Playwright errors contain executable paths, launch arguments, proxy
// credentials, and environment details. Reports use only known safe messages.
function problem(error, stage) {
  let code = Object.hasOwn(PROBLEMS, error?.code) ? error.code : undefined;
  if (!code && stage === "browser_launch") {
    code = /executable doesn't exist|playwright install|failed to launch.*ENOENT/i.test(error?.message || "")
      ? "BROWSER_NOT_INSTALLED" : "BROWSER_LAUNCH_FAILED";
  }
  const fallback = {
    page_render: ["PAGE_RENDER_FAILED", "The local rendering check failed.", "Check the browser runtime and local system resources."],
    screenshot_capture: ["SCREENSHOT_FAILED", "The local screenshot check failed.", "Check browser rendering and SCREENSHOT_TIMEOUT_MS. Use SCREENSHOT_WAIT_FOR_FONTS=false when external fonts are unavailable."],
    artifact_roundtrip: ["ARTIFACT_STORAGE_FAILED", "The artifact write/read check failed.", "Check the permissions, capacity, and responsiveness of the ARTIFACTS_DIR volume."],
    cleanup: ["DIAGNOSTIC_CLEANUP_FAILED", "The temporary diagnostic resources could not be fully removed.", "Check the artifact volume permissions and browser process state before retrying."],
  }[stage] || ["DIAGNOSTIC_FAILED", "The local diagnostic check failed.", "Check local browser and storage availability, then retry."];
  const [message, remediation] = code ? PROBLEMS[code] : fallback.slice(1);
  return { errorCode: code || fallback[0], message, remediation };
}

/**
 * Runs one bounded, coalesced check using an owned SessionManager session.
 * No target URL, download, user page, storage state, or user artifact is used.
 * timeoutMs is an internal test seam; callers cannot change it through run().
 */
export function createOfflineDiagnostics({ sessionManager, config, ApiError, timeoutMs = 20_000 }) {
  let active = null;
  const fail = (code) => new ApiError(500, code, code);
  const budgetMs = Math.min(20_000, Math.max(50, timeoutMs));

  async function execute() {
    const checkedAt = new Date(Date.now()).toISOString();
    // Isolated machines may correct their wall clock abruptly. Durations and
    // deadlines must use a monotonic clock so those corrections cannot extend
    // the diagnostic budget or produce negative elapsed times.
    const started = performance.now();
    const deadline = started + budgetMs;
    const workDeadline = started + Math.floor(budgetMs * 0.75);
    const checks = [];
    let sessionId;
    let creation;
    let page;
    let screenshot;
    let ending = false;
    let disposal;
    const remaining = () => Math.max(1, Math.ceil(workDeadline - performance.now()));
    const elapsed = (start) => Math.round(performance.now() - start);

    const within = async (operation, until = workDeadline) => {
      const time = until - performance.now();
      if (time <= 0) throw fail("DIAGNOSTIC_TIMEOUT");
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => { timer = setTimeout(() => reject(fail("DIAGNOSTIC_TIMEOUT")), time); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    const discard = () => {
      if (!sessionId) return Promise.resolve();
      if (!disposal) {
        disposal = (async () => {
          // Close before removing files so late browser work cannot recreate
          // artifacts. No artifacts were indexed, so user retention is intact.
          try {
            await sessionManager.closeSession(sessionId, "diagnostic-complete");
          } catch (error) {
            if (error?.code !== "SESSION_NOT_FOUND") throw error;
          } finally {
            await fs.rm(path.join(config.artifactsDir, sessionId), { recursive: true, force: true });
          }
        })();
      }
      return disposal;
    };

    const runCheck = async (id, operation) => {
      const start = performance.now();
      try {
        const result = await within(operation);
        checks.push({ id, status: "passed", durationMs: elapsed(start), ...result });
        return true;
      } catch (error) {
        checks.push({ id, status: error?.code === "SESSION_LIMIT_EXCEEDED" ? "warning" : "failed", durationMs: elapsed(start), ...problem(error, id) });
        return false;
      }
    };

    const operations = {
      configuration: async () => config.screenshotWaitForFonts ? {
        status: "warning",
        errorCode: "SCREENSHOT_FONT_WAIT_ENABLED",
        message: "Screenshots are configured to wait for web fonts, which can stall in an offline network.",
        remediation: "Set SCREENSHOT_WAIT_FOR_FONTS=false unless waiting for available web fonts is required.",
      } : { message: "Screenshot font waiting is disabled for offline use." },
      browser_launch: async () => {
        creation = sessionManager.createSession({ timeoutMs: remaining(), ttlMs: 60_000 });
        // If a launch completes just after the deadline, it still belongs to
        // this diagnostic and must be closed; never leave an orphan session.
        creation = creation.then(async (session) => {
          sessionId = session.sessionId;
          if (ending) await discard();
          return session;
        });
        const session = await creation;
        return { message: "The configured browser launched successfully.", details: { browserType: session.browserType } };
      },
      page_render: async () => {
        const context = await sessionManager.createContext(sessionId, {
          offline: true, serviceWorkers: "block", acceptDownloads: false,
          viewport: { width: WIDTH, height: HEIGHT }, reducedMotion: "reduce",
        });
        const session = sessionManager.getSession(sessionId);
        const contextRecord = sessionManager.getContextRecord(session, context.contextId);
        await contextRecord.context.route("**/*", (route) => route.abort("blockedbyclient"));
        const record = await sessionManager.createPage(sessionId, context.contextId);
        page = sessionManager.getPageRecord(session, record.pageId).page;
        await page.setContent(PAGE, { waitUntil: "domcontentloaded", timeout: remaining() });
        const rendered = await page.evaluate(() => {
          const marker = document.getElementById("red");
          const bounds = marker?.getBoundingClientRect();
          return document.title === "Playwright Player offline readiness"
            && bounds?.width === 160 && bounds?.height === 120
            && getComputedStyle(marker).backgroundColor === "rgb(239, 68, 68)";
        });
        if (!rendered) throw fail("PAGE_RENDER_FAILED");
        return { message: "The built-in page rendered with browser-context networking blocked.", details: { width: WIDTH, height: HEIGHT } };
      },
      screenshot_capture: async () => {
        screenshot = await page.screenshot({
          type: "png", fullPage: false, scale: "css",
          timeout: Math.min(remaining(), config.screenshotTimeoutMs || 30_000),
        });
        if (!Buffer.isBuffer(screenshot) || screenshot.length < 33
          || !screenshot.subarray(0, 8).equals(PNG_SIGNATURE)
          || screenshot.toString("ascii", 12, 16) !== "IHDR"
          || screenshot.readUInt32BE(16) !== WIDTH || screenshot.readUInt32BE(20) !== HEIGHT) {
          throw fail("SCREENSHOT_INVALID");
        }
        // Decode the actual capture and sample three solid color patches. A
        // syntactically valid but blank/black screenshot must not pass readiness.
        const pixelsMatch = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          return [[40, [239, 68, 68]], [220, [34, 197, 94]], [400, [59, 130, 246]]]
            .every(([x, expected]) => {
              const actual = context.getImageData(x, 140, 1, 1).data;
              return expected.every((value, channel) => Math.abs(actual[channel] - value) <= 2) && actual[3] === 255;
            });
        }, screenshot.toString("base64"));
        if (!pixelsMatch) throw fail("SCREENSHOT_INVALID");
        return { message: "The PNG capture decoded successfully and contains the expected rendered colors.", details: { format: "png", width: WIDTH, height: HEIGHT, sizeBytes: screenshot.length } };
      },
      artifact_roundtrip: async () => {
        const file = path.join(config.artifactsDir, sessionId, "offline-readiness.png");
        await fs.writeFile(file, screenshot, { flag: "wx", mode: 0o600 });
        const restored = await fs.readFile(file);
        if (!restored.equals(screenshot)) throw fail("ARTIFACT_MISMATCH");
        return { message: "The captured screenshot was written to artifact storage and read back unchanged.", details: { sizeBytes: restored.length } };
      },
    };

    let blockedBy;
    try {
      for (const id of CHECKS) {
        if (blockedBy) {
          checks.push({ id, status: "skipped", durationMs: 0, message: "A prerequisite check did not complete.", details: { blockedBy } });
        } else if (!(await runCheck(id, operations[id]))) {
          blockedBy = id;
        }
      }
    } finally {
      ending = true;
      const start = performance.now();
      try {
        await within(async () => {
          await creation?.catch(() => undefined);
          await discard();
        }, deadline);
        checks.push({ id: "cleanup", status: "passed", durationMs: elapsed(start), message: "Temporary diagnostic sessions and files were removed." });
      } catch (error) {
        checks.push({ id: "cleanup", status: "failed", durationMs: elapsed(start), ...problem(error, "cleanup") });
      }
    }

    return {
      status: checks.some((check) => check.status === "failed") ? "failed"
        : checks.some((check) => check.status === "warning" || check.status === "skipped") ? "degraded" : "ok",
      checkedAt,
      durationMs: elapsed(started),
      serviceVersion: config.serviceVersion,
      network: "local-only",
      settings: {
        browserType: config.defaultBrowserType,
        headless: config.defaultHeadless,
        screenshotWaitForFonts: config.screenshotWaitForFonts,
        screenshotTimeoutMs: config.screenshotTimeoutMs,
        urlAllowlistConfigured: Boolean(config.urlAllowlist?.length),
      },
      checks,
    };
  }

  return {
    run() {
      if (!active) active = execute().finally(() => { active = null; });
      return active;
    },
  };
}
