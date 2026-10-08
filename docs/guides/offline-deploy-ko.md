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

### 실제 실행 환경 검사

Playground의 **실행 환경 점검** 또는 아래 명령으로 브라우저 실행·화면 렌더링·PNG 픽셀·파일 저장을 확인할 수 있습니다. 실행 중인 컨테이너에서 호출하므로 이미지에 포함된 브라우저와 실행 사용자의 권한을 그대로 검사합니다.

```bash
docker exec playwright-player npm run --silent doctor -- --json
```

`status: "ok"`이면 여섯 항목이 모두 통과한 것입니다. 실패 항목의 `errorCode`와 `remediation`으로 조치할 수 있습니다. 외부 사이트에 접속하거나 브라우저를 내려받지 않으며, 점검용 세션과 파일은 정리합니다. 이미 사용 중인 세션은 닫지 않습니다. CLI 종료 코드 `0`은 통과, `1`은 실패·일부 확인 불가, `2`는 접속·인증 실패입니다. 원격 실행에는 `--url`과 `API_TOKEN` 환경변수를 사용하세요.

REST `POST /api/diagnostics`와 MCP `diagnostics_run`도 같은 결과를 반환합니다. HTTP 200이어도 보고서 `status`를 확인해야 합니다. Playground에서 JSON 보고서를 내려받을 수 있습니다. `/health`에는 실행 중 외에 `pendingSessionCount`, `closingSessionCount`가 표시되며 이들도 세션 상한에 포함됩니다.

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

## 6. 오프라인 스크린샷과 브라우저 설정

서버는 Docker에서 기존과 같이 `channel=chromium`을 선택하고 컨테이너 실행 인자를 적용합니다. headless shell도 페이지 이동과 스크린샷을 지원하므로, 캡처 실패를 바이너리 종류만으로 단정하지 마세요. 설치된 브라우저와 Playwright 패키지 버전이 맞는지 먼저 확인합니다.

오프라인망에서는 외부 웹폰트나 스크립트 요청이 끝나지 않을 수 있습니다. 스크린샷은 별도의 `DOMContentLoaded` 대기를 하지 않으며, 기본적으로 웹폰트 로딩 완료를 기다리지 않고 현재 렌더링된 화면을 캡처합니다.

- `SCREENSHOT_TIMEOUT_MS=30000`: 기본 캡처 시간 제한. 양수 `timeoutMs`로 재정의할 수 있습니다.
- `SCREENSHOT_WAIT_FOR_FONTS=false`: 기본값. 웹폰트까지 기다려야 한다면 접근 가능한 내부 경로에 폰트를 배포한 뒤 `true`로 설정하세요.
- `FAILURE_ARTIFACT_TIMEOUT_MS=5000`: 실패 증적 수집 시간 제한. 스크린샷 자체 실패 시 같은 캡처를 다시 시도하지 않습니다.

화면 준비가 필요한 업무는 먼저 `browser_wait_for` 또는 REST assertion으로 필요한 텍스트/요소를 확인하고 캡처하세요. 탐색 자체가 외부 리소스 때문에 타임아웃되면 REST `goto`의 `waitUntil`을 `domcontentloaded` 또는 `commit`으로 지정하고, 필요한 요소를 별도로 기다릴 수 있습니다.

MCP에서는 `browser_navigate` → `browser_snapshot` → `browser_take_screenshot` 순서로 세션/페이지 ID 없이 사용할 수 있습니다. `browser_take_screenshot`과 기존 `page_screenshot` 모두 표준 MCP 이미지 블록을 반환합니다. `filename`은 서버 아티팩트 이름이며 클라이언트의 로컬 저장 경로가 아닙니다. REST 다운로드에는 `API_TOKEN` 인증이 계속 적용됩니다.

내장 UI와 Swagger 자산은 로컬에서 제공되며 Swagger의 외부 검증 서버 호출은 비활성화되어 있습니다. 네트워크 없는 환경에 반입할 이미지는 인터넷이 연결된 빌드 환경에서 의존성과 브라우저를 포함해 미리 빌드해야 합니다. 런타임에 `npx ...@latest` 또는 브라우저 설치 명령을 실행할 필요가 없습니다.

## 7. 운영 팁

- 스크립트는 `/app/scripts` 또는 마운트한 `offline-runtime/scripts`에 둡니다.
- 인증 상태 파일은 `storage-states` 경로에 둡니다.
- 산출물은 `data` 경로에 쌓입니다.
- 내장 페이지는 브라우저 언어에 따라 한국어/영어를 자동 전환합니다.

## 8. 트러블슈팅

| 증상 | 확인 사항 | 조치 |
| --- | --- | --- |
| 캡처가 오래 대기함 | 외부 폰트 요청, 페이지 준비 상태, 요청 시간 제한 | 기본 폰트 대기 생략 유지, `timeoutMs` 설정, 필요한 요소만 명시적으로 대기 |
| MCP에서 파일 경로만 보임 | 서버 버전 및 클라이언트의 MCP 이미지 지원 | 변경된 서버 사용, `content`의 `image` 블록 확인 또는 인증된 REST 다운로드 |
| 미리보기/다운로드가 401 | API 토큰 누락 | UI의 API 토큰 입력 또는 Authorization 헤더 설정 |
| 화면이 비어 있음 | 캡처 시점에 DOM/업무 데이터가 준비됐는지 | `browser_snapshot`과 console/network 도구로 확인 후 필요한 요소 대기 |
| `Target closed` 또는 `Browser closed` | 컨테이너 메모리, 공유 메모리, 브라우저 로그 | 로그 확인 후 메모리 조정, 환경에 맞게 `--ipc=host` 또는 `--shm-size` 적용 |
| 브라우저 실행 파일이 없음 | 패키지/브라우저 버전 및 이미지 빌드 내용 | 고정 버전 브라우저를 포함한 이미지를 외부 빌드 환경에서 다시 만들어 반입 |

> 상세 절차는 저장소의 `docs/OFFLINE_DOCKER_GUIDE_KO.md`와 `tools/offline-load-run.ps1`를 함께 참고하면 됩니다.
