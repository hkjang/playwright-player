# playwright-player

단일 Docker 컨테이너에서 동작하는 Playwright 자동화 서버입니다. 두 가지 인터페이스를 제공합니다.

- 상태 유지형 REST API
- AI agent 호출용 Streamable MCP HTTP endpoint

오프라인망 자동화 기준으로, 스크립트 실행 API와 저수준 세션 디버그 API를 함께 제공합니다.

## 포함된 기능

- `scripts` 레지스트리 스캔, 상세 조회, sync, validate
- `runs` 대기열 기반 실행, 디스크 영속 이력, 재시작 복구, 스크립트 버전 고정, 취소·재시도, 로그·리포트·아티팩트
- `sessions / contexts / pages` 기반의 상태 유지형 브라우저 제어
- locator 기반 `click / fill / press / hover / drag / evaluate / query`
- `assert/visible`, `assert/text`, `assert/url`, `assert/count`
- screenshot, pdf, trace, storage state import/export
- LLM 보조 API: `assist/capabilities`, `assist/examples`, `assist/plan`, `assist/scaffold`
- 실제 DOM 검증을 포함한 페이지 구조 분석 `page_inspect`
- 단계별 소요시간·콘솔/네트워크 오류·증적을 연결한 실행 타임라인
- API 응답·다운로드 파일 내용·처리번호까지 확인하는 업무 결과 검증
- 실행 목록과 단계별 타임라인을 보여주는 `/runs` 화면
- 환경·계정·데이터셋 분리와 비밀정보 참조
- cron 예약 실행, 배포 파이프라인 트리거, 실패 알림 콜백
- 조건 분기·반복·승인 대기를 지원하는 업무 흐름(`if`/`repeat`/`forEach`/`while`/`break`/`continue`/`approval`)
- OpenAI 호환 로컬 LLM(vLLM 등)으로 실패 원인 가설 제시 — 진단만 하고 아무것도 고치지 않습니다
- 이름 있는 신원·역할·업무 범위(`principals.json`) — 승인이 토큰에 귀속되고 감사 기록에 증명 여부가 남습니다
- 브라우저 언어 기반 `ko/en` 전환 지원 홈, 플레이그라운드, 데모 페이지
- Streamable MCP `POST /mcp`, `DELETE /mcp`
- `API_TOKEN` 기반 선택적 인증, 경로 탈출 차단, 동시 실행/세션 상한
- 세션과 스크립트 실행 양쪽에 적용되는 네트워크 허용목록, 실행 시간 상한

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

릴리즈 절차와 이미지 검증 항목은 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 에 있습니다.

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

컨테이너는 베이스 이미지의 비특권 사용자 `pwuser`(uid 1001)로 서버를 실행합니다. 호스트에서 만든 볼륨은 보통 uid 1000 소유이므로, entrypoint 가 부팅 시 `/app/data` 와 `/app/storage-states` 의 소유권만 맞춘 뒤 권한을 내려놓습니다. `/app/scripts` 는 운영자의 소스일 수 있어 건드리지 않습니다 — 업로드 API 를 쓰려면 그 디렉터리를 uid 1001 이 쓸 수 있게 하거나 `--user` 로 uid 를 직접 지정하세요. 쓸 수 없으면 부팅 로그에 경고가 남고 업로드는 `403 SCRIPTS_DIR_NOT_WRITABLE` 을 반환합니다.

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
- `GET /api/queue`
- `GET /api/schedules`, `GET|PUT|DELETE /api/schedules/{name}`
- `POST /api/schedules/{name}/trigger`
- `GET /api/environments`, `GET|PUT|DELETE /api/environments/{name}`
- `GET /api/datasets`, `GET|PUT|DELETE /api/datasets/{name}`
- `POST /api/runs/{runId}/retry`
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
- `GET /api/sessions/{sessionId}/timeline`
- `GET /api/sessions/{sessionId}/downloads`
- `POST /api/sessions/{sessionId}/contexts/{contextId}/request`
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
- `schedule_list`, `schedule_get`, `schedule_save`, `schedule_delete`, `schedule_trigger`
- `environment_list`, `environment_get`, `environment_save`, `environment_delete`
- `dataset_list`, `dataset_get`, `dataset_save`, `dataset_delete`
- `run_create`, `run_list`, `run_queue`, `run_get`, `run_cancel`, `run_retry`, `run_delete`, `run_artifacts`, `run_report`, `run_logs`
- `session_list`, `session_create`, `session_get`, `session_delete`, `session_keepalive`, `session_timeline`, `session_downloads`
- `context_create`, `context_get`, `context_delete`
- `context_storage_export`, `context_storage_import`
- `context_route_add`, `context_route_remove`
- `context_cookies`, `context_permissions`, `context_headers`, `context_request`
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
| `URL_ALLOWLIST` | 없음 | 접근 가능한 host 목록. `*.example.com` 형태를 지원하며 세션과 스크립트 실행 양쪽에 적용됩니다. |
| `RUN_TIMEOUT_MS` | `1800000` | 실행 시간 상한. 초과 시 `SIGKILL` 후 `failed`. `0` 이면 끕니다 |
| `MAX_BLOCKED_REQUEST_LOG_ENTRIES` | `100` | 실행별로 보관하는 차단 요청 기록 수 |
| `ENABLE_EVALUATE` | `true` | `false` 면 `page.evaluate` 가 `403` 을 반환합니다. |
| `DEFAULT_DIALOG_ACTION` | `dismiss` | `alert`/`confirm`/`prompt` 기본 처리. `accept`, `dismiss`, `ignore` 중 선택합니다. `ignore` 는 대화상자를 열어둔 채로 두므로 이를 띄운 동작이 타임아웃됩니다. |
| `DEFAULT_DIALOG_PROMPT_TEXT` | 빈 문자열 | `accept` 시 `prompt()` 에 입력할 값 |
| `ROUTE_FIXTURES_DIR` | `SCRIPTS_DIR` | `route` 의 `behavior.path` 로 지정할 수 있는 파일의 루트. 이 밖의 경로는 거부됩니다. |
| `RUN_ENV_PASSTHROUGH` | 없음 | 실행 프로세스에 추가로 전달할 환경변수 이름(CSV). 기본적으로 `PATH`, `HOME`, `PLAYWRIGHT_*` 등 최소 집합만 전달되고 `API_TOKEN` 같은 서버 비밀값은 전달되지 않습니다. |
| `VALIDATION_TIMEOUT_MS` | `60000` | `scripts/validate` 실행 상한 |
| `COMMAND_OUTPUT_LIMIT_BYTES` | `262144` | 외부 명령 출력 캡처 상한 |
| `MAX_RETAINED_ARTIFACTS` | `2000` | 세션과 별개로 보관하는 증적 메타데이터 개수 |
| `ENVIRONMENTS_DIR` | `./data/environments` | 환경 정의 저장 위치 |
| `DATASETS_DIR` | `./data/datasets` | 데이터셋 저장 위치 |
| `SECRETS_DIR` | `./secrets` | `{{secret.NAME}}` 참조가 읽는 디렉터리. API 로 노출되지 않습니다 |
| `REDACT_VARIABLE_PATTERN` | `(pass\|secret\|token\|credential\|pwd\|api[-_]?key)` | 이 패턴에 걸리는 변수 **이름**의 값은 저장 시 `***` 로 마스킹됩니다 |
| `MAX_DATASET_ROWS` | `200` | 한 데이터셋이 큐에 넣을 수 있는 행 수 상한 |
| `SCHEDULES_DIR` | `./data/schedules` | 예약 정의 저장 위치 |
| `SCHEDULE_TICK_MS` | `30000` | 예약 확인 주기. `0` 이면 스케줄러를 끕니다 |
| `NOTIFY_ALLOWLIST` | 없음 | 알림 URL 로 허용할 host. 비어 있으면 `URL_ALLOWLIST` 를 따릅니다 |
| `NOTIFY_TIMEOUT_MS` | `10000` | 알림 POST 타임아웃 |
| `MAX_DOWNLOAD_BYTES` | `67108864` | 캡처할 다운로드 파일 크기 상한 |
| `MAX_WORKFLOW_ITERATIONS` | `200` | 반복 1개가 돌 수 있는 최대 회차. 초과하면 잘라내지 않고 거부합니다 |
| `MAX_WORKFLOW_STEPS` | `500` | 워크플로 하나가 실행할 수 있는 단계 총량. 중첩 반복이 폭주하는 것을 막습니다 |
| `MAX_WORKFLOW_DURATION_MS` | `300000` | 워크플로 전체 시간 상한. 세션 잠금을 쥐고 돌기 때문에 필요합니다 |
| `APPROVAL_TIMEOUT_MS` | `3600000` | 승인 대기 게이트 기본 만료. 방치된 게이트가 브라우저 페이지를 계속 붙잡지 않게 합니다 |
| `MAX_PENDING_APPROVALS` | `50` | 동시에 승인을 기다릴 수 있는 워크플로 수. 초과 시 `429 APPROVAL_LIMIT_EXCEEDED` |
| `MAX_SCRIPT_BUNDLE_FILES` | `50` | 스냅샷이 담을 수 있는 모듈 수 |
| `MAX_SCRIPT_BUNDLE_BYTES` | `8388608` | 스냅샷 전체 크기 상한 |
| `PRINCIPALS_FILE` | `SECRETS_DIR/principals.json` | 이름 있는 신원·역할 정의. 없으면 공유 `API_TOKEN` 이 이전과 같이 동작합니다. 명시 지정한 파일을 읽을 수 없으면 서버가 뜨지 않습니다 |
| `LLM_BASE_URL` | 없음 | OpenAI 호환 chat completions base (예: `http://vllm:8000/v1`). 비우면 실패 분석이 `503 LLM_NOT_CONFIGURED` 를 반환합니다 |
| `LLM_MODEL` | 없음 | 비우면 `/v1/models` 의 첫 모델을 사용합니다 |
| `LLM_API_KEY` | 없음 | vLLM 을 `--api-key` 로 띄운 경우 |
| `LLM_TIMEOUT_MS` | `60000` | 모델 응답 대기 상한. 초과 시 `504 LLM_TIMEOUT` |
| `LLM_MAX_OUTPUT_TOKENS` | `1200` | 답변 길이 상한 |
| `LLM_TEMPERATURE` | `0` | 같은 증거에 같은 답을 받기 위한 기본값 |
| `LLM_MAX_LOG_LINES` | `60` | 모델에 보낼 로그 꼬리 줄 수 |
| `LLM_RESPONSE_FORMAT_JSON` | `false` | `response_format: json_object` 를 지원하는 서버에서만 켜세요 |
| `MAX_API_RESPONSE_BODY_BYTES` | `262144` | 응답 본문을 인라인으로 돌려주는 상한. 전체는 아티팩트로 보관됩니다 |
| `API_REQUEST_TIMEOUT_MS` | `30000` | `contexts/{id}/request` 기본 타임아웃 |
| `SCRIPTS_DIR` / `RUNS_DIR` / `ARTIFACTS_DIR` / `STORAGE_STATE_DIR` | `./scripts`, `./data/runs`, `./data/artifacts`, `./storage-states` | 업로드·실행 산출물·스토리지 상태가 놓이는 루트입니다. 요청으로 전달된 경로는 이 루트 밖으로 나갈 수 없습니다. |
| `MAX_SESSIONS` | `10` | 동시 브라우저 세션 상한. 초과 시 `429 SESSION_LIMIT_EXCEEDED` |
| `MAX_CONTEXTS_PER_SESSION` | `5` | 세션당 컨텍스트 상한 |
| `MAX_PAGES_PER_SESSION` | `10` | 세션당 페이지 상한 |
| `MAX_CONCURRENT_RUNS` | `4` | 동시 실행 상한. 초과분은 대기열로 들어갑니다 |
| `MAX_QUEUED_RUNS` | `100` | 대기열 상한. 초과 시 `429 RUN_QUEUE_FULL` |
| `REQUEUE_INTERRUPTED_RUNS` | `false` | 재시작 시 중단된 실행을 다시 대기열에 넣을지. 재실행이 안전한 시나리오에서만 켜세요 |
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

## 네트워크 정책

`URL_ALLOWLIST` 를 설정하면 두 경로 모두에서 강제됩니다. `/health` 의 `features.urlAllowlistCoverage` 로 확인할 수 있습니다.

| 경로 | 적용 방식 |
| --- | --- |
| 세션 브라우저 | 컨텍스트 route 가드. 리다이렉트·iframe·XHR 등 **모든 요청**을 검사하고, 사용자 route 등록 후 재설치되어 항상 먼저 평가됩니다 |
| 스크립트 실행 | 실행별 **루프백 전용 프록시**. 생성된 Playwright config 의 `proxy` 로 주입되며, 허용되지 않은 호스트에는 `403` 을 반환합니다 |

실행 프로세스는 서버와 별개이므로 route 가드를 쓸 수 없습니다. 대신 실행마다 `127.0.0.1` 에만 바인딩된 프록시를 띄우고 브라우저를 그쪽으로 보냅니다. Chromium 전용 플래그 대신 프록시를 쓴 이유는 firefox·webkit 에도 동일하게 적용되고, 차단된 요청을 **어느 실행이 시도했는지** 귀속할 수 있기 때문입니다.

루프백(`localhost`, `127.0.0.1`, `::1`)은 항상 허용됩니다. 내장 데모 페이지와 로컬 대상이 막히면 정책 자체를 쓸 수 없기 때문입니다.

차단 내역은 실행 레코드에 남습니다.

```json
"network": {
  "allowlist": ["allowed.example"],
  "enforced": true,
  "allowedRequests": 12,
  "blockedRequests": 1,
  "blocked": [{ "ts": "...", "method": "GET", "host": "blocked.example" }]
}
```

### 업무별 허용 목적지

실행 요청에 `urlAllowlist` 를 주면 그 실행만 더 좁게 제한할 수 있습니다. **넓힐 수는 없습니다** — 서버 정책이 허용하지 않는 항목은 무시되고 `network.rejectedAllowlistEntries` 에 보고됩니다.

```jsonc
// URL_ALLOWLIST=allowed.example 인 서버에서
{ "scriptKey": "smoke", "urlAllowlist": ["evil.example", "allowed.example"] }
// → network.allowlist: ["allowed.example"]
// → network.rejectedAllowlistEntries: ["evil.example"]
```

### 실행 시간 상한

`RUN_TIMEOUT_MS`(기본 30분)를 넘긴 실행은 `SIGKILL` 로 종료되고 `failed` 로 기록됩니다. 대기열이 있는 구조에서 멈춘 실행이 슬롯을 영구히 점유하지 못하게 하기 위한 것입니다. `interruptedReason` 에 사유가 남습니다.

## 예약 실행과 배포 연동

### 예약

```
PUT /api/schedules/nightly-smoke
{
  "cron": "0 2 * * *",
  "request": { "scriptKey": "smoke", "environment": "staging", "dataset": "orders" },
  "notify": { "url": "https://ci.example.com/hooks/playwright", "on": "failure" }
}
```

cron 은 5필드(`분 시 일 월 요일`)이고 `*`, `n`, `a,b`, `a-b`, `*/n`, `a-b/n` 을 지원합니다. 두 날짜 필드가 모두 제한된 경우 둘 중 하나만 맞아도 발동하는 표준 cron 동작을 따릅니다.

**서버의 로컬 시간대**로 평가됩니다. 컨테이너의 `TZ` 환경변수로 맞추세요.

cron 표현식, 스크립트, 환경, 데이터셋을 **저장 시점에** 검증합니다 — 새벽 2시에 처음 실패하면 안 되기 때문입니다.

```
"0 2 * *"      → 400 INVALID_CRON   cron needs 5 fields
"60 * * * *"   → 400 INVALID_CRON   minute: "60" is not a range within 0-59
없는 scriptKey → 404 SCRIPT_NOT_FOUND
없는 environment → 404 ENVIRONMENT_NOT_FOUND
```

`enabled: false` 면 건너뜁니다. 발동한 분을 실행 **전에** 기록하므로, 실행 중 서버가 죽어도 같은 분이 재발동하지 않습니다.

> **놓친 예약은 따라잡지 않습니다.** 서버가 꺼져 있던 동안의 예약 시각은 지나간 것으로 둡니다. 새벽 2시 점검이 오전 9시에 뒤늦게 도는 것이 더 위험하다고 판단했습니다.

### 배포 연동

```
POST /api/schedules/nightly-smoke/trigger
{ "variables": { "buildId": "build-42" } }
```

cron 과 무관하게 즉시 실행합니다. 배포 파이프라인이 릴리즈를 게이팅할 때 호출하는 지점이고, `variables` 는 저장된 요청 위에 병합되므로 검증 대상 빌드를 식별할 수 있습니다. 데이터셋을 쓰는 예약이면 행마다 실행이 만들어집니다.

### 결과 콜백

`notify` 는 예약뿐 아니라 개별 실행 요청에도 쓸 수 있습니다.

```jsonc
{ "scriptKey": "smoke", "notify": { "url": "https://...", "on": "failure" } }
// on: "failure"(기본) 또는 "always"
```

실행이 끝나면 한 번 POST 합니다.

```json
{
  "event": "run.finished", "runId": "run_...", "status": "failed",
  "schedule": "nightly-smoke", "environment": "staging", "datasetRow": 0,
  "request": { "...": "마스킹된 사본" },
  "failedTests": [{ "title": "...", "project": "chromium", "error": "..." }]
}
```

payload 의 `request` 는 **마스킹된 사본**입니다 — 알림이 자격증명을 외부로 유출하는 경로가 되면 안 됩니다.

전달 결과는 실행 레코드의 `notification` 에 남습니다(`delivered`, `status`, `error`). 훅이 조용히 죽으면 파이프라인은 통과한 것처럼 보이므로, 전달 실패도 확인할 수 있어야 합니다.

**알림 URL 은 서버가 외부로 보내는 요청입니다.** 제한하지 않으면 이 서버를 내부망 프록시(SSRF)로 쓸 수 있으므로, `NOTIFY_ALLOWLIST`(없으면 `URL_ALLOWLIST`)로 호스트를 제한하고 http/https 만 허용합니다.

## 환경·계정·데이터셋

같은 시나리오를 여러 환경과 여러 입력으로 재사용하기 위한 것입니다. 이전에는 `baseURL`·`storageStateRef`·`variables` 를 호출자가 매번 조립해야 했습니다.

### 환경

```
PUT /api/environments/staging
{
  "baseURL": "https://stg.example.com",
  "project": "chromium",
  "storageStateRef": "auth/customer.json",
  "urlAllowlist": ["*.stg.example.com"],
  "variables": { "locale": "ko-KR", "username": "operator", "password": "{{secret.customer-password}}" }
}
```

```
POST /api/runs { "scriptKey": "checkout/guest-order", "environment": "staging" }
```

요청에 명시한 값이 환경 값을 덮고, `variables` 는 키 단위로 병합됩니다. 실행 레코드에 어떤 환경으로 돌았는지 남습니다.

### 비밀정보

**`variables` 에 리터럴로 넣은 값은 실행 레코드에 저장됩니다.** 자격증명은 `{{secret.NAME}}` 참조를 쓰세요.

| 저장 위치 | 우선순위 |
| --- | --- |
| `SECRETS_DIR/<name>` 파일 내용 | 먼저 (재시작 없이 교체 가능) |
| `PW_PLAYER_SECRET_<NAME>` 환경변수 | 파일이 없을 때 |

참조는 실행 시점에 해석되어 **자식 프로세스 환경에만** 전달되고, 레코드와 API 응답에는 참조 문자열만 남습니다. 값이 없으면 빈 값으로 실행하지 않고 `400 SECRET_NOT_FOUND` 로 거부합니다.

참조가 아닌 리터럴은 비밀인지 알 수 없으므로, 변수 **이름**이 `REDACT_VARIABLE_PATTERN`(기본 `pass|secret|token|credential|pwd|api_key`)에 걸리면 저장 시 `***` 로 마스킹합니다. 실행은 진짜 값을 받습니다.

서버가 캡처한 실행 로그에서도 해당 값을 `***` 로 치환합니다.

> **한계**: `report.json`, trace, video, 스크린샷은 Playwright 가 직접 생성하므로 서버가 손댈 수 없습니다. 스크립트가 비밀을 출력하거나 화면에 노출하면 그 산출물에는 남습니다. 스크립트가 비밀을 출력하지 않는 것이 근본 해결입니다.

### 데이터셋

```
PUT /api/datasets/orders
{ "rows": [ { "sku": "ABC-1", "qty": "1" }, { "sku": "ABC-2", "qty": "5" } ] }
```

```
POST /api/runs { "scriptKey": "checkout/guest-order", "environment": "staging", "dataset": "orders" }
→ 201 { "dataset": "orders", "rowCount": 2, "runs": [ ... ] }
```

행마다 실행 하나가 대기열에 들어갑니다. 행 값이 가장 구체적인 입력이므로 환경·요청 변수를 덮습니다. `datasetRow` 로 한 행만 고를 수 있고, 목록 조회(`GET /api/datasets`)는 행 내용 대신 행 수와 컬럼만 돌려줍니다.

## 실행 이력과 대기열

실행 기록은 디스크에 남습니다. 컨테이너를 재시작해도 이전 실행 결과와 증적을 조회할 수 있습니다. 외부 DB 없이 `RUNS_DIR/<runId>/` 아래에 다음을 둡니다.

| 파일 | 내용 |
| --- | --- |
| `run.json` | 요청, 상태 전이, 종료 코드, 요약, 테스트별 결과. 임시 파일에 쓰고 rename 하므로 중간에 죽어도 잘린 레코드가 남지 않습니다 |
| `logs.jsonl` | stdout/stderr 전체(append). 메모리에는 최신 `MAX_RUN_LOG_ENTRIES` 줄만 유지합니다 |
| `script/<파일명>` | 큐에 넣은 시점의 스크립트 스냅샷 |
| `report.json`, `html-report/`, `test-results/` | 기존 Playwright 산출물 |

`run.json` 과 `logs.jsonl` 은 전용 엔드포인트가 있으므로 아티팩트 목록에는 포함되지 않습니다.

### 대기열

`MAX_CONCURRENT_RUNS` 를 넘는 요청은 거부되지 않고 대기열에 들어갑니다. 대기열이 `MAX_QUEUED_RUNS` 까지 차면 `429 RUN_QUEUE_FULL` 입니다.

```
POST /api/runs               → status: "running" (빈 슬롯이 있으면) 또는 "queued"
GET  /api/queue              → 대기 순서, 실행 중 개수, 상한
POST /api/runs/{id}/cancel   → 대기 중이면 즉시 cancelled
```

`priority` 가 높은 요청이 먼저 실행되고, 같으면 먼저 들어온 순서입니다.

### 상태

| 상태 | 의미 |
| --- | --- |
| `queued` | 슬롯 대기 중 |
| `running` | 실행 중 |
| `completed` / `failed` / `cancelled` | 종료 |
| `interrupted` | 실행 중에 서버가 내려감. 자식 프로세스가 함께 죽었으므로 재개할 수 없습니다 |

재시작 시 `queued` 였던 실행은 대기열로 복구되고, `running` 이었던 실행은 `interrupted` 로 표시됩니다. `REQUEUE_INTERRUPTED_RUNS=true` 를 주면 중단된 실행도 다시 대기열에 넣습니다 — **다만 신청·발송·결제처럼 재실행이 안전하지 않은 시나리오에서는 켜지 마세요.** 기본값은 `false` 입니다.

`POST /api/runs/{runId}/retry` 는 종료된 실행과 같은 요청으로 새 실행을 큐에 넣습니다. 원본은 그대로 남고 새 실행에 `retryOf` 와 `attempt` 가 기록됩니다.

### 스크립트 버전 고정

실행을 큐에 넣는 시점에 스크립트를 복사하고 sha256 을 기록합니다. 대기 중에 파일이 수정·삭제되어도 그 실행은 스냅샷으로 수행되므로, 저장된 결과가 어떤 코드에 대한 것인지 항상 확정됩니다.

**상대 경로 import 를 따라가 모듈 그래프 전체를 담습니다.** `SCRIPTS_DIR` 안의 디렉터리 구조를 그대로 유지하므로, 형제 모듈을 가져오는 스펙(`import { attachHtml } from "./helpers.js"`)도 실행되고 `auth/login` 처럼 디렉터리가 있는 키도 경로를 잃지 않습니다. `bundleSha256` 은 포함된 모든 파일을 덮습니다 — 핀이 진입 파일만 덮으면 두 실행 사이에 헬퍼가 바뀐 것을 알 수 없습니다.

```json
"script": {
  "scriptKey": "checkout/guest-order",
  "relativePath": "checkout/guest-order.spec.js",
  "sha256": "511a72cbbe2610df...",
  "sizeBytes": 1284,
  "bundleSha256": "f1bd963ed3610bf2...",
  "files": [
    { "relativePath": "checkout/guest-order.spec.js", "sha256": "511a72cb...", "sizeBytes": 1284 },
    { "relativePath": "helpers.js", "sha256": "9c1f00ad...", "sizeBytes": 608 }
  ],
  "git": { "available": true, "branch": "main", "commit": "c33c3f6b..." }
}
```

`SCRIPTS_DIR` 밖으로 나가는 import 는 복사하지 않습니다 — 스크립트가 읽을 수 있는 범위를 넓히면 안 됩니다. 해석되지 않은 지정자는 `unresolvedImports` 에 기록만 하고 큐 등록을 막지 않습니다. JavaScript 를 정규식으로 훑으면 주석 처리된 import 도 걸리므로, 그것 하나로 정상 스크립트를 거부하는 편이 더 나쁩니다. 실제로 없는 파일이면 실행이 Playwright 자신의 모듈 오류로 실패하고, 핀이 어느 import 가 해석되지 않았는지 알려줍니다.

### 조회

```
GET /api/runs?status=failed,interrupted&scriptKey=checkout/guest-order&limit=50&offset=0
GET /api/runs/{runId}                    → tests[] 에 테스트별 상태·소요시간·오류
GET /api/runs/{runId}/logs?limit=500     → 메모리 창을 벗어나면 디스크에서 읽습니다
GET /api/runs/{runId}/artifacts/{relativePath}
```

## 업무 결과 검증

화면 문구만 보는 검증은 "클릭이 성공했다"까지만 말해줍니다. 신청이 실제로 접수됐는지, 처리번호가 조회되는지, 받은 파일 내용이 맞는지는 다른 수단이 필요합니다.

### 세션 쿠키로 후속 조회

```
POST /api/sessions/{sessionId}/contexts/{contextId}/request
```

컨텍스트의 `APIRequestContext` 를 사용하므로 **브라우저 세션의 쿠키·헤더를 그대로 사용**합니다. 로그인 상태에서 클릭한 결과를 같은 자격으로 조회할 수 있습니다. `url` 은 컨텍스트 `baseURL` 기준 상대 경로도 됩니다. `URL_ALLOWLIST` 가 동일하게 적용되고, 응답 본문은 증적 아티팩트로 보관됩니다.

### 다운로드

다운로드는 아티팩트로 저장됩니다. `GET /api/sessions/{sessionId}/downloads` 로 목록을, `downloadPath` 로 파일을 받습니다. `MAX_DOWNLOAD_BYTES`(기본 64MB)를 넘으면 건너뛰고 타임라인에 기록합니다.

### 한 번의 호출로 업무 완료까지

`execute` 단계에서 `saveAs` 로 값을 캡처하고 이후 단계에서 `{{name}}` 으로 참조합니다. 배치 안에서는 클라이언트가 중간 결과를 볼 수 없으므로, 화면에서 읽은 처리번호를 API 조회에 쓰려면 이 방식이 필요합니다.

```jsonc
{
  "pageId": "page_...",
  "steps": [
    { "action": "click", "locator": { "testId": "submit" } },
    { "action": "assertText", "locator": { "testId": "status" }, "expected": "접수 완료" },
    // 화면에서 처리번호를 캡처 — 반드시 위 단언으로 상태를 확인한 뒤에
    { "action": "locatorQuery", "locator": { "testId": "reference" },
      "operation": "textContent", "saveAs": "ref" },
    { "action": "assertValue", "value": "{{ref}}", "expected": "/^ORD-\\d+$/" },
    // 업무 시스템에 실제로 들어갔는지 확인
    { "action": "assertApiResponse", "url": "/api/orders/{{ref}}",
      "status": 200, "jsonPath": "data.order.status", "expected": "ACCEPTED" },
    { "action": "click", "locator": { "testId": "receipt" } },
    // 받은 파일의 내용까지 확인
    { "action": "assertDownload", "fileName": "{{ref}}", "minBytes": 10,
      "jsonPath": "data.order.reference", "expected": "{{ref}}" }
  ]
}
```

### 새 단계 동작

| 동작 | 확인 대상 |
| --- | --- |
| `apiRequest` | 요청을 보내고 응답을 반환합니다(단언 없음) |
| `assertApiResponse` | `status`, `ok`, `jsonPath` + `expected`, `bodyContains` |
| `assertValue` | 캡처한 값. 처리번호 형식 확인 등 |
| `assertDownload` | 도착 여부, `fileName`, `minBytes`, `contains`, `jsonPath` + `expected` |

`saveAs` 는 단계 결과에서 값을 꺼내 저장하고, `savePath` 로 JSON 내부 경로를 지정할 수 있습니다. 실패는 `422` 와 함께 `failedStepIndex` 로 어느 단계가 깨졌는지 알려줍니다.

**캡처가 비어 있으면 거부합니다.** 클릭 직후 캡처하면 페이지가 값을 채우기 전일 수 있고, 그대로 치환하면 `/api/orders/` 같은 URL 이 되어 원인과 무관한 404 가 납니다. `EMPTY_CAPTURED_VALUE` 로 먼저 상태를 단언하라고 알려줍니다.

## 신원과 권한

지금까지 API 는 공유 비밀 하나였습니다. **어느 클라이언트가 호출했는지만 말해주고 누가 했는지는 말해주지 않습니다.** 실행기에는 충분하지만 승인 게이트에는 틀렸습니다 — `decidedBy` 가 아무도 확인할 수 없는 자유 문자열이었습니다.

`principals.json` 을 두면 결정이 **그 결정을 내린 토큰에 귀속**되고, 감사 기록에 그 이름이 **증명된 것인지 주장된 것인지** 남습니다.

**완전히 선택사항입니다.** 파일이 없으면 공유 `API_TOKEN` 이 이전과 정확히 같이 동작합니다.

```jsonc
// SECRETS_DIR/principals.json (또는 PRINCIPALS_FILE)
{
  "principals": [
    { "id": "kim@example.com", "name": "Kim",
      "tokenSha256": "9f86d0818884...",       // 권장: 해시만 저장
      "roles": ["approver"], "scopes": ["checkout/*"] },
    { "id": "ci", "token": "평문도-됩니다",
      "roles": ["runner"], "scopes": ["checkout/*"] },
    { "id": "boss", "token": "...", "roles": ["admin"] }
  ]
}
```

`SECRETS_DIR` 안에 두므로 API 로 노출되지 않습니다. `tokenSha256` 를 권장합니다 — `sha256sum` 으로 만듭니다. 토큰 비교는 **고정 길이 다이제스트로** 하고 후보 전체를 비교합니다. 원문 문자열 비교는 공통 접두사 길이를, 조기 반환은 어느 위치에서 맞았는지를 흘립니다.

### 권한

| 역할 | 할 수 있는 것 |
| --- | --- |
| `viewer` | 실행·스크립트·증적·타임라인 조회, **실패 원인 분석 요청** |
| `runner` | 실행 생성·재시도·취소, 세션과 워크플로 |
| `approver` | 승인 게이트 결정 |
| `admin` | 스크립트 업로드·삭제, 실행 삭제, 예약·환경·데이터셋 |

`runner` 와 `approver` 는 **눈을 가리고 일할 수 없으므로** `viewer` 를 포함합니다. `admin` 은 전부입니다.

**실행기가 자기 작업을 스스로 승인하지 못합니다.** `runner` 는 `approver` 를 포함하지 않습니다 — 그게 게이트의 존재 이유입니다.

표에 없는 경로는 **`admin` 을 요구합니다.** 나중에 추가되는 경로가 조용히 열려 있는 것보다 잠겨 있는 편이 낫습니다.

### 업무 범위

`scopes` 는 스크립트 키에 적용됩니다. `checkout/*` 는 `checkout/` 아래를, `*` 는 전부를, `checkout` 은 그 키 하나만 매칭합니다. **`checkout/*` 가 `checkout-admin/` 으로 새지 않습니다** — 접두사에 슬래시를 유지합니다.

```
ci (scopes: checkout/*)
  POST /api/runs {"scriptKey":"checkout/order"}   → 201
  POST /api/runs {"scriptKey":"payroll/salary"}   → 403 OUT_OF_SCOPE
  GET  /api/runs/<payroll 실행>                    → 403
  GET  /api/scripts                               → checkout/* 만
  GET  /api/runs                                  → 자기 범위만 (filteredByScope: true)
```

목록은 **거부하지 않고 걸러냅니다** — 범위가 제한된 호출자가 목록을 달라는 것은 자기 것을 보려는 것이지 오류를 받으려는 게 아닙니다. 특정 실행을 지목하면 `403` 이고, 실행 id 는 무작위라 존재를 알려주는 것이 디버깅을 막을 이유가 되지 않습니다.

### 승인이 달라지는 점

```jsonc
// 이름이 있는 토큰: 본문에 decidedBy 를 쓰지 않습니다
POST /api/sessions/{id}/approvals/{gateId}/decide   { "decision": "approve" }
→ { "decidedBy": "kim@example.com", "decidedByVerified": true }

// 공유 토큰: 증명할 신원이 없으므로 이름을 받고, 증명되지 않았다고 기록합니다
→ { "decidedBy": "anyone-at-all", "decidedByVerified": false }
```

**다른 사람 이름을 주장하면 무시하지 않고 거부합니다**(`400 DECIDED_BY_MISMATCH`). 조용히 덮어쓰면 클라이언트는 남의 승인을 기록했다고 믿게 됩니다.

게이트의 `approvers` 목록도 이제 **증명된 신원과** 비교합니다. 호출자가 보낸 문자열이 아닙니다.

이 구분을 문서가 아니라 **데이터에 남깁니다.** 증명할 수 없는 이름이 증명된 것처럼 보이는 것은 이름이 없는 것보다 나쁩니다.

### MCP 도 같은 규칙입니다

MCP 세션은 모든 도구에 닿을 수 있으므로, 거기에도 역할이 적용되지 않으면 `/mcp` 가 우회로가 됩니다. **도구 이름을 아는 지점에서** 검사합니다 — 엔드포인트 검사는 "MCP 를 쓸 수 있다"까지만 말해줍니다.

`tools/list` 는 호출자가 쓸 수 없는 도구를 **빼고** 보여주고(에이전트가 못 하는 일을 발견하는 데 호출을 쓰지 않도록) 각 도구에 `requiredRole` 을 붙입니다. `runner` 에게는 71개 중 61개가 보이고 `run_delete` 와 `session_approval_decide` 는 없습니다.

스위트가 **모든 도구에 역할이 있는지, 파괴적인 도구가 `runner` 에 남아 있지 않은지** 확인합니다. 생각 없이 추가된 도구가 기본값으로 흘러들어가지 않게 하는 안전망입니다.

### 공유 토큰은 숨기지 않습니다

`principals.json` 과 `API_TOKEN` 을 함께 두면 공유 토큰은 **계속 admin 으로 동작합니다**(기존 배포 호환). 대신 숨기지 않습니다:

- 부팅 시 경고 로그
- `/health` → `features.sharedTokenAdmin: true`
- `/api/whoami` → `principal.verified: false`, `id: "api-token"`

**이름 있는 신원을 요구하려면 `API_TOKEN` 을 비우세요.** 조용한 전체 권한 백도어가 가장 나쁜 결과입니다.

### 누구인지 확인

```
GET /api/whoami
→ { "identities": true,
    "principal": { "id": "kim@example.com", "roles": ["approver","viewer"], "scopes": ["checkout/*"], "verified": true },
    "may": { "read": true, "run": false, "approve": true, "administer": false } }
```

경로마다 403 을 받아보며 알아낼 필요가 없습니다.

**`principals.json` 이 깨져 있으면 서버가 뜨지 않습니다.** 중복 id, 공유된 토큰, 없는 역할, 토큰 없는 항목 모두 거부합니다. 아무도 설정하지 않은 권한 모델로 서버가 돌고 있는 것보다 낫습니다. 두 주체가 토큰을 공유하면 감사 기록이 거짓이 되므로(먼저 맞은 쪽이 다른 쪽 행위로 기록됨) 특히 거부합니다.

## 실패 분석 (로컬 LLM)

실패한 실행에는 오류 메시지, 단계 타임라인, 로그가 남습니다. 그걸 읽는 것이 느린 작업이고, 로컬 모델이 1차 분류에는 쓸 만합니다. vLLM 처럼 **OpenAI 호환 `/v1/chat/completions`** 를 제공하는 서버를 가리키면 됩니다.

```
LLM_BASE_URL=http://vllm:8000/v1
LLM_MODEL=                      # 비우면 /v1/models 의 첫 모델을 씁니다
LLM_API_KEY=                    # vLLM 을 --api-key 로 띄운 경우에만
```

```
POST /api/runs/{runId}/analyze        { "refresh": false, "force": false }
GET  /api/analysis/capabilities?probe=true
```

환경변수만으로 설정하므로, 값이 제대로 들어갔는지 확인할 방법이 필요합니다. `probe=true` 가 설정된 엔드포인트의 `/models` 를 실제로 호출해서 **응답했는지, 어떤 모델을 쓰게 되는지, 안 되면 무엇이 잘못됐는지** 알려줍니다. `probe` 없이는 서버 밖으로 아무것도 나가지 않습니다.

```json
{ "reachable": false, "code": "LLM_UNREACHABLE",
  "error": "http://127.0.0.1:9/v1/models could not be reached: fetch failed" }
```

### 네 가지 결정

**엔드포인트는 설정이고 요청 입력이 아닙니다.** 요청마다 URL 을 받으면 이 서버가 네트워크에서 보이는 모든 것에 닿는 프록시가 됩니다 — 알림 URL 을 허용목록으로 막은 것과 같은 이유이고, 여기서는 아예 받을 이유가 없습니다.

**진단만 하고 아무것도 고치지 않습니다.** 이 기능은 스크립트도, 기대값도, 실행 기록도 쓸 수 없습니다. 프롬프트에 규칙으로도 넣습니다 — *기대값·단언·테스트를 통과시키려고 바꾸라고 제안하지 말 것. 기대값 자체가 틀려 보이면 사람이 판단해야 한다고 말할 것.* **실패하는 단언을 통과시킬 수 있는 모델은 그 테스트가 존재한 유일한 증거를 지울 수 있는 모델입니다.**

**서버가 통제하는 텍스트만 보냅니다** — 실행 메타데이터, 실패한 테스트 제목과 오류 메시지, 단계 이름과 소요시간, 차단된 요청 호스트, **스크러빙된** 로그 줄. 스크린샷·DOM 덤프·트레이스·영상의 **내용은 읽지도 보내지도 않습니다** — 비밀정보 스크러빙이 닿지 못하는 것이 바로 그것들입니다. 단, Playwright 가 첨부 파일 경로를 로그에 출력하므로 **경로는** 로그 줄에 포함될 수 있습니다. 내용이 아니라 참조이고, 유용한 쪽입니다. 과장해서 말하는 것도 유출만큼 잘못입니다.

**재실행이 안전한지는 모델이 판단하지 않습니다.** 그건 시나리오가 업무 상태를 바꿨는지에 달렸고, 그걸 아는 건 시나리오 작성자뿐입니다. 요청의 `retrySafe` 로 선언하면 분석에 그대로 전달되고, 추론하지는 않습니다.

### 답변

```json
{
  "status": "ok",
  "model": "Qwen2.5-7B-Instruct",
  "summary": "단언이 기대한 문구를 끝까지 보지 못했습니다.",
  "hypotheses": [
    { "cause": "단언이 실행될 때 상태 요소가 비어 있었음",
      "evidence": ["failedTests[0].error", "failedTests[0].steps"],
      "confidence": "medium" }
  ],
  "suggestedChecks": ["실패한 테스트에 첨부된 스크린샷 확인"],
  "needsHuman": false,
  "evidence": { "...": "모델에 보낸 내용 전체" },
  "disclaimer": "A hypothesis produced by a language model from the evidence above. Nothing was modified."
}
```

**보낸 증거를 답변과 함께 돌려줍니다.** 아무도 검증할 수 없는 분석은 가치가 적습니다. 각 가설은 근거로 삼은 필드를 인용해야 하고, `confidence` 가 스키마에 없는 값이면 `low` 로 내립니다 — 모델이 만든 값을 그대로 믿지 않습니다. `needsHuman` 이 빠져 있으면 `true` 로 둡니다. 둘 중 안전한 쪽입니다.

JSON 으로 파싱되지 않는 답변은 `status: "unusable"` 로 **원문과 함께** 돌려줍니다. 산문을 요약해서 발견처럼 보이게 만드는 것이 더 나쁩니다. 코드 펜스로 감싼 JSON 은 파싱합니다.

`/runs` 상세 화면의 **실패 원인 분석** 패널에서 사람이 직접 요청하고 읽을 수 있습니다. 각 가설 옆에 **근거로 삼은 필드와 확신도**가 함께 표시되므로, 모델의 말을 그대로 받는 대신 가서 확인할 수 있습니다. `needsHuman` 은 화면에서 강조되고, 하단에 모델 이름과 "이것은 가설이며 아무것도 수정되지 않았다"는 문구가 항상 붙습니다. 설정이 없으면 서버 오류처럼 보이지 않게 **`LLM_BASE_URL` 를 설정하라고** 알려줍니다.

답변은 실행 기록에 저장되어 재시작을 넘깁니다. 다시 묻고 싶으면 `refresh: true` 입니다. 모델이 죽어 있으면 `502`/`504` 를 내고 **실행 기록과 기존 답변은 건드리지 않습니다**.

## 업무 흐름 분기

평평한 단계 목록은 "언제나 전부 실행한다" 밖에 표현하지 못합니다. 실제 업무는 **분기**하고(승인 배너가 떠 있으면 누르고, 없으면 양식을 채운다) **반복**하고(데이터셋 행마다 같은 처리), 때로는 **사람을 기다립니다**. `execute` 의 `steps` 는 중첩할 수 있습니다.

| 동작 | 필드 | 설명 |
| --- | --- | --- |
| `if` | `when`, `then`, `else` | 조건이 참이면 `then`, 거짓이면 `else`(없으면 건너뜀) |
| `repeat` | `times`, `steps`, `as`/`indexAs` | 정해진 횟수만큼 반복 |
| `forEach` | `items`, `steps`, `as`/`indexAs` | 배열(또는 `{{captured}}` 배열)의 각 항목마다 반복 |
| `while` | `when`, `steps`, `maxIterations` | 조건이 참인 동안 반복 |
| `break` / `continue` | — | 가장 안쪽 반복을 벗어나거나 다음 항목으로 |
| `approval` | `name`, `message`, `approvers`, `onReject` | 멈추고 사람의 결정을 기다림 |

```jsonc
{
  "pageId": "page_...",
  "variables": { "rows": [{ "id": "A-1" }, { "id": "A-2" }] },
  "steps": [
    { "action": "forEach", "items": "{{rows}}", "as": "row", "steps": [
      { "action": "fill", "locator": { "testId": "order-id" }, "value": "{{row.id}}" },
      { "action": "click", "locator": { "testId": "search" } },
      // 화면 상태에 따라 갈라짐
      { "action": "if",
        "when": { "locator": { "testId": "already-done" }, "state": "visible" },
        "then": [{ "action": "continue" }],
        "else": [{ "action": "click", "locator": { "testId": "approve" } }] }
    ] }
  ]
}
```

`as` 로 묶은 항목은 `{{row}}` 로, 객체 내부는 `{{row.id}}` 로 참조합니다. 결과의 각 항목에는 `path`(`0.forEach.1` 같은 트리 위치)가 붙습니다 — 중첩되면 평평한 번호만으로는 어느 단계였는지 알 수 없습니다.

### 조건

조건은 **질문**이고 단언이 아닙니다. 답이 "아니오" 인 것은 실패가 아닙니다.

- 값 비교 — `{ "value": "{{status}}", "equals": "APPROVED" }`. 연산자는 `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `matches`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `empty`, `notEmpty` 중 **하나**입니다.
- 화면 상태 — `{ "locator": {...}, "state": "visible" }`, `{ "locator": {...}, "count": 3, "operator": "gte" }`, `{ "locator": {...}, "text": "완료" }`, `{ "url": "/done" }`, `{ "loadState": "networkidle" }`
- 조합 — `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": {...} }`

세 가지 결정이 조용한 오답을 막습니다.

**요소가 보이지 않는 것은 거짓이고, 평가할 수 없는 선택자는 오류입니다.** 둘을 같이 묶으면 선택자 오타가 "조건이 거짓이었다"로 둔갑해 분기 전체가 조용히 안 돌아갑니다.

**`matches` 는 정규식 리터럴만 받습니다.** `"matches": "ORD"` 를 부분일치로 받아주면 구분자 오타가 조건을 슬그머니 느슨하게 만듭니다. 평문 비교는 `contains`/`equals` 를 쓰세요.

**숫자 비교는 숫자만 받습니다.** 문자열로 비교하면 `"17" < "9"` 가 참이 되어 수량 검증이 엉뚱한 행을 통과시킵니다.

객체를 문자열에 치환하면 JSON 이 되므로, 조건의 문자열 비교도 같은 형태를 봅니다 — `{ "value": "{{row}}", "contains": "A-1" }` 이 동작합니다. `in` 은 배열을, 숫자 비교는 숫자를 그대로 받습니다.

조건 안에서는 빈 캡처값이 허용됩니다(`{ "value": "{{code}}", "empty": true }` 가 바로 그 질문이므로). 다만 **없는 이름은 여전히 오류**입니다 — 오타를 조건 실패로 숨기지 않습니다.

`continueOnError` 는 단계 실패만 넘깁니다. **조건이 잘못된 요청이면 그대로 실패합니다** — 오타 하나로 분기 하나가 조용히 건너뛰어지면 안 됩니다.

### 반복 상한

```
WORKFLOW 상한: MAX_WORKFLOW_ITERATIONS=200, MAX_WORKFLOW_STEPS=500, MAX_WORKFLOW_DURATION_MS=300000
```

**초과하면 잘라내지 않고 거부합니다.** 10,000행 데이터셋에서 앞 200행만 돌고 "완료" 로 보고하는 것이 가장 위험한 실패 방식입니다. 단계별 `maxIterations` 로 줄일 수 있고, 요청의 `limits` 는 **서버 상한보다 좁게만** 적용됩니다(URL 허용목록과 같은 규칙입니다. 그러지 않으면 모든 상한이 요청으로 해제 가능한 권고사항이 됩니다).

조건이 끝까지 거짓이 되지 않은 `while` 은 **조용히 빠져나오지 않고 실패합니다**(`LOOP_LIMIT_EXCEEDED`). 기다리던 상태에 페이지가 도달하지 못한 것이므로, 통과로 보고하면 하지 않은 일을 했다고 말하는 셈입니다.

워크플로는 세션 잠금을 쥐고 돌기 때문에 전체 시간 상한도 함께 적용됩니다.

### 승인 대기

`approval` 단계는 워크플로를 멈추고 응답을 돌려줍니다.

```jsonc
{ "action": "approval", "name": "finance", "message": "결제 금액을 확인해 주세요",
  "approvers": ["kim@example.com"], "onReject": "stop", "timeoutMs": 3600000 }
```

```
POST /api/sessions/{sessionId}/execute          → status: "awaiting_approval", approval.gateId
GET  /api/sessions/{sessionId}/approvals
POST /api/sessions/{sessionId}/approvals/{gateId}/decide   { decision, decidedBy, comment }
POST /api/sessions/{sessionId}/execute/resume              { gateId }
```

**사람을 기다리는 동안 세션 잠금을 쥐고 있지 않습니다.** 잠금을 들고 기다리면 그 세션의 다른 요청이 전부 막히고, 승인자가 퇴근하면 영구히 막힙니다. 그래서 단계 목록을 점프가 있는 명령어 배열로 컴파일하고, 프로그램 카운터·캡처값·반복 프레임만 남겨둡니다 — 재귀 실행기는 중간에 멈춰 다음 요청에서 이어받을 수 없습니다. 반복 안의 게이트도 **같은 회차로 돌아와** 이어집니다.

결정은 `{{name}}` 으로 캡처됩니다. `onReject` 기본값은 `stop`(반려 시 이후 단계 미실행, `status: "rejected"`)이고, `continue` 로 두면 이후 단계가 돌며 `if` 로 분기할 수 있습니다.

`/playground` 의 **업무 흐름과 승인** 패널에서 대기 중인 게이트를 사람이 직접 승인·반려할 수 있습니다. 결정 후 `resume` 까지 이어서 호출합니다.

**`decidedBy` 는 `principals.json` 을 설정하면 증명됩니다.** 이름 있는 토큰으로 결정하면 본문에 `decidedBy` 를 쓰지 않고, 기록에 `decidedByVerified: true` 가 남습니다. 공유 토큰만 쓰면 이전처럼 이름을 받고 `decidedByVerified: false` 로 남습니다 — 증명할 신원이 없기 때문입니다. [신원과 권한](#신원과-권한) 을 보세요.

멈춘 워크플로는 프로그램·캡처값·결과를 메모리에 들고 있으므로 개수를 제한합니다(`MAX_PENDING_APPROVALS`, 기본 50). 아무것도 결정하지 않는 호출자가 서버를 무한히 키우지 못하게 하는 상한이고, 하나를 결정하면 자리가 다시 납니다.

**대기 중인 게이트는 재시작을 넘기지 못합니다.** 이어서 실행할 브라우저 페이지도 함께 사라지므로, 세션이 닫히거나 만료되면 그 세션의 게이트도 버립니다. 적용할 수 없는 결정을 남겨두지 않기 위한 것입니다. `timeoutMs`(기본 `APPROVAL_TIMEOUT_MS`, 1시간) 가 지난 게이트도 정리됩니다 — 멈춘 워크플로가 브라우저 페이지를 계속 붙잡고 있기 때문입니다.

## 실행 이력 화면

`/runs` 에서 실행 목록과 단계별 타임라인을 봅니다. 새 API 없이 기존 엔드포인트만 사용합니다.

**목록** — 실행 ID, 스크립트, 상태, 소요시간, 시작 시각, 테스트 수와 실패 수. 상태 필터와 대기열 요약을 함께 표시합니다.

**상세** (`/runs?runId=...`) — 상태, 스크립트 핀(sha256·크기), 시도 횟수, 종료 코드, 중단 사유, 네트워크 정책과 차단된 요청, 단계 타임라인, 증적, 로그, 실패한 실행에는 원인 분석 패널, 그리고 다시 실행·취소·삭제.

타임라인은 중첩 단계를 들여쓰기로 보여주고 소요시간을 막대로 표현합니다. **실패한 단계는 강조되고 바로 아래에 오류 메시지가 붙습니다.** 가장 느린 단계 3개를 함께 표시하므로 통과했지만 느린 실행도 바로 읽힙니다.

스크린샷은 인라인으로 미리보기 됩니다. `API_TOKEN` 을 설정한 경우 `<img src>` 로는 헤더를 보낼 수 없으므로 인증 fetch 후 blob 으로 표시합니다. 페이지 상단의 API 토큰 칸을 채운 뒤 새로고침하면 됩니다 — 토큰은 메모리에만 두고 저장하지 않습니다.

## 실행 타임라인

### 스크립트 실행

Playwright 의 JSON 리포터는 step 정보를 내보내지 않습니다. 그래서 실행마다 전용 리포터를 함께 생성해 클릭·입력·검증별 소요시간을 기록합니다. `GET /api/runs/{runId}` 의 `tests[].steps` 에 담깁니다.

```
failed  2561ms  steps.spec.js > multi-step scenario
  - 210ms   Before Hooks
    - 55ms  Launch browser
  - 83ms    Navigate to "/demo/test-page"
  - 50ms    Fill "timeline" getByTestId('message-input')
  - 47ms    Click getByTestId('send-message')
  - 2003ms  Expect "toContainText" getByTestId('status')   ← 실패 단계
```

`tests[].attachments` 에 그 테스트의 스크린샷·비디오·trace 가 실행 디렉터리 기준 상대 경로로 들어갑니다. 그대로 `GET /api/runs/{runId}/artifacts/{relativePath}` 로 받을 수 있습니다.

### 세션

`GET /api/sessions/{sessionId}/timeline` 은 액션·브라우저 이벤트·증적을 하나로 묶어 반환합니다. 이전에는 세 배열을 직접 대조해야 했습니다.

```
page.evaluate   ok      7ms  issues=3
      [error] console   boom from the page
      [error] response  http://127.0.0.1:3080/does-not-exist (404)
assert.visible  error 1201ms  artifacts=2
```

| 필드 | 의미 |
| --- | --- |
| `durationMs` | 액션 소요시간. 단조 시계로 측정하므로 시스템 시각이 뒤로 가도 음수가 되지 않습니다 |
| `issues` | 해당 액션 구간에 발생한 콘솔 오류·경고, 페이지 예외, 4xx/5xx 응답, 대화상자 |
| `artifacts` | 실패 시 저장된 스크린샷·DOM (다운로드 경로 포함) |
| `slowest` | 가장 느린 단계 상위 5개 |

이벤트는 시퀀스 번호로 액션 구간에 귀속됩니다. 밀리초 타임스탬프 비교가 아니므로 경계에서 잘못 묶이지 않습니다. 소요시간만 필요하면 `includeEvents=false` 로 이벤트 본문을 제외할 수 있습니다.

MCP 도구 `session_timeline` 으로도 같은 정보를 조회합니다.

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
- `403 EVALUATE_DISABLED`, `403 URL_NOT_ALLOWED`, `403 MCP_ORIGIN_DENIED`, `403 SCRIPTS_DIR_NOT_WRITABLE`
- `404 SCRIPT_NOT_FOUND`, `404 SESSION_NOT_FOUND`, `404 PAGE_NOT_FOUND`, `404 NOT_FOUND`
- `400 INVALID_CRON`, `400 INVALID_NOTIFY_URL`, `403 NOTIFY_URL_NOT_ALLOWED`
- `400 SECRET_NOT_FOUND`, `400 DATASET_ROW_NOT_FOUND`, `400 DATASET_EMPTY`, `400 INVALID_NAME`
- `400 AMBIGUOUS_LOCATOR` — locator 가 여러 요소에 매칭됩니다. `first`/`last`/`nth` 를 붙이거나 더 구체적인 locator 를 쓰세요
- `408 TIMEOUT` — assertion 또는 Playwright 타임아웃
- `422 API_ASSERTION_FAILED`, `422 DOWNLOAD_ASSERTION_FAILED`, `422 VALUE_ASSERTION_FAILED`, `422 EMPTY_CAPTURED_VALUE`
- `409 SESSION_DISCONNECTED`, `409 TRACE_NOT_STARTED`, `409 SCRIPT_ALREADY_EXISTS`
- `429 SESSION_LIMIT_EXCEEDED`, `429 RUN_QUEUE_FULL`

## 주의 사항

- `proxy` 를 context 수준에서 동적으로 바꾸는 기능은 이번 구현에 포함하지 않았습니다.
- `storage-state/import` 는 컨텍스트를 새로 만들기 때문에 기존 페이지가 닫힙니다. 응답의 `replacedPages` 에 닫힌 page id 가 담기며, 이후 `pages` 를 다시 생성해야 합니다.
- `sessions/{id}/execute` 는 배치 전체가 하나의 세션 락 안에서 실행되므로 중간에 다른 요청이 끼어들지 않습니다. `continueOnError: true` 를 주면 실패한 단계 이후도 계속 진행하고 단계별 결과를 모두 반환합니다.
- `URL_ALLOWLIST` 는 세션 브라우저와 스크립트 실행 **양쪽 모두**에 적용됩니다. 자세한 내용은 [네트워크 정책](#네트워크-정책) 을 보세요.
- `page.evaluate` 의 `expression` 은 `"() => document.title"` 같은 함수 형태와 `"1 + 2"` 같은 단순 식을 모두 지원하며, 함수인 경우 `arg` 가 인자로 전달됩니다.
- MCP는 Streamable HTTP 규격의 POST/DELETE 중심으로 구현했고, GET 기반 SSE stream 은 아직 비활성화했습니다.
- 브라우저 세션은 메모리에 유지됩니다. 컨테이너 재시작 시 세션은 사라지지만, 실행 이력과 증적은 `RUNS_DIR` 에 남아 계속 조회할 수 있습니다.

## 내장 페이지 구조

페이지의 마크업·스타일·스크립트·문구는 `public/` 에 있습니다. `server.js` 에는 템플릿을 읽어 치환하는 로더만 남습니다.

```
public/
  home.html  playground.html  runs.html  demo.html  docs.html
  assets/    *.css  *.js  common.js                  /ui/* 로 정적 서빙
  locales/   ko.json  en.json                        화면 문구
```

| 플레이스홀더 | 처리 |
| --- | --- |
| `{{copy.x}}` | HTML 이스케이프 |
| `{{config.x}}` | HTML 이스케이프 |
| `{{json.x}}` | `<script>` 안에서 안전한 JSON |
| `{{raw.x}}` | 서버가 조립한 조각을 그대로 삽입 |

없는 키는 조용히 빈칸이 되지 않고 `500 UI_TEMPLATE_KEY_MISSING` 으로 키 이름을 알려줍니다.

`assets/*.js` 는 정적으로 서빙되므로 **플레이스홀더를 넣을 수 없습니다.** 서버가 주는 값은 HTML 의 인라인 부트스트랩이 `window.__PW_PLAYER__` 로 전달하고, 스크립트가 그걸 읽습니다.

로케일 파일 안에서도 `{{config.serviceName}}` 같은 플레이스홀더를 쓸 수 있어, 경로와 서비스명이 언어별로 중복되지 않습니다.

Docker 이미지에는 `public/` 이 포함되어야 합니다. 없으면 모든 페이지가 `500 UI_TEMPLATE_MISSING` 입니다.

## 내장 페이지

- `/`
  - 링크 허브 및 상태 진입점
- `/playground`
  - 브라우저에서 직접 REST API를 호출하는 운영자용 플레이그라운드
  - 승인 대기 중인 워크플로를 목록으로 보고 승인·반려할 수 있습니다
- `/runs`
  - 실행 목록과 단계별 타임라인, 실패 원인과 증적
- `/demo/test-page`
  - `data-testid`가 안정적으로 유지되는 로컬 데모 페이지

세 페이지 모두 브라우저의 `Accept-Language`를 따라 한국어와 영어를 자동 전환하며, `?lang=ko`, `?lang=en`으로 강제 지정할 수 있습니다.
