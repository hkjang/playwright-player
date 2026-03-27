# Verification Report

Date: 2026-03-28
Workspace: `D:\project\playwright-player`

## Scope

Verified the single-container deployment path and both public interfaces:

- REST API
- Streamable MCP HTTP API

## Environment

- Docker image built from the local [Dockerfile](D:/project/playwright-player/Dockerfile)
- Container started with [docker-compose.yml](D:/project/playwright-player/docker-compose.yml)
- Verification target exposed at `http://127.0.0.1:3000`

## What Was Tested

### 1. Docker build and startup

- `docker compose build`
- `docker compose up -d`

Result: passed

### 2. REST health and registry

- `GET /health`
- `GET /api/scripts`

Result: passed

Observed:

- service started normally
- script registry detected `smoke`

### 3. Run API

Sample script used:

- `scripts/smoke.spec.js`

REST flow verified:

- `POST /api/runs`
- `GET /api/runs/{runId}`
- `GET /api/runs/{runId}/report`
- `GET /api/runs/{runId}/logs`
- `GET /api/runs/{runId}/artifacts`

Successful run:

- `runId`: `run_ed621f52586749cc`
- final status: `completed`
- summary: `expected=1`, `unexpected=0`

### 4. Low-level session API

REST flow verified:

- `POST /api/sessions`
- `POST /api/sessions/{id}/contexts`
- `POST /api/sessions/{id}/contexts/{contextId}/pages`
- `POST /api/sessions/{id}/pages/{pageId}/goto`
- `POST /api/sessions/{id}/pages/{pageId}/assert/text`
- `POST /api/sessions/{id}/pages/{pageId}/click`
- `POST /api/sessions/{id}/pages/{pageId}/screenshot`
- `GET /api/sessions/{id}/artifacts`
- `GET /api/sessions/{id}/actions`
- `DELETE /api/sessions/{id}`

Successful session:

- `sessionId`: `sess_d4e082e4e9754d42`
- screenshot artifact created
- action log and event log populated

### 5. MCP

MCP flow verified:

- `POST /mcp` initialize
- `POST /mcp` tools/list
- `POST /mcp` tools/call `script_list`
- `POST /mcp` tools/call `run_create`
- `POST /mcp` tools/call `run_get`
- `DELETE /mcp`

Successful MCP session:

- `mcpSessionId`: `mcp_b8ea99890d584a4e`
- tool count returned: `37`
- MCP-created run: `run_5bf584518c9c48f9`
- MCP run final status: `completed`

## Issue Found During Verification

Initial run failed because the sample script used Korean text directly inside a `data:` URL, and the inline HTML was interpreted with broken encoding inside the containerized browser.

Fix applied:

- changed the sample button text in `scripts/smoke.spec.js` from Korean text to ASCII `Login`

After the change, the run completed successfully.

## Final Result

Status: passed

The Dockerized service, REST API surface, run execution path, low-level browser session path, and Streamable MCP interface all worked successfully in end-to-end verification.
