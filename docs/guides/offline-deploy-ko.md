# 오프라인 배포

외부망에서 받은 Docker 이미지 `tar.gz`를 오프라인망으로 반입한 뒤 가장 단순하게 띄우는 방법입니다.

## 준비물

- Docker Engine 또는 Docker Desktop
- `playwright-player-vX.Y.Z-docker-image.tar.gz`
- `playwright-player-vX.Y.Z-docker-image.tar.gz.sha256`

## 1. 체크섬 검증

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

## 2. 가장 쉬운 실행

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\offline-load-run.ps1 `
  -ArchivePath '.\playwright-player-v0.1.4-docker-image.tar.gz' `
  -ImageRef 'playwright-player:v0.1.4'
```

## 3. 직접 docker 로 실행

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

> `--ipc=host`를 사용할 수 없는 환경이라면 생략해도 됩니다.
> v0.1.4부터 서버가 Docker 환경을 자동 감지하여 `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`를 Chromium에 주입합니다.

## 4. 점검 URL

| URL | 설명 |
| --- | --- |
| `http://127.0.0.1:3000/health` | 서비스 상태 확인 |
| `http://127.0.0.1:3000/docs` | Swagger UI |
| `http://127.0.0.1:3000/playground` | API Playground |
| `http://127.0.0.1:3000/demo/test-page` | 내장 데모 테스트 페이지 |

## 5. 데모 테스트 페이지 검증

`/demo/test-page`는 외부 네트워크 없이 동작하는 내장 페이지입니다.
세션 API가 정상인지 빠르게 확인하려면 아래 순서를 따릅니다.

```
1. POST /api/sessions                              → sessionId 획득
2. POST /api/sessions/{sessionId}/contexts          → contextId 획득
3. POST /api/sessions/{sessionId}/contexts/{contextId}/pages → pageId 획득
4. POST /api/sessions/{sessionId}/pages/{pageId}/goto
     body: { "url": "http://127.0.0.1:3000/demo/test-page" }
5. POST /api/sessions/{sessionId}/pages/{pageId}/inspect
6. POST /api/sessions/{sessionId}/pages/{pageId}/screenshot
```

- **goto**: 페이지 이동 후 `status: 200`이 반환되면 Chromium 렌더러가 정상 동작하는 것입니다.
- **inspect**: 페이지의 heading, interactive element, locator 후보가 JSON으로 반환됩니다.
- **screenshot**: `/api/sessions/{sessionId}/artifacts/{artifactId}` 경로로 PNG를 다운로드할 수 있습니다.

> 위 세 단계가 모두 성공하면 오프라인 환경에서 브라우저 자동화가 정상 동작하는 것입니다.

## 6. Docker 환경 Chromium 자동 설정 (v0.1.4+)

오프라인 Docker 환경에서 `docker run`으로 직접 실행할 때 Chromium 렌더러가 동작하지 않는 문제가 있었습니다.
v0.1.4부터 서버가 Docker 환경을 자동으로 감지하고 아래 플래그를 Chromium 실행 시 자동 주입합니다.

| 플래그 | 역할 |
| --- | --- |
| `--no-sandbox` | 컨테이너 내부 root 실행 시 Chromium sandbox 비활성화 |
| `--disable-dev-shm-usage` | `/dev/shm` 64MB 제한 우회 (`/tmp` 사용) |
| `--disable-gpu` | GPU 가속 비활성화 (Docker 내부 GPU 드라이버 없음) |

서버 시작 로그에 아래 메시지가 출력되면 자동 감지가 동작한 것입니다:

```
Docker environment detected — Chromium will launch with --no-sandbox --disable-dev-shm-usage --disable-gpu
```

수동으로 플래그를 지정하려면 환경변수를 사용합니다:

```powershell
-e PLAYWRIGHT_LAUNCH_ARGS="--no-sandbox,--disable-dev-shm-usage,--disable-gpu"
```

## 7. 운영 팁

- 스크립트는 `/app/scripts` 또는 마운트한 `offline-runtime/scripts`에 둡니다.
- 인증 상태 파일은 `storage-states` 경로에 둡니다.
- 산출물은 `data` 경로에 쌓입니다.
- 내장 페이지는 브라우저 언어에 따라 한국어/영어를 자동 전환합니다.

## 8. 트러블슈팅

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| 세션은 생성되지만 goto/inspect/screenshot 실패 | Chromium renderer sandbox 또는 공유 메모리 부족 | v0.1.4 이상 사용, 또는 `PLAYWRIGHT_LAUNCH_ARGS` 수동 설정 |
| `Target closed` 또는 `Browser closed` 오류 | `/dev/shm` 64MB 초과 | `--ipc=host` 추가 또는 `--disable-dev-shm-usage` 플래그 |
| 스크린샷이 빈 화면 | GPU 렌더링 실패 | `--disable-gpu` 플래그 확인 |
| 컨테이너 시작 직후 crash | 이미지 아키텍처 불일치 | `docker inspect` 로 이미지 arch 확인 (amd64 필요) |

> 상세 절차는 저장소의 `docs/OFFLINE_DOCKER_GUIDE_KO.md`와 `tools/offline-load-run.ps1`를 함께 참고하면 됩니다.
