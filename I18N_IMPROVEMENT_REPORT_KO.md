# 브라우저 언어 대응 및 LLM 보조 API 개선 보고서

기준일: 2026-03-28

## 이번 개선 사항

- 제공 페이지를 브라우저 언어 기준으로 동작하도록 개선
  - `/`
  - `/playground`
  - `/demo/test-page`
- `?lang=ko`, `?lang=en` 쿼리로 언어 강제 지정 지원
- 데모 페이지에서 언어가 바뀌어도 자동화가 흔들리지 않도록 안정적인 `data-testid` 유지
  - `primary-action`
  - `status`
  - `message-input`
  - `send-message`
  - `profile-result`
  - `counter-value`
- API Playground의 세션 플로우를 언어 독립적인 `testId` 기반 조작으로 개선
- LLM 보조 API 추가
  - `GET /api/assist/examples`
- MCP tool 추가
  - `assist_examples`
- `assist_plan`, `assist_scaffold`의 입력 모델에 `language`, `pageInspection` 확장

## 검증 결과

### 정적 페이지 확인

- `/?lang=ko`
  - 한국어 홈 문구 노출 확인
  - `브라우저 언어에 맞춰 한국어와 영어를 자동 전환합니다.` 확인
- `/demo/test-page?lang=ko`
  - `준비 완료` 확인
  - `data-testid="message-input"` 확인
  - `표시 문구는 한국어와 영어로 바뀌지만 test id는 고정됩니다.` 확인
- `/demo/test-page` + `Accept-Language: en-US`
  - 영어 문구와 고정 `test id` 안내 확인

### REST / OpenAPI / MCP 확인

- `/openapi.json`
  - `/api/assist/examples` 노출 확인
  - `/api/sessions/{sessionId}/pages/{pageId}/inspect` 노출 확인
- `/api/assist/examples?language=ko`
  - 한국어 자연어 예제 3건 반환 확인
  - `chatSend` 패턴에 `message-input`, `send-message` 포함 확인
- MCP `tools/list`
  - `assist_examples` 노출 확인
  - `page_inspect` 노출 확인

### 브라우저 세션 기반 실제 조작 확인

한국어와 영어 각각 별도 브라우저 세션으로 아래를 수행했습니다.

1. 홈 페이지 로드 및 스크린샷 저장
2. 플레이그라운드 페이지 로드 및 스크린샷 저장
3. 데모 페이지 로드 및 초기 스크린샷 저장
4. `primary-action` 클릭
5. `message-input`에 메시지 입력
6. `send-message` 클릭
7. 상태 텍스트와 채팅 요약 텍스트 확인
8. 최종 스크린샷 저장

결과:

- 한국어
  - 제목: `Playwright Player 데모 페이지`
  - 클릭 후 상태: `기본 액션 클릭됨`
  - 전송 후 상태: `메시지 전송 완료`
  - 채팅 요약: `마지막 메시지: ping-ko`
- 영어
  - 제목: `Playwright Player Demo Page`
  - 클릭 후 상태: `Primary clicked`
  - 전송 후 상태: `Message sent`
  - 채팅 요약: `Last message: ping-en`

## 산출물

### 스크린샷

- `data/i18n-checks/ko-home.png`
- `data/i18n-checks/ko-playground.png`
- `data/i18n-checks/ko-demo-before.png`
- `data/i18n-checks/ko-demo-after.png`
- `data/i18n-checks/en-home.png`
- `data/i18n-checks/en-playground.png`
- `data/i18n-checks/en-demo-before.png`
- `data/i18n-checks/en-demo-after.png`

### 참고 파일

- `data/home-ko.html`
- `data/home-en.html`
- `data/demo-ko.html`
- `data/assist-examples-ko.json`

## 메모

- PowerShell에서 한글 문자열을 JSON 요청 본문으로 직접 보내는 경우 콘솔 인코딩 영향으로 값이 깨질 수 있어, 검증에서는 상태 조회 중심으로 확인했습니다.
- 서비스 자체의 언어 처리와 페이지 렌더링은 정상 동작했습니다.
