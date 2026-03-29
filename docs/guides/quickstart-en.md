# Offline deployment

`playwright-player` ships well as a **single Docker image tar.gz** that can be transferred into an air-gapped environment.

## Operating modes

| Mode | Primary endpoint | Why it matters |
| --- | --- | --- |
| Script runs | `/api/runs` | Execute registered Playwright specs and collect reports and artifacts |
| Debug sessions | `/api/sessions` | Keep browser state warm while driving individual actions |
| AI-agent integration | `/mcp` | Let an LLM or agent call the same surface through Streamable MCP |

## Entry points

- Health: `GET /health`
- Swagger UI: `/docs`
- API Playground: `/playground`
- Demo test page: `/demo/test-page`
- MCP endpoint: `POST /mcp`

## First execution flow

1. Query `/api/scripts` to discover registered specs.
2. Start a run with `/api/runs`.
3. Poll `/api/runs/{runId}` for status.
4. Collect `/report`, `/logs`, and `/artifacts`.

## If you need debugging

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. Drive `click`, `fill`, `assert/text`, and `screenshot` step by step

## Good fit when

- You need a central browser automation service in an offline network
- AI agents must call the automation API directly
- You want both a script execution API and a human-friendly debug API

> The recommended pattern is to keep the browser warm and keep contexts short-lived.

## Read next

- `Offline deployment`
- `REST workflows`
- `LLM + MCP authoring`
