# REST workflows

The service exposes both a **script execution API** and a **low-level session API**.

## Discover the script registry

```http
GET /api/scripts
```

## Start a run

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

## Inspect run state

```http
GET /api/runs/{runId}
GET /api/runs/{runId}/report
GET /api/runs/{runId}/logs
GET /api/runs/{runId}/artifacts
```

## Low-level session debugging flow

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. `POST /api/sessions/{sessionId}/pages/{pageId}/click`
6. `POST /api/sessions/{sessionId}/pages/{pageId}/fill`
7. `POST /api/sessions/{sessionId}/pages/{pageId}/assert/text`
8. `POST /api/sessions/{sessionId}/pages/{pageId}/screenshot`

## Which mode should you use?

| Situation | Recommended path |
| --- | --- |
| CI or regression runs | `/api/runs` |
| Human-driven UI debugging | `/api/sessions` |
| LLM drafts first, operator verifies later | `assist APIs + sessions + runs` |

> It is safest to serialize actions inside the same session.
