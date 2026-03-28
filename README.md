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
- 페이지 구조 분석용 `page_inspect`
- 브라우저 언어 기반 `ko/en` 전환 지원 홈, 플레이그라운드, 데모 페이지
- Streamable MCP `POST /mcp`, `DELETE /mcp`

## 스크립트 규칙

`/app/scripts` 아래의 다음 패턴을 자동 등록합니다.

- `*.spec.js`
- `*.spec.ts`
- `*.test.js`
- `*.test.ts`
- `*.pw.js`
- `*.pw.ts`

예를 들어 `scripts/checkout/guest-order.spec.ts` 는 `checkout/guest-order` 로 등록됩니다.

테스트 런타임에는 아래 환경 변수가 함께 주입됩니다.

- `PW_PLAYER_RUN_ID`
- `PW_PLAYER_SCRIPT_KEY`
- `PW_PLAYER_TARGET_ENV`
- `PW_PLAYER_BASE_URL`
- `PW_PLAYER_VARIABLES_JSON`
- `PW_PLAYER_STORAGE_STATE`

## 실행

### 로컬

```bash
npm install
node server.js
```

### Docker

```bash
docker compose up --build
```

Playwright 공식 권장값에 맞춰 Compose 예시는 `init: true`, `ipc: host` 를 사용합니다.

## REST API

기본 prefix 는 `/api` 입니다.

### Script Registry

- `GET /api/scripts`
- `GET /api/scripts/{scriptKey}`
- `POST /api/scripts/sync`
- `POST /api/scripts/validate`

### Runs

- `POST /api/runs`
- `GET /api/runs/{runId}`
- `POST /api/runs/{runId}/cancel`
- `GET /api/runs/{runId}/artifacts`
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

초기화 응답 헤더의 `Mcp-Session-Id` 값을 이후 요청에 계속 넣으면 됩니다.

제공 도구:

- `script_list`, `script_get`, `script_sync`, `script_validate`
- `assist_capabilities`, `assist_examples`, `assist_plan`, `assist_scaffold`
- `run_create`, `run_get`, `run_cancel`, `run_artifacts`, `run_report`, `run_logs`
- `session_create`, `session_get`, `session_delete`, `session_keepalive`
- `context_create`, `context_get`, `context_delete`
- `context_storage_export`, `context_storage_import`
- `context_route_add`, `context_route_remove`
- `context_cookies`, `context_permissions`, `context_headers`
- `page_create`, `page_get`, `page_inspect`, `page_delete`
- `page_navigate`, `page_action`, `page_assert`, `page_wait_for`
- `page_screenshot`, `page_pdf`
- `session_trace`, `session_execute`, `session_artifacts`, `session_actions`

## 주의 사항

- `proxy` 를 context 수준에서 동적으로 바꾸는 기능은 이번 구현에 포함하지 않았습니다.
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
