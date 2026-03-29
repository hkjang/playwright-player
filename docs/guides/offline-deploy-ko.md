# 오프라인 배포

외부망에서 받은 Docker 이미지 `tar.gz`를 오프라인망으로 반입한 뒤 가장 단순하게 띄우는 방법입니다.

## 준비물

- Docker Engine 또는 Docker Desktop
- `playwright-player-vX.Y.Z-docker-image.tar.gz`
- `playwright-player-vX.Y.Z-docker-image.tar.gz.sha256`

## 1. 체크섬 검증

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

## 2. 가장 쉬운 실행

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\offline-load-run.ps1 `
  -ArchivePath '.\playwright-player-v0.1.3-docker-image.tar.gz' `
  -ImageRef 'playwright-player:v0.1.3'
```

## 3. 직접 docker 로 실행

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

## 4. 점검 URL

- `http://127.0.0.1:3000/health`
- `http://127.0.0.1:3000/docs`
- `http://127.0.0.1:3000/playground`
- `http://127.0.0.1:3000/demo/test-page`

## 5. 운영 팁

- 스크립트는 `/app/scripts` 또는 마운트한 `offline-runtime/scripts`에 둡니다.
- 인증 상태 파일은 `storage-states` 경로에 둡니다.
- 산출물은 `data` 경로에 쌓입니다.
- 내장 페이지는 브라우저 언어에 따라 한국어/영어를 자동 전환합니다.

> 상세 절차는 저장소의 `docs/OFFLINE_DOCKER_GUIDE_KO.md`와 `tools/offline-load-run.ps1`를 함께 참고하면 됩니다.
