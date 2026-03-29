# Offline deployment

This is the shortest path for loading the released Docker image `tar.gz` into an air-gapped environment.

## Prerequisites

- Docker Engine or Docker Desktop
- `playwright-player-vX.Y.Z-docker-image.tar.gz`
- `playwright-player-vX.Y.Z-docker-image.tar.gz.sha256`

## 1. Verify the checksum

```powershell
$file = '.\playwright-player-v0.1.3-docker-image.tar.gz'
$expected = (Get-Content '.\playwright-player-v0.1.3-docker-image.tar.gz.sha256').Split(' ')[0].Trim()
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
  -ArchivePath '.\playwright-player-v0.1.3-docker-image.tar.gz' `
  -ImageRef 'playwright-player:v0.1.3'
```

## 3. Run with plain docker

```powershell
tar -xzf .\playwright-player-v0.1.3-docker-image.tar.gz
docker load -i .\playwright-player-v0.1.3-docker-image.tar

docker run -d `
  --name playwright-player `
  --init `
  --ipc=host `
  -p 3000:3000 `
  -e PORT=3000 `
  -e DEFAULT_HEADLESS=true `
  -e ENABLE_EVALUATE=true `
  playwright-player:v0.1.3
```

## 4. Verification URLs

- `http://127.0.0.1:3000/health`
- `http://127.0.0.1:3000/docs`
- `http://127.0.0.1:3000/playground`
- `http://127.0.0.1:3000/demo/test-page`

## 5. Operational notes

- Put scripts under `/app/scripts` or a mounted `offline-runtime/scripts`
- Place storage states in the mounted `storage-states` directory
- Artifacts accumulate in the mounted `data` directory
- Built-in pages auto-switch between Korean and English based on browser language

> For the full procedure, pair this guide with `docs/OFFLINE_DOCKER_GUIDE_KO.md` and `tools/offline-load-run.ps1` in the repository.
