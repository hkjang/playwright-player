# Swagger UI And Demo Page Report

## Summary

- Date: 2026-03-28
- Base URL: `http://127.0.0.1:3000`
- Runtime: Docker Compose single-container deployment
- Goal: Provide built-in Swagger UI, OpenAPI JSON, interactive API playground, and a local demo page for offline Playwright automation

## Added Endpoints

- `GET /`
  - Landing page with links to docs, playground, demo page, OpenAPI JSON, and health
- `GET /openapi.json`
  - Raw OpenAPI 3.1 document
- `GET /docs`
  - Offline-friendly Swagger UI using local `swagger-ui-dist` assets
- `GET /playground`
  - Browser-based API playground for health checks, script listing, run creation, session flow, and screenshot preview
- `GET /demo/test-page`
  - Stable local automation page with structured locator targets

## Demo Page Targets

- `data-testid="primary-action"`
- `data-testid="status"`
- `label="Message"`
- `role="button", name="Send message"`
- `data-testid="profile-result"`
- `data-testid="counter-value"`
- `data-testid="message-feed"`

## Verification

### HTTP checks

- `GET /` returned `200`
- `GET /openapi.json` returned `200`
- `GET /docs` returned `200`
- `GET /playground` returned `200`
- `GET /demo/test-page` returned `200`

### OpenAPI checks

- `openapi` version: `3.1.0`
- `paths./docs` exists
- `paths./demo/test-page` exists
- `paths./api/sessions/{sessionId}/pages/{pageId}/screenshot` exists

### Browser flow checks

The following low-level session flow was executed successfully against the local demo page:

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. `POST /api/sessions/{sessionId}/pages/{pageId}/click`
6. `POST /api/sessions/{sessionId}/pages/{pageId}/fill`
7. `POST /api/sessions/{sessionId}/pages/{pageId}/click`
8. `POST /api/sessions/{sessionId}/pages/{pageId}/assert/text`
9. `POST /api/sessions/{sessionId}/pages/{pageId}/screenshot`
10. `DELETE /api/sessions/{sessionId}`

Verification result:

- Session ID: `sess_c2de19db1c614178`
- Context ID: `ctx_3ec357f3c81a4ae9`
- Page ID: `page_a1aa00a3d4b341b2`
- Screenshot artifact ID: `artifact_8f6f7e29bfd64adf`
- Download path: `/api/sessions/sess_c2de19db1c614178/artifacts/artifact_8f6f7e29bfd64adf`
- Downloaded screenshot size: `292522` bytes

## Screenshot Artifact

- Saved file: `D:/project/playwright-player/data/docs-playground-demo-verification.png`

## UI Screenshots

- Swagger UI screen: `D:/project/playwright-player/data/swagger-ui-screen.png`
- Playground screen: `D:/project/playwright-player/data/playground-screen.png`

## Notes

- Swagger UI is served from local package assets and does not depend on external CDNs.
- The playground is intended for quick operator checks in offline or restricted networks.
- The demo page is intentionally deterministic and exposes stable role, label, and `data-testid` targets for API verification.
