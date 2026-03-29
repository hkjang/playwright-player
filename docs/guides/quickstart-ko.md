# 빠른 시작

`playwright-player`는 Playwright를 **세션 유지형 REST API**와 **Streamable MCP** 뒤에 감싼 단일 컨테이너 서비스입니다.

## 핵심 운영 모드

| 모드 | 대표 엔드포인트 | 용도 |
| --- | --- | --- |
| 스크립트 실행 | `/api/runs` | 등록된 Playwright spec을 실행하고 리포트와 산출물을 회수 |
| 디버그 세션 | `/api/sessions` | 브라우저 상태를 유지하면서 클릭, 입력, 검증을 단계별 수행 |
| AI agent 연동 | `/mcp` | LLM 또는 agent가 MCP tool로 같은 표면을 호출 |

## 기본 진입점

- 헬스체크: `GET /health`
- Swagger UI: `/docs`
- API Playground: `/playground`
- 데모 테스트 페이지: `/demo/test-page`
- MCP endpoint: `POST /mcp`

## 첫 실행 흐름

1. `/api/scripts`로 등록된 스크립트를 조회합니다.
2. `/api/runs`로 실행을 시작합니다.
3. `/api/runs/{runId}`에서 상태를 확인합니다.
4. `/api/runs/{runId}/report`, `/logs`, `/artifacts`로 결과를 회수합니다.

## 디버깅이 필요하면

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. `click`, `fill`, `assert/text`, `screenshot` 순으로 조작

## 프로젝트가 맞는 경우

- 오프라인망에서 브라우저 자동화를 중앙 서비스로 제공하려는 경우
- AI agent가 테스트 자동화 API를 직접 호출해야 하는 경우
- 스크립트 실행 API와 사람 중심 디버그 API를 함께 제공해야 하는 경우

> 권장 패턴은 브라우저는 오래 살리고 context를 짧게 유지하는 구조입니다.

## 다음으로 읽기

- `오프라인 배포`
- `REST 워크플로`
- `LLM + MCP 작성 가이드`
