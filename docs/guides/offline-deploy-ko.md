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

오프라인 Docker 환경에서 `docker run`으로 실행할 때 세션은 생성되지만 `goto`, `inspect`, `screenshot` 등 페이지 조작이 실패하는 문제가 있었습니다.

### 원인: `chromium-headless-shell` 바이너리

Playwright 1.58 이상에서 `headless: true`(기본값)로 실행하면 full Chromium 대신 **`chromium-headless-shell`** 경량 바이너리를 사용합니다. 이 바이너리는 일부 페이지 조작 기능(`page.goto`, `page.evaluate`, `page.screenshot`)이 Docker 환경에서 정상 동작하지 않을 수 있습니다.

- 브라우저 프로세스 자체는 시작되므로 **세션 생성은 성공**합니다.
- 하지만 페이지 렌더링이 필요한 조작은 **renderer 프로세스가 올바르게 동작하지 않아 실패**합니다.

### 수정: full Chromium 바이너리 자동 선택

v0.1.4부터 서버가 Docker 환경을 자동 감지하면 `channel=chromium`을 설정하여 full Chromium 바이너리를 사용합니다. `--no-sandbox`, `--disable-dev-shm-usage` 등 필수 플래그는 Playwright가 자동으로 추가합니다.

서버 시작 로그에 아래 메시지가 출력되면 자동 감지가 동작한 것입니다:

```
Docker environment detected — Chromium will use full browser (channel=chromium) instead of headless-shell
```

수동으로 channel을 지정하려면 세션 생성 시 `channel` 파라미터를 전달합니다:

```json
POST /api/sessions
{ "channel": "chromium" }
```

## 7. 운영 팁

- 스크립트는 `/app/scripts` 또는 마운트한 `offline-runtime/scripts`에 둡니다.
- 인증 상태 파일은 `storage-states` 경로에 둡니다.
- 산출물은 `data` 경로에 쌓입니다.
- 내장 페이지는 브라우저 언어에 따라 한국어/영어를 자동 전환합니다.

## 8. 트러블슈팅

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| 세션은 생성되지만 goto/inspect/screenshot 실패 | `chromium-headless-shell` 바이너리가 Docker에서 페이지 조작 미지원 | v0.1.4 이상 사용 (자동으로 full Chromium 선택), 또는 세션 생성 시 `"channel": "chromium"` 지정 |
| `Target closed` 또는 `Browser closed` 오류 | `/dev/shm` 64MB 초과 | `--ipc=host` 추가 (Playwright가 `--disable-dev-shm-usage`를 이미 기본 적용) |
| 스크린샷이 빈 화면 | headless-shell 렌더링 제한 | `"channel": "chromium"` 으로 full Chromium 사용 |
| 컨테이너 시작 직후 crash | 이미지 아키텍처 불일치 | `docker inspect` 로 이미지 arch 확인 (amd64 필요) |

> 상세 절차는 저장소의 `docs/OFFLINE_DOCKER_GUIDE_KO.md`와 `tools/offline-load-run.ps1`를 함께 참고하면 됩니다.
