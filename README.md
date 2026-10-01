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
| `MAX_DOWNLOAD_BYTES` | `67108864` | 캡처할 다운로드 파일 크기 상한 |
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

```json
"script": {
  "scriptKey": "checkout/guest-order",
  "sha256": "511a72cbbe2610df...",
  "sizeBytes": 1284,
  "git": { "available": true, "branch": "main", "commit": "c33c3f6b..." }
}
```

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
  home.html  playground.html  demo.html  docs.html   마크업 + {{...}} 플레이스홀더
  assets/    *.css  *.js                             /ui/* 로 정적 서빙
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
- `/demo/test-page`
  - `data-testid`가 안정적으로 유지되는 로컬 데모 페이지

세 페이지 모두 브라우저의 `Accept-Language`를 따라 한국어와 영어를 자동 전환하며, `?lang=ko`, `?lang=en`으로 강제 지정할 수 있습니다.
