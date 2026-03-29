# REST 워크플로

이 서비스는 **스크립트 실행 API**와 **저수준 세션 API**를 모두 제공합니다.

## 스크립트 레지스트리 조회

```http
GET /api/scripts
```

## 실행 시작 예시

```json
{
  "scriptKey": "checkout/guest-order",
  "project": "chromium",
  "env": "staging",
  "baseURL": "https://stg.example.com",
  "grep": "@smoke",
  "trace": "on-first-retry",
  "video": "retain-on-failure",
  "variables": {
    "sku": "ABC-1001",
    "locale": "ko-KR"
  }
}
```

```http
POST /api/runs
```

## 실행 상태 확인

```http
GET /api/runs/{runId}
GET /api/runs/{runId}/report
GET /api/runs/{runId}/logs
GET /api/runs/{runId}/artifacts
```

## 저수준 세션 디버그 흐름

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. `POST /api/sessions/{sessionId}/pages/{pageId}/click`
6. `POST /api/sessions/{sessionId}/pages/{pageId}/fill`
7. `POST /api/sessions/{sessionId}/pages/{pageId}/assert/text`
8. `POST /api/sessions/{sessionId}/pages/{pageId}/screenshot`

## 실행 방식 선택 기준

| 상황 | 추천 |
| --- | --- |
| CI, 회귀 테스트 | `/api/runs` |
| 사람이 직접 UI 디버깅 | `/api/sessions` |
| LLM이 초안 작성 후 운영자가 검증 | `assist API + sessions + runs` |

> 같은 세션 안의 액션은 직렬화해서 보내는 것이 안전합니다.
