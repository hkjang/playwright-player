# playwright-player

단일 Docker 컨테이너에서 동작하는 Playwright 자동화 서버입니다. 두 가지 인터페이스를 제공합니다.

- 상태 유지형 REST API
- AI agent 호출용 Streamable MCP HTTP endpoint

오프라인망 자동화 기준으로, 스크립트 실행 API와 저수준 세션 디버그 API를 함께 제공합니다.

## 포함된 기능

- `scripts` 레지스트리 스캔, 상세 조회, sync, validate
- `runs` 생성, 상태 조회, 취소, 로그, 리포트, 아티팩트 목록
- `sessions / contexts / pages` 기반의 상태 유지형 브라우저 제어
- locator 기반 `click / fill / press / hover / drag / evaluate / query`
- `assert/visible`, `assert/text`, `assert/url`, `assert/count`
- screenshot, pdf, trace, storage state import/export
- LLM 보조 API: `assist/capabilities`, `assist/examples`, `assist/plan`, `assist/scaffold`
- 실제 DOM 검증을 포함한 페이지 구조 분석 `page_inspect`
- 브라우저 언어 기반 `ko/en` 전환 지원 홈, 플레이그라운드, 데모 페이지
- Streamable MCP `POST /mcp`, `DELETE /mcp`
- `API_TOKEN` 기반 선택적 인증, 경로 탈출 차단, 동시 실행/세션 상한

## 스크립트 규칙

`/app/scripts` 아래의 다음 패턴을 자동 등록합니다. 업로드 경로는 항상 `SCRIPTS_DIR` 안으로 제한되고, 위 확장자가 아니면 거부됩니다.

- `*.spec.js`
- `*.spec.ts`
- `*.test.js`
- `*.test.ts`
- `*.pw.js`
- `*.pw.ts`

예를 들어 `scripts/checkout/guest-order.spec.ts` 는 `checkout/guest-order` 로 등록됩니다.

`SCRIPTS_DIR` 와 `RUNS_DIR` 은 프로젝트 바깥(마운트된 볼륨 등)에 두어도 됩니다. 실행 프로세스에는 서버 설치본의 `node_modules` 가 `NODE_PATH` 로 전달되고, 생성된 config 도 서버 설치본을 기준으로 `@playwright/test` 를 해석합니다.

테스트 런타임에는 아래 환경 변수만 주입됩니다. 서버 프로세스의 나머지 환경변수(`API_TOKEN` 포함)는 전달되지 않으며, 추가가 필요하면 `RUN_ENV_PASSTHROUGH` 에 이름을 명시하세요.

- `PW_PLAYER_RUN_ID`
- `PW_PLAYER_SCRIPT_KEY`
- `PW_PLAYER_TARGET_ENV`
- `PW_PLAYER_BASE_URL`
- `PW_PLAYER_VARIABLES_JSON`
- `PW_PLAYER_STORAGE_STATE`

`assist/scaffold` 가 생성하는 스크립트는 이 값을 읽어 기본값 위에 덮어씁니다.

```js
const defaultVariables = { "sku": "ABC-1001" };
const variables = { ...defaultVariables, ...JSON.parse(process.env.PW_PLAYER_VARIABLES_JSON || "{}") };
```

## 실행

### 로컬

```bash
npm install
npx playwright install chromium
node server.js
```

### 스모크 테스트

서버를 임시 포트와 임시 데이터 디렉터리로 띄워 REST, MCP, 실제 브라우저 세션까지 한 번에 검증합니다.

```bash
npm test
```

브라우저가 설치되지 않은 경우에만 브라우저 의존 항목이 `SKIP` 으로 표시됩니다. 그 밖의 브라우저 실행 실패는 `FAIL` 입니다. 릴리즈 검증처럼 브라우저가 반드시 있어야 하는 환경에서는 미설치도 실패로 처리하도록 `SMOKE_REQUIRE_BROWSER=1` 을 지정하세요.

```bash
SMOKE_REQUIRE_BROWSER=1 npm test
```

### Docker

```bash
docker compose up --build
```

Playwright 공식 권장값에 맞춰 Compose 예시는 `init: true`, `ipc: host` 를 사용합니다.

### 오프라인망 Docker 이미지 실행

릴리즈에 포함된 Docker 이미지 `tar.gz`를 오프라인망으로 반입한 뒤 실행하는 절차는 [docs/OFFLINE_DOCKER_GUIDE_KO.md](docs/OFFLINE_DOCKER_GUIDE_KO.md)에 정리했습니다.

가장 빠른 방법:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\offline-load-run.ps1 `
  -ArchivePath ".\playwright-player-v0.1.3-docker-image.tar.gz" `
  -ImageRef "playwright-player:v0.1.3"
```

## REST API

기본 prefix 는 `/api` 입니다.

### Script Registry

- `GET /api/scripts`
- `GET /api/scripts/{scriptKey}`
- `PUT /api/scripts/{scriptKey}`
- `DELETE /api/scripts/{scriptKey}`
- `POST /api/scripts/sync`
- `POST /api/scripts/validate`

### Runs

- `POST /api/runs`
- `GET /api/runs`
- `GET /api/runs/{runId}`
- `DELETE /api/runs/{runId}`
- `POST /api/runs/{runId}/cancel`
- `GET /api/runs/{runId}/artifacts`
- `GET /api/runs/{runId}/artifacts/{relativePath}`
- `GET /api/runs/{runId}/report`
- `GET /api/runs/{runId}/logs`

### LLM Assist

- `GET /api/assist/capabilities`
- `GET /api/assist/examples`
- `POST /api/assist/plan`
- `POST /api/assist/scaffold`

예시:

```json
{
  "scriptKey": "checkout/guest-order",
  "project": "chromium",
  "env": "staging",
  "baseURL": "https://stg.example.com",
  "grep": "@smoke",
  "headed": false,
  "trace": "on-first-retry",
  "video": "retain-on-failure",
  "storageStateRef": "auth/customer.json",
  "variables": {
    "sku": "ABC-1001",
    "locale": "ko-KR"
  }
}
```

### Sessions

전체 목록은 Swagger UI(`/docs`)에 모두 문서화되어 있습니다.

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{sessionId}`
- `DELETE /api/sessions/{sessionId}`
- `POST /api/sessions/{sessionId}/keepalive`
- `POST /api/sessions/{sessionId}/contexts`
- `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
- `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
- `POST /api/sessions/{sessionId}/pages/{pageId}/inspect`
- `POST /api/sessions/{sessionId}/pages/{pageId}/click`
- `POST /api/sessions/{sessionId}/pages/{pageId}/fill`
- `POST /api/sessions/{sessionId}/pages/{pageId}/assert/text`
- `POST /api/sessions/{sessionId}/pages/{pageId}/screenshot`
- `POST /api/sessions/{sessionId}/execute`

## MCP

MCP endpoint 는 `/mcp` 입니다.

- `POST /mcp`
- `GET /mcp`
  현재 SSE stream 은 열지 않고 `405` 를 반환합니다.
- `DELETE /mcp`

초기화 응답 헤더의 `Mcp-Session-Id` 값을 이후 요청에 계속 넣으면 됩니다. 같은 origin 과 loopback 에서 오는 호출은 항상 허용되고, 그 밖의 origin 은 `ALLOWED_ORIGINS` 에 등록해야 합니다. JSON-RPC notification 은 규격대로 본문 없는 `202` 로 응답합니다.

제공 도구:

- `script_list`, `script_get`, `script_sync`, `script_upload`, `script_delete`, `script_validate`
- `assist_capabilities`, `assist_examples`, `assist_plan`, `assist_scaffold`
- `run_create`, `run_list`, `run_get`, `run_cancel`, `run_delete`, `run_artifacts`, `run_report`, `run_logs`
- `session_list`, `session_create`, `session_get`, `session_delete`, `session_keepalive`
- `context_create`, `context_get`, `context_delete`
- `context_storage_export`, `context_storage_import`
- `context_route_add`, `context_route_remove`
- `context_cookies`, `context_permissions`, `context_headers`
- `page_create`, `page_get`, `page_inspect`, `page_delete`
- `page_navigate`, `page_action`, `page_assert`, `page_wait_for`
- `page_screenshot`, `page_pdf`
- `session_trace`, `session_execute`, `session_artifacts`, `session_actions`

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 수신 포트 |
| `API_BASE_PATH` | `/api` | REST prefix |
| `MCP_BASE_PATH` | `/mcp` | MCP endpoint |
| `API_TOKEN` | 없음 | 설정하면 `/api` 와 `/mcp` 가 `Authorization: Bearer <token>` 을 요구합니다. `/health`, 내장 페이지, Swagger 정적 파일은 계속 공개됩니다. localhost 밖으로 노출되는 배포에서는 반드시 설정하세요. |
| `ALLOWED_ORIGINS` | 없음 | MCP 를 호출할 수 있는 추가 cross-origin 목록입니다. same-origin 과 loopback 은 항상 허용됩니다. |
| `URL_ALLOWLIST` | 없음 | `page.goto` 가 접근할 수 있는 host 목록입니다. `*.example.com` 형태를 지원합니다. |
| `ENABLE_EVALUATE` | `true` | `false` 면 `page.evaluate` 가 `403` 을 반환합니다. |
| `DEFAULT_DIALOG_ACTION` | `dismiss` | `alert`/`confirm`/`prompt` 기본 처리. `accept`, `dismiss`, `ignore` 중 선택합니다. `ignore` 는 대화상자를 열어둔 채로 두므로 이를 띄운 동작이 타임아웃됩니다. |
| `DEFAULT_DIALOG_PROMPT_TEXT` | 빈 문자열 | `accept` 시 `prompt()` 에 입력할 값 |
| `ROUTE_FIXTURES_DIR` | `SCRIPTS_DIR` | `route` 의 `behavior.path` 로 지정할 수 있는 파일의 루트. 이 밖의 경로는 거부됩니다. |
| `RUN_ENV_PASSTHROUGH` | 없음 | 실행 프로세스에 추가로 전달할 환경변수 이름(CSV). 기본적으로 `PATH`, `HOME`, `PLAYWRIGHT_*` 등 최소 집합만 전달되고 `API_TOKEN` 같은 서버 비밀값은 전달되지 않습니다. |
| `VALIDATION_TIMEOUT_MS` | `60000` | `scripts/validate` 실행 상한 |
| `COMMAND_OUTPUT_LIMIT_BYTES` | `262144` | 외부 명령 출력 캡처 상한 |
| `MAX_RETAINED_ARTIFACTS` | `2000` | 세션과 별개로 보관하는 증적 메타데이터 개수 |
| `SCRIPTS_DIR` / `RUNS_DIR` / `ARTIFACTS_DIR` / `STORAGE_STATE_DIR` | `./scripts`, `./data/runs`, `./data/artifacts`, `./storage-states` | 업로드·실행 산출물·스토리지 상태가 놓이는 루트입니다. 요청으로 전달된 경로는 이 루트 밖으로 나갈 수 없습니다. |
| `MAX_SESSIONS` | `10` | 동시 브라우저 세션 상한. 초과 시 `429 SESSION_LIMIT_EXCEEDED` |
| `MAX_CONTEXTS_PER_SESSION` | `5` | 세션당 컨텍스트 상한 |
| `MAX_PAGES_PER_SESSION` | `10` | 세션당 페이지 상한 |
| `MAX_CONCURRENT_RUNS` | `4` | 동시 run 상한. 초과 시 `429 RUN_LIMIT_EXCEEDED` |
| `MAX_RETAINED_RUNS` | `50` | 이 개수를 넘으면 오래된 run 기록과 디스크 산출물을 정리합니다. |
| `SESSION_TTL_MS` | `1800000` | 세션 만료 시간 |
| `MCP_SESSION_TTL_MS` | `3600000` | MCP 세션 기록 만료 시간 |
| `CAPTURE_FAILURE_ARTIFACTS` | `true` | 실패 시 스크린샷/DOM 저장 여부. 요청 본문이 잘못된 `4xx` 는 저장하지 않고, 타임아웃과 실제 자동화 실패만 저장합니다. |
| `PURGE_SESSION_ARTIFACTS_ON_CLOSE` | `false` | `true` 면 세션 종료 시 아티팩트 디렉터리를 삭제합니다. |
| `DEFAULT_BROWSER_TYPE` | `chromium` | 기본 브라우저 |
| `DEFAULT_HEADLESS` | `true` | 기본 headless 여부 |
| `PLAYWRIGHT_LAUNCH_ARGS` | 없음 | 브라우저 launch 인자 (CSV) |
| `BODY_LIMIT` | `5mb` | 요청 본문 상한 |

## 대화상자 처리

Playwright 는 `dialog` 리스너가 **없을 때만** 대화상자를 자동으로 닫습니다. 이 서버는 기록을 위해 항상 리스너를 붙이므로, 정책을 명시적으로 정하지 않으면 `alert`/`confirm`/`prompt` 를 띄운 클릭이 타임아웃됩니다. 기본값은 `dismiss` 이고 세 단계로 재정의할 수 있습니다.

1. 서버 기본값: `DEFAULT_DIALOG_ACTION`
2. 컨텍스트 생성 시: `{"dialogPolicy": {"action": "accept", "promptText": "..."}}`
3. 페이지 단위: `POST /api/sessions/{id}/pages/{pageId}/dialog-policy`

처리 결과는 페이지 응답의 `lastDialog` 와 `sessions/{id}/actions` 의 이벤트 로그에서 확인할 수 있습니다.

## Locator 검증

`page_inspect` 는 후보 locator 를 **실제 DOM 에 적용해 본 뒤** 결과를 함께 반환합니다. 전략별 고정 점수(예: `testId`=1, `label`=0.98)만으로는 해당 locator 가 정말 하나의 요소를 가리키는지 알 수 없기 때문입니다.

요소별 필드:

| 필드 | 의미 |
| --- | --- |
| `locatorStatus` | `unique` / `ambiguous` / `not-found` |
| `locatorUnique` | `bestLocator` 가 정확히 한 요소에 대응하는지 |
| `bestLocator` | 검증을 통과한 locator. 고유한 의미 기반 locator 를 우선하고, 구분이 불가능할 때만 `nth` 를 붙입니다 |
| `enabled` | 선택된 locator 의 활성 상태 |

후보별 필드:

| 필드 | 의미 |
| --- | --- |
| `matchCount` | 실제 일치 요소 수 |
| `verifiedConfidence` | 일치 수를 반영한 점수. 0 이면 사용하면 안 됩니다 |
| `refinedLocator` | 모호한 경우 `hasText` 또는 `nth` 로 좁힌 대안 |

응답 최상위의 `locatorVerification` 에 페이지 전체 요약(`unique`/`ambiguous`/`not-found`/`refined`)이 담깁니다.

예를 들어 같은 이름의 버튼이 4개이고 그중 하나에만 `data-testid` 가 있는 페이지에서는, `testId` 가 있는 요소는 `{"testId": "..."}` 를, 나머지 3개는 `{"role": "button", "name": "Save", "nth": 0|1|2}` 를 받습니다. 검증 전에는 네 요소 모두 `{"role": "button", "name": "Save"}` 를 신뢰도 0.95 로 제시했고, 이를 그대로 클릭하면 항상 첫 번째 버튼이 눌렸습니다.

빠른 스냅샷만 필요하면 `verifyLocators: false` 로 끌 수 있고, 요소당 검증 후보 수는 `maxVerifiedCandidates` (기본 3) 로 조절합니다.

## 스크립트 검사 모드

`POST /api/scripts/validate` 는 두 가지 모드를 제공합니다.

| 모드 | 동작 | 대상 |
| --- | --- | --- |
| `syntax` | 파일을 **로드하지 않고** 구문만 검사합니다 (`node --check`). JavaScript 전용. | 신뢰할 수 없는 스크립트의 1차 확인 |
| `discover` (기본값) | Playwright `--list` 로 테스트를 탐색합니다. 파일을 로드하므로 **모듈 최상위 코드가 실행됩니다.** | 실제 테스트 목록 확인 |

응답의 `executesModuleScope` 로 어느 쪽인지 구분할 수 있습니다.

## 오류 응답

모든 오류는 동일한 형태로 반환됩니다. 알 수 없는 경로와 잘못된 JSON 도 HTML 대신 이 형태를 따릅니다.

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "key is required for press (for example \"Enter\")",
    "details": { "sessionId": "sess_...", "pageId": "page_..." },
    "requestId": "req_..."
  }
}
```

주요 코드:

- `400 INVALID_REQUEST`, `400 INVALID_JSON`, `400 INVALID_LOCATOR`, `400 PATH_OUTSIDE_ROOT`
- `401 UNAUTHORIZED`
- `403 EVALUATE_DISABLED`, `403 URL_NOT_ALLOWED`, `403 MCP_ORIGIN_DENIED`
- `404 SCRIPT_NOT_FOUND`, `404 SESSION_NOT_FOUND`, `404 PAGE_NOT_FOUND`, `404 NOT_FOUND`
- `408 TIMEOUT` — assertion 또는 Playwright 타임아웃
- `409 SESSION_DISCONNECTED`, `409 TRACE_NOT_STARTED`, `409 SCRIPT_ALREADY_EXISTS`
- `429 SESSION_LIMIT_EXCEEDED`, `429 RUN_LIMIT_EXCEEDED`

## 주의 사항

- `proxy` 를 context 수준에서 동적으로 바꾸는 기능은 이번 구현에 포함하지 않았습니다.
- `storage-state/import` 는 컨텍스트를 새로 만들기 때문에 기존 페이지가 닫힙니다. 응답의 `replacedPages` 에 닫힌 page id 가 담기며, 이후 `pages` 를 다시 생성해야 합니다.
- `sessions/{id}/execute` 는 배치 전체가 하나의 세션 락 안에서 실행되므로 중간에 다른 요청이 끼어들지 않습니다. `continueOnError: true` 를 주면 실패한 단계 이후도 계속 진행하고 단계별 결과를 모두 반환합니다.
- `URL_ALLOWLIST` 는 세션 브라우저의 **모든 요청**에 적용됩니다(리다이렉트·iframe·XHR 포함). 다만 `POST /api/runs` 로 실행되는 스크립트는 별도 프로세스이므로 이 정책이 적용되지 않습니다. 실행 격리는 다음 단계 과제입니다.
- `page.evaluate` 의 `expression` 은 `"() => document.title"` 같은 함수 형태와 `"1 + 2"` 같은 단순 식을 모두 지원하며, 함수인 경우 `arg` 가 인자로 전달됩니다.
- MCP는 Streamable HTTP 규격의 POST/DELETE 중심으로 구현했고, GET 기반 SSE stream 은 아직 비활성화했습니다.
- 브라우저 세션은 메모리에 유지됩니다. 컨테이너 재시작 시 세션과 런 상태는 초기화됩니다.

## 내장 페이지

- `/`
  - 링크 허브 및 상태 진입점
- `/playground`
  - 브라우저에서 직접 REST API를 호출하는 운영자용 플레이그라운드
- `/demo/test-page`
  - `data-testid`가 안정적으로 유지되는 로컬 데모 페이지

세 페이지 모두 브라우저의 `Accept-Language`를 따라 한국어와 영어를 자동 전환하며, `?lang=ko`, `?lang=en`으로 강제 지정할 수 있습니다.
