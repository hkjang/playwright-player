# LLM + MCP authoring

When an offline LLM receives a user request and needs to turn it into test automation, it helps to separate **planning**, **observation**, **scaffold generation**, and **verification**.

## Recommended order

1. `GET /api/assist/capabilities`
2. `POST /api/assist/plan`
3. `POST /api/sessions`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/inspect`
5. `POST /api/assist/scaffold`
6. `POST /api/scripts/validate`
7. `POST /api/runs`

## MCP tools to use directly

- `assist_capabilities`
- `assist_examples`
- `assist_plan`
- `assist_scaffold`
- `page_inspect`
- `run_create`
- `run_get`

## A good natural-language request

```text
Create a Playwright test that signs in as an admin, enables the notification toggle on the settings page, clicks save, and verifies the success toast.
```

## Inputs that improve generation quality

- Target environment: `baseURL`, `env`
- User type: admin, member, guest
- Core assertions: text, URL, count, visibility
- Reusable auth state: `storageStateRef`
- Stable locator hints: `role`, `label`, `testId`

## Why page inspect matters

`page_inspect` collects headings, visible text, and locator candidates from a live page. Even when an offline LLM cannot digest the whole DOM, it still gets strong hints for stable click targets and assertions.

> Structured locators are far more reliable than raw CSS selectors for LLM-driven test generation.
