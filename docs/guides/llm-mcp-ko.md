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
