// Diagnose an already-running server, including inside an isolated container.
// Uses only Node's built-ins; never installs a browser or contacts a registry.
const args = process.argv.slice(2);
let base = process.env.PLAYWRIGHT_PLAYER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
let json = args.includes("--json");

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run doctor -- [--url http://127.0.0.1:3000] [--json]\n"
      + "Checks browser launch, rendering, screenshot pixels, and storage on a running server.\n"
      + "Environment: API_TOKEN, API_BASE_PATH, PLAYWRIGHT_PLAYER_URL, PORT.\n"
      + "Exit codes: 0 = all checks passed, 1 = failed or incomplete checks, 2 = could not get a report.\n"
      + "For machine-readable output: npm run --silent doctor -- --json");
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--url" && args[index + 1]) base = args[++index];
    else if (arg.startsWith("--url=")) base = arg.slice(6);
    else throw Object.assign(new Error(`Unsupported or incomplete argument: ${arg.split("=")[0]}. Use --help.`), { code: "INVALID_ARGUMENT" });
  }
  let endpoint;
  try {
    endpoint = new URL(base);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch {
    throw Object.assign(new Error("--url must be an HTTP(S) server address without credentials, query parameters, or a fragment."), { code: "INVALID_URL" });
  }
  const prefix = process.env.API_BASE_PATH || "/api";
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/" + prefix.replace(/^\/+|\/+$/g, "") + "/diagnostics";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {}),
    },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const advice = response.status === 401 ? " Set API_TOKEN to the server's token."
      : response.status === 403 ? " Use a token with the runner role."
        : response.status === 404 ? " Check API_BASE_PATH and whether the running server includes diagnostics." : "";
    throw Object.assign(new Error(`Diagnostic request returned HTTP ${response.status}.${advice}`), { code: payload?.error?.code || `HTTP_${response.status}` });
  }
  const report = payload?.data;
  if (!report || !["ok", "degraded", "failed"].includes(report.status) || !Array.isArray(report.checks)) {
    throw Object.assign(new Error("The server did not return a diagnostic report. Check the address and server version."), { code: "INVALID_REPORT" });
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Playwright Player: ${report.status.toUpperCase()} (${report.durationMs} ms)`);
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase().padEnd(7)} ${check.id} (${check.durationMs} ms) — ${check.message}`);
      if (check.remediation) console.log(`        ${check.remediation}`);
    }
  }
  process.exitCode = report.status === "ok" ? 0 : 1;
}

main().catch((error) => {
  const code = error.code || error.cause?.code || error.name || "REQUEST_FAILED";
  const message = error.name === "TimeoutError" ? "The diagnostic request timed out. Inspect the server logs."
    : error.message === "fetch failed" ? "Cannot reach the server. Check that it is running and verify --url/PORT."
      : error.message;
  if (json) console.log(JSON.stringify({ status: "unavailable", error: { code, message } }));
  else console.error(`${code}: ${message}`);
  process.exitCode = 2;
});
