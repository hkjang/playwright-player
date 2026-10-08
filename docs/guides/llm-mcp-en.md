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

The core `browser_*` tools follow [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp). Keep the `Mcp-Session-Id` header returned by initialization; the server manages an isolated browser and active tab for each MCP connection.

Send each JSON object as a separate `POST /mcp` request, with `Authorization: Bearer <token>` when `API_TOKEN` is configured:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"http://127.0.0.1:3000/demo/test-page"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_take_screenshot","arguments":{"fullPage":true,"type":"png"}}}
```

Use snapshot references with either legacy `ref` or current `target` arguments; `target` also accepts a unique selector. Both screenshot tools return a standard MCP `image` content block and keep download metadata in `structuredContent.artifact`. No external image host or access to container paths is needed. Clients without image support can fetch the authenticated REST artifact endpoint.

`browser_take_screenshot` defaults to the viewport; the existing `page_screenshot` keeps its full-page default. PNG/JPEG and the documented core browser tools are supported. Optional upstream extensions, browser downloads, and arbitrary server-side code execution are outside this compatibility layer. `filename` names a server artifact, not a file on the client machine. Deleting or expiring the MCP session closes its browser.

The existing authoring and execution tools remain available:

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
