# Screenshot Verification Report

Date: 2026-03-28
Workspace: `D:\project\playwright-player`
Target: `http://127.0.0.1:3000`
Execution mode: single Docker container, REST API driven Playwright runs

## Scope

This report extends the earlier base verification with screenshot-focused testing against:

- a richer offline chat-style application scenario
- well-known Korean public sites
- general public web app flows
- the low-level session screenshot API

All automated checks were executed through the service itself, not by calling Playwright directly from the host.

## Environment

- Container runtime: `docker compose up -d`
- API server: single container
- Browser runtime: Playwright in the same container
- Browser project used for this report: `chromium`
- Run options:
  - `headed: false`
  - `trace: retain-on-failure`
  - `video: retain-on-failure`
  - `screenshot: only-on-failure`
- Pass screenshots and DOM dumps were also attached explicitly from the test scripts.

## Final Run Matrix

### 1. Offline complex chat workspace

- Status: passed
- Run ID: `run_f59d9bc401764c40`
- Script: `chat-offline-workspace`
- Verified:
  - login into a workspace
  - channel switch to `#support`
  - thread selection
  - thread reply submission
  - channel message submission
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_f59d9bc401764c40/test-results/chat-offline-workspace-off-297c2-annels-thread-and-send-flow-chromium/offline-chat-workspace.png`
- Representative DOM capture:
  - `data/runs/run_f59d9bc401764c40/test-results/chat-offline-workspace-off-297c2-annels-thread-and-send-flow-chromium/offline-chat-workspace-dom.html`

### 2. Demo login flow

- Status: passed
- Run ID: `run_c313ba365279485c`
- Script: `login-demo`
- Verified:
  - form fill
  - sign-in
  - post-login secure area assertion
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_c313ba365279485c/test-results/login-demo-the-internet-login-accepts-known-demo-credentials-chromium/heroku-login-secure-area.png`
- Representative DOM capture:
  - `data/runs/run_c313ba365279485c/test-results/login-demo-the-internet-login-accepts-known-demo-credentials-chromium/heroku-login-dom.html`

### 3. Demo SPA workflow

- Status: passed
- Run ID: `run_72f492eca58942ce`
- Script: `todomvc-demo`
- Verified:
  - item creation
  - item completion
  - remaining count assertion
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_72f492eca58942ce/test-results/todomvc-demo-todomvc-demo-supports-add-and-complete-chromium/todomvc-state.png`
- Representative DOM capture:
  - `data/runs/run_72f492eca58942ce/test-results/todomvc-demo-todomvc-demo-supports-add-and-complete-chromium/todomvc-dom.html`

### 4. Naver home

- Status: passed
- Run ID: `run_a971b2b5247e4447`
- Script: `naver-home`
- Verified:
  - page load
  - search input visible
  - news section visible
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_a971b2b5247e4447/test-results/naver-home-naver-home-renders-search-and-news-chromium/naver-home.png`
- Representative DOM capture:
  - `data/runs/run_a971b2b5247e4447/test-results/naver-home-naver-home-renders-search-and-news-chromium/naver-home-dom.html`

### 5. Daum home

- Status: passed
- Run ID: `run_a0210760d7134b2a`
- Script: `daum-home`
- Verified:
  - page load
  - search input visible
  - news link visible
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_a0210760d7134b2a/test-results/daum-home-daum-home-renders-search-and-news-chromium/daum-home.png`
- Representative DOM capture:
  - `data/runs/run_a0210760d7134b2a/test-results/daum-home-daum-home-renders-search-and-news-chromium/daum-home-dom.html`

### 6. YES24 home

- Status: passed
- Run ID: `run_5aeaf321298143a0`
- Script: `yes24-home`
- Verified:
  - page load
  - search input visible
  - bestseller entry link visible
  - screenshot and DOM capture on success
- Representative screenshot:
  - `data/runs/run_5aeaf321298143a0/test-results/yes24-home-yes24-home-renders-search-and-bestseller-entry-chromium/yes24-home.png`
- Representative DOM capture:
  - `data/runs/run_5aeaf321298143a0/test-results/yes24-home-yes24-home-renders-search-and-bestseller-entry-chromium/yes24-home-dom.html`

### 7. Coupang home

- Status: failed by design observation
- Run ID: `run_3deff408fc4045a9`
- Script: `coupang-home`
- Verified:
  - automated headless container access was attempted
  - screenshot, HTML, video, and trace were captured on failure
- Observed failure:
  - the page responded with `Access Denied` under headless containerized automation
- Representative screenshot:
  - `data/runs/run_3deff408fc4045a9/test-results/coupang-home-coupang-home--378d2-e-from-a-headless-container-chromium/coupang-access-denied.png`
- Representative DOM capture:
  - `data/runs/run_3deff408fc4045a9/test-results/coupang-home-coupang-home--378d2-e-from-a-headless-container-chromium/coupang-access-denied-dom.html`
- Failure artifacts:
  - trace: `data/runs/run_3deff408fc4045a9/test-results/coupang-home-coupang-home--378d2-e-from-a-headless-container-chromium/trace.zip`
  - video: `data/runs/run_3deff408fc4045a9/test-results/coupang-home-coupang-home--378d2-e-from-a-headless-container-chromium/video.webm`

## Low-Level Session Screenshot API

- Status: passed
- Session ID: `sess_ec34babe3c6e43b0`
- Context ID: `ctx_a17075396e2444d3`
- Page ID: `page_8e83173782134c8d`
- Target URL: `https://www.naver.com/`
- Screenshot artifact ID: `artifact_b34e5f7704f14e80`
- Screenshot file:
  - `data/artifacts/sess_ec34babe3c6e43b0/artifact_b34e5f7704f14e80-screenshot.png`
- Notes:
  - low-level session creation, context creation, page creation, navigation, screenshot capture, artifact listing, and cleanup were all exercised through REST endpoints

## Key Findings

- The single-container REST architecture successfully produced stable screenshots and DOM captures across multiple site categories.
- The offline chat workspace scenario is the most reliable proxy for intranet or air-gapped collaboration UI testing because it avoids third-party variability while still exercising a rich interaction model.
- Naver, Daum, and YES24 were reachable and automatable from the headless container on 2026-03-28.
- Coupang blocked the same headless containerized flow with an `Access Denied` response. This is a useful real-world finding rather than a server defect.
- Failure handling is in good shape for blocked or unstable sites because screenshot, DOM, trace, and video artifacts were retained and are inspectable.

## Overall Result

Status: passed with one documented external-site block

The service now has verified evidence for:

- screenshot generation on successful runs
- screenshot generation on failure
- DOM capture on successful runs
- trace and video capture on failure
- low-level session screenshot capture
- testing against multiple real Korean public sites
- testing against a richer chat-style application flow suitable for offline automation environments
