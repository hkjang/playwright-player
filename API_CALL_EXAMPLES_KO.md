# API 호출 예제 모음

Date: 2026-03-28
Workspace: `D:\project\playwright-player`
Target: `http://127.0.0.1:3000`

이 문서는 `playwright-player`를 한국어 기준으로 바로 사용할 수 있게 정리한 PowerShell 예제 모음입니다.

기본 전제:

- 서비스가 이미 실행 중이어야 합니다.
- 기본 주소는 `http://127.0.0.1:3000` 입니다.
- 예제는 Windows PowerShell 기준입니다.

## 공통 변수

```powershell
$base = "http://127.0.0.1:3000"
$api = "$base/api"
$mcp = "$base/mcp"
```

## 1. 헬스체크와 스크립트 레지스트리

### 헬스체크

```powershell
Invoke-RestMethod -Uri "$base/health" | ConvertTo-Json -Depth 5
```

### 스크립트 목록 조회

```powershell
Invoke-RestMethod -Uri "$api/scripts" | ConvertTo-Json -Depth 6
```

### 스크립트 재동기화

```powershell
Invoke-RestMethod -Method Post -Uri "$api/scripts/sync" | ConvertTo-Json -Depth 6
```

### 스크립트 상세 조회

```powershell
$scriptKey = "naver-home"
Invoke-RestMethod -Uri "$api/scripts/$scriptKey" | ConvertTo-Json -Depth 6
```

## 2. Run API

### 실행 요청

아래 예제는 `naver-home` 스크립트를 `chromium` 프로젝트로 실행합니다.

```powershell
$body = @{
  scriptKey = "naver-home"
  project = "chromium"
  headed = $false
  trace = "retain-on-failure"
  video = "retain-on-failure"
  screenshot = "only-on-failure"
  variables = @{
    locale = "ko-KR"
  }
} | ConvertTo-Json -Depth 10

$create = Invoke-RestMethod -Method Post -Uri "$api/runs" -ContentType "application/json" -Body $body
$runId = $create.data.runId
$runId
```

### 실행 완료까지 폴링

```powershell
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  $run = Invoke-RestMethod -Uri "$api/runs/$runId"
  if ($run.data.status -ne "running") {
    break
  }
}

$run | ConvertTo-Json -Depth 8
```

### 실행 상태 조회

```powershell
Invoke-RestMethod -Uri "$api/runs/$runId" | ConvertTo-Json -Depth 8
```

### 로그 조회

```powershell
Invoke-RestMethod -Uri "$api/runs/$runId/logs" | ConvertTo-Json -Depth 8
```

### 리포트 조회

```powershell
Invoke-RestMethod -Uri "$api/runs/$runId/report" | ConvertTo-Json -Depth 12
```

### 아티팩트 목록 조회

```powershell
Invoke-RestMethod -Uri "$api/runs/$runId/artifacts" | ConvertTo-Json -Depth 8
```

### 실행 취소

```powershell
Invoke-RestMethod -Method Post -Uri "$api/runs/$runId/cancel" | ConvertTo-Json -Depth 6
```

## 3. Session API

세션 API는 디버그용 저수준 브라우저 제어에 적합합니다.

### 세션 생성

```powershell
$session = Invoke-RestMethod -Method Post -Uri "$api/sessions" -ContentType "application/json" -Body (@{
  browserType = "chromium"
  headed = $false
} | ConvertTo-Json)

$sessionId = $session.data.sessionId
$sessionId
```

### 컨텍스트 생성

```powershell
$context = Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/contexts" -ContentType "application/json" -Body (@{
  locale = "ko-KR"
  viewport = @{
    width = 1440
    height = 1200
  }
} | ConvertTo-Json -Depth 10)

$contextId = $context.data.contextId
$contextId
```

### 페이지 생성

```powershell
$page = Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/contexts/$contextId/pages" -ContentType "application/json" -Body (@{} | ConvertTo-Json)
$pageId = $page.data.pageId
$pageId
```

### 페이지 이동

```powershell
Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/pages/$pageId/goto" -ContentType "application/json" -Body (@{
  url = "https://www.naver.com"
  waitUntil = "domcontentloaded"
} | ConvertTo-Json) | ConvertTo-Json -Depth 6
```

### 요소 표시 검증

```powershell
Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/pages/$pageId/assert/visible" -ContentType "application/json" -Body (@{
  locator = @{
    css = "input[name='query']"
  }
  timeoutMs = 10000
} | ConvertTo-Json -Depth 10) | ConvertTo-Json -Depth 6
```

### 텍스트 검증

```powershell
Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/pages/$pageId/assert/text" -ContentType "application/json" -Body (@{
  locator = @{
    css = "title"
  }
  value = "NAVER"
  match = "contains"
} | ConvertTo-Json -Depth 10) | ConvertTo-Json -Depth 6
```

주의:

- `assert/text`는 `locator`가 실제 텍스트를 가진 요소를 가리켜야 합니다.
- `title` 같은 케이스는 DOM 요소보다 `assert/url` 또는 `page/evaluate`가 더 자연스러울 때가 있습니다.

### 스크린샷 생성

```powershell
$screenshot = Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/pages/$pageId/screenshot" -ContentType "application/json" -Body (@{
  fullPage = $true
  type = "png"
} | ConvertTo-Json)

$screenshot | ConvertTo-Json -Depth 8
```

### 세션 아티팩트 조회

```powershell
Invoke-RestMethod -Uri "$api/sessions/$sessionId/artifacts" | ConvertTo-Json -Depth 8
```

### 액션 로그 조회

```powershell
Invoke-RestMethod -Uri "$api/sessions/$sessionId/actions" | ConvertTo-Json -Depth 8
```

### 세션 종료

```powershell
Invoke-RestMethod -Method Delete -Uri "$api/sessions/$sessionId" | ConvertTo-Json -Depth 6
```

## 4. Session 배치 실행 예제

```powershell
$stepsBody = @{
  pageId = $pageId
  steps = @(
    @{
      action = "goto"
      url = "https://www.naver.com"
      waitUntil = "domcontentloaded"
    },
    @{
      action = "waitFor"
      locator = @{
        css = "input[name='query']"
      }
      timeoutMs = 10000
    },
    @{
      action = "locatorQuery"
      locator = @{
        css = "a"
      }
      operation = "count"
    },
    @{
      action = "screenshot"
      fullPage = $true
      type = "png"
    }
  )
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "$api/sessions/$sessionId/execute" -ContentType "application/json" -Body $stepsBody | ConvertTo-Json -Depth 12
```

## 5. Locator 형식 예시

구조화 locator 예시는 아래처럼 사용할 수 있습니다.

```json
{
  "locator": {
    "role": "button",
    "name": "로그인"
  }
}
```

지원되는 주요 locator 키:

- `role`
- `text`
- `label`
- `placeholder`
- `testId`
- `altText`
- `title`
- `css`
- `xpath`
- `selector`

추가 옵션:

- `exact`
- `hasText`
- `nth`
- `first`
- `last`

## 6. MCP 호출 예제

### initialize

```powershell
$initBody = @{
  jsonrpc = "2.0"
  id = 1
  method = "initialize"
  params = @{
    protocolVersion = "2025-03-26"
    capabilities = @{}
    clientInfo = @{
      name = "powershell-client"
      version = "1.0.0"
    }
  }
} | ConvertTo-Json -Depth 10

$initResponse = Invoke-WebRequest -Method Post -Uri $mcp -ContentType "application/json" -Body $initBody
$mcpSessionId = $initResponse.Headers["Mcp-Session-Id"]
$initResponse.Content
$mcpSessionId
```

### tools/list

```powershell
$toolsListBody = @{
  jsonrpc = "2.0"
  id = 2
  method = "tools/list"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri $mcp -Headers @{ "Mcp-Session-Id" = $mcpSessionId } -ContentType "application/json" -Body $toolsListBody | ConvertTo-Json -Depth 12
```

### script_list 툴 호출

```powershell
$scriptListBody = @{
  jsonrpc = "2.0"
  id = 3
  method = "tools/call"
  params = @{
    name = "script_list"
    arguments = @{}
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri $mcp -Headers @{ "Mcp-Session-Id" = $mcpSessionId } -ContentType "application/json" -Body $scriptListBody | ConvertTo-Json -Depth 12
```

### run_create 툴 호출

```powershell
$runCreateBody = @{
  jsonrpc = "2.0"
  id = 4
  method = "tools/call"
  params = @{
    name = "run_create"
    arguments = @{
      scriptKey = "naver-home"
      project = "chromium"
      headed = $false
    }
  }
} | ConvertTo-Json -Depth 12

$runCreate = Invoke-RestMethod -Method Post -Uri $mcp -Headers @{ "Mcp-Session-Id" = $mcpSessionId } -ContentType "application/json" -Body $runCreateBody
$runCreate | ConvertTo-Json -Depth 12
```

### MCP 세션 종료

```powershell
Invoke-WebRequest -Method Delete -Uri $mcp -Headers @{ "Mcp-Session-Id" = $mcpSessionId }
```

## 7. 아티팩트 파일 직접 받기

세션 아티팩트는 `downloadPath`를 그대로 붙여서 받을 수 있습니다.

```powershell
$artifacts = Invoke-RestMethod -Uri "$api/sessions/$sessionId/artifacts"
$downloadPath = $artifacts.data.artifacts[0].downloadPath
Invoke-WebRequest -Uri "$base$downloadPath" -OutFile ".\\artifact-download.png"
```

## 8. 추천 사용 흐름

자동 실행 중심:

1. `POST /api/scripts/sync`
2. `POST /api/runs`
3. `GET /api/runs/{runId}`
4. `GET /api/runs/{runId}/report`
5. `GET /api/runs/{runId}/artifacts`

디버그 중심:

1. `POST /api/sessions`
2. `POST /api/sessions/{sessionId}/contexts`
3. `POST /api/sessions/{sessionId}/contexts/{contextId}/pages`
4. `POST /api/sessions/{sessionId}/pages/{pageId}/goto`
5. `POST /api/sessions/{sessionId}/pages/{pageId}/click`
6. `POST /api/sessions/{sessionId}/pages/{pageId}/assert/*`
7. `POST /api/sessions/{sessionId}/pages/{pageId}/screenshot`
8. `DELETE /api/sessions/{sessionId}`
