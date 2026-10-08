# LLM + MCP 작성 가이드

오프라인망에서 LLM이 사용자 질문을 받아 테스트 자동화를 만들게 하려면, **계획**, **관찰**, **초안 생성**, **검증 실행**을 분리하는 것이 좋습니다.

## 권장 순서

1. `GET /api/assist/capabilities`
2. `POST /api/assist/plan`
3. `POST /api/sessions`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/inspect`
5. `POST /api/assist/scaffold`
6. `POST /api/scripts/validate`
7. `POST /api/runs`

## MCP에서 바로 쓸 수 있는 도구

[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)의 핵심 `browser_*` 도구도 사용할 수 있습니다. 초기화에서 받은 `Mcp-Session-Id`를 요청 헤더에 유지하면 브라우저와 현재 탭을 자동 관리합니다.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"http://127.0.0.1:3000/demo/test-page"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_take_screenshot","arguments":{"fullPage":true,"type":"png"}}}
```

위 JSON 객체를 각각 별도 `POST /mcp` 요청으로 보내세요. `API_TOKEN`이 설정돼 있으면 `Authorization: Bearer <token>`도 필요합니다. `browser_click`/`browser_type` 등은 스냅샷의 `ref` 또는 `target`을 사용하며, `target`에는 고유 selector도 가능합니다. MCP 연결마다 탭과 브라우저가 분리됩니다.

스크린샷 응답의 `content`에는 표준 `image` 블록이 들어가므로 외부 이미지 서버 없이 표시할 수 있습니다. `structuredContent.artifact`에는 기존 다운로드 정보가 유지됩니다. 이미지 블록을 지원하지 않는 클라이언트에서는 인증된 REST 다운로드 경로를 사용하세요. `browser_take_screenshot` 기본값은 viewport이고 `page_screenshot`의 기존 기본값은 전체 페이지입니다.

PNG/JPEG 및 핵심 브라우저 동작을 지원합니다. 공식 서버의 선택적 확장 기능, 브라우저 자동 다운로드, 서버 임의 코드 실행은 이 호환 계층의 범위에 포함되지 않습니다. `filename`은 서버 아티팩트의 파일명으로 사용되며 클라이언트 PC 경로에 저장되지 않습니다.

기존 작성·실행 도구도 함께 사용할 수 있습니다.

- `assist_capabilities`
- `assist_examples`
- `assist_plan`
- `assist_scaffold`
- `page_inspect`
- `run_create`
- `run_get`

## 좋은 프롬프트 입력 예시

```text
관리자 로그인 후 설정 페이지에서 알림 토글을 켜고 저장 버튼 클릭 뒤 성공 토스트를 검증하는 Playwright 테스트를 만들어줘.
```

## 생성 품질을 높이는 입력

- 대상 환경: `baseURL`, `env`
- 사용자 유형: 관리자, 일반 사용자, 비회원
- 핵심 검증: 텍스트, URL, 개수, 가시성
- 재사용 상태: `storageStateRef`
- 안정 locator 힌트: `role`, `label`, `testId`

## 왜 page inspect 가 중요한가

`page_inspect`는 실제 열린 페이지에서 heading, 보이는 텍스트, locator 후보를 수집합니다. 오프라인 LLM이 DOM 전체를 읽지 못하더라도 안정적인 클릭 대상과 assertion 대상을 추론하는 데 도움이 됩니다.

> LLM에게는 raw CSS selector보다 구조화 locator를 우선 사용하게 하는 것이 훨씬 안정적입니다.
