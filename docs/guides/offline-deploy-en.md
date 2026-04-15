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

## 6. Docker Chromium auto-configuration (v0.1.4+)

In offline Docker environments, sessions could be created but page operations (`goto`, `inspect`, `screenshot`) would fail.

### Root cause: `chromium-headless-shell` binary

Starting from Playwright 1.58, running with `headless: true` (the default) selects the lightweight **`chromium-headless-shell`** binary instead of full Chromium. This binary lacks full page functionality and may fail on `page.goto`, `page.evaluate`, and `page.screenshot` inside Docker containers.

- The browser main process starts successfully, so **session creation succeeds**.
- However, page operations fail because the **renderer process does not work correctly**.

### Fix: automatic full Chromium selection

Starting from v0.1.4, the server auto-detects the Docker environment and sets `channel=chromium` to force the full Chromium binary. Essential flags like `--no-sandbox` and `--disable-dev-shm-usage` are already added automatically by Playwright.

When the server starts, the following log confirms auto-detection:

```
Docker environment detected — Chromium will use full browser (channel=chromium) instead of headless-shell
```

To manually specify the channel, pass it when creating a session:

```json
POST /api/sessions
{ "channel": "chromium" }
```

## 7. Operational notes

- Put scripts under `/app/scripts` or a mounted `offline-runtime/scripts`
- Place storage states in the mounted `storage-states` directory
- Artifacts accumulate in the mounted `data` directory
- Built-in pages auto-switch between Korean and English based on browser language

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Session created but goto/inspect/screenshot fail | `chromium-headless-shell` binary lacks full page functionality in Docker | Use v0.1.4+ (auto-selects full Chromium), or pass `"channel": "chromium"` when creating a session |
| `Target closed` or `Browser closed` error | `/dev/shm` exceeded 64MB | Add `--ipc=host` (Playwright already applies `--disable-dev-shm-usage` by default) |
| Screenshot is blank | headless-shell rendering limitation | Use `"channel": "chromium"` for full Chromium |
| Container crashes immediately after start | Image architecture mismatch | Check image arch with `docker inspect` (amd64 required) |

> For the full procedure, pair this guide with `docs/OFFLINE_DOCKER_GUIDE_KO.md` and `tools/offline-load-run.ps1` in the repository.
