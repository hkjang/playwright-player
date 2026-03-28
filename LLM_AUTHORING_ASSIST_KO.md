# LLM Authoring Assist API

## 목적

오프라인망에서 LLM 또는 AI agent가 자연어 테스트 요청을 받아 Playwright 스크립트를 만들 때 도움이 되는 보조 API와 MCP tool을 제공합니다.

핵심 아이디어는 아래 흐름입니다.

1. `assist_plan` 또는 `POST /api/assist/plan`
   사용자 요청을 구조화된 테스트 계획으로 변환
2. `page_inspect` 또는 `POST /api/sessions/{sessionId}/pages/{pageId}/inspect`
   실제 페이지에서 locator 후보와 가시 텍스트를 추출
3. `assist_scaffold` 또는 `POST /api/assist/scaffold`
   Playwright 스크립트 초안 생성
4. `script_validate`
   생성된 스크립트 정적 검증
5. `run_create`
   실제 실행

## 추가된 REST API

### `GET /api/assist/capabilities`

LLM이 어떤 locator 필드, 어떤 액션, 어떤 프로젝트를 사용할 수 있는지 확인합니다.

반환 예시 항목:

- `recommendedWorkflow`
- `supportedProjects`
- `locatorFields`
- `stepActions`
- `scaffoldSaveSupported`

### `POST /api/assist/plan`

자연어 요청을 테스트 계획으로 바꿉니다.

입력 예시:

```json
{
  "goal": "채팅 메시지 전송 후 상태 텍스트를 확인하는 테스트",
  "startUrl": "http://127.0.0.1:3000/demo/test-page",
  "locators": {
    "messageInput": { "label": "Message" },
    "sendButton": { "role": "button", "name": "Send message" }
  },
  "expectations": [
    {
      "locator": { "testId": "status" },
      "value": "Message sent",
      "match": "contains"
    }
  ],
  "variables": {
    "message": "offline llm prompt"
  }
}
```

출력 주요 필드:

- `recommendedScriptKey`
- `recommendedFileName`
- `suggestedSteps`
- `missingInputs`
- `suggestedRunRequest`
- `suggestedMcpSequence`

### `POST /api/assist/scaffold`

Playwright 스크립트 초안을 생성합니다.

지원 기능:

- `goal` 또는 `steps` 기반 스캐폴드 생성
- `validate: true` 시 생성 직후 검증
- `save: true` 시 `scripts/` 아래에 파일 저장
- `overwrite: true` 시 기존 파일 덮어쓰기

입력 예시:

```json
{
  "testName": "chat send updates status",
  "startUrl": "http://127.0.0.1:3000/demo/test-page",
  "steps": [
    { "action": "goto", "url": "http://127.0.0.1:3000/demo/test-page" },
    { "action": "fill", "locator": { "label": "Message" }, "value": "offline llm prompt" },
    { "action": "click", "locator": { "role": "button", "name": "Send message" } },
    { "action": "assertText", "locator": { "testId": "status" }, "value": "Message sent", "match": "contains" }
  ],
  "validate": true,
  "project": "chromium"
}
```

출력 주요 필드:

- `content`
- `scriptKey`
- `relativePath`
- `savedScript`
- `validation`

### `POST /api/sessions/{sessionId}/pages/{pageId}/inspect`

실제 열린 페이지를 분석해서 LLM이 스크립트 작성에 바로 쓸 수 있는 locator 후보를 돌려줍니다.

출력 주요 필드:

- `title`
- `url`
- `headings`
- `visibleText`
- `interactiveElements`
  - `tagName`
  - `role`
  - `label`
  - `testId`
  - `locatorCandidates`
  - `bestLocator`

## 추가된 MCP Tool

- `assist_capabilities`
- `assist_plan`
- `assist_scaffold`
- `page_inspect`

## 권장 MCP 사용 흐름

1. `assist_plan`
2. `session_create`
3. `context_create`
4. `page_create`
5. `page_navigate`
6. `page_inspect`
7. `assist_scaffold`
8. `script_validate`
9. `run_create`

## 검증 결과

2026-03-28 기준으로 아래 항목을 확인했습니다.

- `GET /api/assist/capabilities` 정상 응답
- `POST /api/assist/plan` 정상 응답
- `POST /api/assist/scaffold` 정상 응답 및 validation 통과
- `POST /api/sessions/{sessionId}/pages/{pageId}/inspect` 정상 응답
- MCP `tools/list` 에 `assist_plan`, `assist_scaffold`, `page_inspect` 노출 확인
- MCP `tools/call` 로 `assist_capabilities` 호출 정상 확인
