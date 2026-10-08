# Offline deployment

This is the shortest path for loading the released Docker image `tar.gz` into an air-gapped environment.

## Prerequisites

- Docker Engine or Docker Desktop
- `playwright-player-vX.Y.Z-docker-image.tar.gz`
- `playwright-player-vX.Y.Z-docker-image.tar.gz.sha256`

## 1. Verify the checksum

```powershell
$file = '.\playwright-player-v0.1.4-docker-image.tar.gz'
$expected = (Get-Content '.\playwright-player-v0.1.4-docker-image.tar.gz.sha256').Split(' ')[0].Trim()
$actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()

[pscustomobject]@{
  expected = $expected
  actual = $actual
  match = ($expected -eq $actual)
}
```

## 2. Easiest startup path

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\offline-load-run.ps1 `
  -ArchivePath '.\playwright-player-v0.1.4-docker-image.tar.gz' `
  -ImageRef 'playwright-player:v0.1.4'
```

## 3. Run with plain docker

```powershell
tar -xzf .\playwright-player-v0.1.4-docker-image.tar.gz
docker load -i .\playwright-player-v0.1.4-docker-image.tar

docker run -d `
  --name playwright-player `
  --init `
  --ipc=host `
  -p 3000:3000 `
  -e PORT=3000 `
  -e DEFAULT_HEADLESS=true `
  -e ENABLE_EVALUATE=true `
  playwright-player:v0.1.4
```

> If `--ipc=host` is not available in your environment, you can omit it.
> Starting from v0.1.4, the server auto-detects the Docker environment and injects `--no-sandbox`, `--disable-dev-shm-usage`, and `--disable-gpu` into Chromium.

## 4. Verification URLs

| URL | Description |
| --- | --- |
| `http://127.0.0.1:3000/health` | Service health check |
| `http://127.0.0.1:3000/docs` | Swagger UI |
| `http://127.0.0.1:3000/playground` | API Playground |
| `http://127.0.0.1:3000/demo/test-page` | Built-in demo test page |

### Verify actual browser readiness

Use **Check the execution environment** in the Playground, or run the following command inside the running container. It tests browser startup, rendering, PNG pixels, and file write/read using the installed browser and actual service permissions.

```bash
docker exec playwright-player npm run --silent doctor -- --json
```

A report with `status: "ok"` has passed all six checks. Failures include `errorCode` and `remediation`. The check blocks page networking, downloads nothing, and removes its temporary session and files. Existing sessions stay open. Exit codes are `0` for success, `1` for failed/incomplete checks, and `2` for connection/authentication failure. For remote operation, use `--url` and the `API_TOKEN` environment variable.

REST `POST /api/diagnostics` and MCP `diagnostics_run` return the same report. Inspect its `status` even when HTTP is 200. The Playground can download the JSON report. `/health` also exposes `pendingSessionCount` and `closingSessionCount`; these count toward session capacity.

## 5. Demo test page verification

`/demo/test-page` is a built-in page that works without any external network.
Follow these steps to quickly verify that the session API is working:

```
1. POST /api/sessions                              → get sessionId
2. POST /api/sessions/{sessionId}/contexts          → get contextId
3. POST /api/sessions/{sessionId}/contexts/{contextId}/pages → get pageId
4. POST /api/sessions/{sessionId}/pages/{pageId}/goto
     body: { "url": "http://127.0.0.1:3000/demo/test-page" }
5. POST /api/sessions/{sessionId}/pages/{pageId}/inspect
6. POST /api/sessions/{sessionId}/pages/{pageId}/screenshot
```

- **goto**: If `status: 200` is returned, the Chromium renderer is working correctly.
- **inspect**: Returns headings, interactive elements, and locator candidates as JSON.
- **screenshot**: Download the PNG via `/api/sessions/{sessionId}/artifacts/{artifactId}`.

> If all three steps succeed, browser automation is fully operational in your offline environment.

## 6. Offline screenshots and browser configuration

In Docker, the server keeps selecting `channel=chromium` and applying its container launch flags. Headless shell also supports navigation and screenshots, so the binary choice alone does not explain a capture failure. Check that the installed browser matches the pinned Playwright package first.

External fonts or scripts may never finish loading on an isolated network. Screenshots no longer add a `DOMContentLoaded` wait and, by default, capture the currently rendered page without waiting for webfonts.

- `SCREENSHOT_TIMEOUT_MS=30000`: default capture deadline; override with a positive request `timeoutMs`.
- `SCREENSHOT_WAIT_FOR_FONTS=false`: default. If exact webfonts are required, serve them from reachable internal URLs and set this to `true`.
- `FAILURE_ARTIFACT_TIMEOUT_MS=5000`: shared deadline for failure evidence. A failed screenshot is not immediately retried as failure evidence.

Wait for the required text or element using `browser_wait_for` or REST assertions before capture. If navigation itself stalls on resources, use REST `goto` with `waitUntil: "domcontentloaded"` or `"commit"`, then wait for the required elements separately.

MCP clients can call `browser_navigate` → `browser_snapshot` → `browser_take_screenshot` without explicit session/page IDs. Both screenshot tool names return standard MCP image content. `filename` names a server artifact, not a client-local path. REST artifact downloads still require the configured API authentication.

Built-in UI and Swagger assets are served locally, and Swagger's external validator is disabled. Build the image with dependencies and browsers in a connected build environment before transferring it. Runtime operation does not require `npx ...@latest` or a browser installation command.

## 7. Operational notes

- Put scripts under `/app/scripts` or a mounted `offline-runtime/scripts`
- Place storage states in the mounted `storage-states` directory
- Artifacts accumulate in the mounted `data` directory
- Built-in pages auto-switch between Korean and English based on browser language

## 8. Troubleshooting

| Symptom | Check | Action |
| --- | --- | --- |
| Capture stalls | External font requests, readiness, timeout | Keep font waiting disabled, set `timeoutMs`, explicitly wait for required elements |
| MCP shows only a file path | Server version and client image support | Use the updated server and inspect `content` image blocks, or fetch the authenticated artifact |
| Preview/download returns 401 | Missing API token | Enter the token in the UI or supply the Authorization header |
| Blank screenshot | DOM/application data readiness | Inspect snapshot, console, and network output; wait for the required elements |
| `Target closed` or `Browser closed` | Container memory, shared memory, browser logs | Inspect logs, adjust memory, and use `--ipc=host` or `--shm-size` as appropriate |
| Browser executable missing | Package/browser version and image contents | Rebuild with the pinned browser in a connected environment and transfer the image |

> For the full procedure, pair this guide with `docs/OFFLINE_DOCKER_GUIDE_KO.md` and `tools/offline-load-run.ps1` in the repository.
