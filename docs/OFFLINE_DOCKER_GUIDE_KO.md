# 오프라인망 Docker 이미지 로드/실행 가이드

기준 버전: `v0.1.3`

이 문서는 외부망에서 받은 `playwright-player` Docker 이미지 `tar.gz`를 오프라인망 서버나 작업 PC에 옮긴 뒤, 로드하고 실행하는 가장 단순한 절차를 정리합니다.

## 준비물

- Docker Engine 또는 Docker Desktop
- 릴리즈 자산
  - `playwright-player-v0.1.3-docker-image.tar.gz`
  - `playwright-player-v0.1.3-docker-image.tar.gz.sha256`
- 이 저장소 소스 또는 최소한 아래 파일
  - `tools/offline-load-run.ps1`
  - 본 가이드 문서

권장 여유 공간:

- 이미지 로드 및 압축 해제를 위해 최소 `6GB` 이상

## 1. 파일 반입

외부망에서 아래 파일을 내려받아 오프라인망으로 복사합니다.

- Docker 이미지 압축 파일
- SHA256 체크섬 파일
- 저장소 문서 및 스크립트

예시 폴더:

```text
C:\offline\playwright-player\
  playwright-player-v0.1.3-docker-image.tar.gz
  playwright-player-v0.1.3-docker-image.tar.gz.sha256
  playwright-player\
    tools\
      offline-load-run.ps1
    docs\
      OFFLINE_DOCKER_GUIDE_KO.md
```

## 2. 체크섬 검증

PowerShell:

```powershell
$file = ".\\playwright-player-v0.1.3-docker-image.tar.gz"
$expected = (Get-Content ".\\playwright-player-v0.1.3-docker-image.tar.gz.sha256").Split(" ")[0].Trim()
$actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()

[pscustomobject]@{
  expected = $expected
  actual = $actual
  match = ($expected -eq $actual)
}
```

`match`가 `True`인지 확인합니다.

## 3. 가장 쉬운 실행 방법

저장소 루트에서 아래 스크립트를 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\offline-load-run.ps1 `
  -ArchivePath "C:\offline\playwright-player\playwright-player-v0.1.3-docker-image.tar.gz" `
  -ImageRef "playwright-player:v0.1.3"
```

기본 동작:

- `tar.gz`를 임시 `tar`로 풀고 `docker load`
- 기존 `playwright-player` 컨테이너가 있으면 제거
- `playwright-player:v0.1.3` 이미지로 새 컨테이너 실행
- 아래 폴더를 자동 생성하고 마운트
  - `offline-runtime/scripts`
  - `offline-runtime/storage-states`
  - `offline-runtime/data`

실행 후 기본 접속 주소:

- 헬스체크: `http://127.0.0.1:3000/health`
- Swagger UI: `http://127.0.0.1:3000/docs`
- Playground: `http://127.0.0.1:3000/playground`
- 데모 페이지: `http://127.0.0.1:3000/demo/test-page`

## 4. 자주 쓰는 옵션

포트를 바꾸는 예:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\offline-load-run.ps1 `
  -ArchivePath ".\\playwright-player-v0.1.3-docker-image.tar.gz" `
  -ImageRef "playwright-player:v0.1.3" `
  -HostPort 3300
```

컨테이너 이름을 바꾸는 예:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\offline-load-run.ps1 `
  -ArchivePath ".\\playwright-player-v0.1.3-docker-image.tar.gz" `
  -ImageRef "playwright-player:v0.1.3" `
  -ContainerName "playwright-player-offline"
```

환경에 따라 `--ipc=host`를 빼야 할 때:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\offline-load-run.ps1 `
  -ArchivePath ".\\playwright-player-v0.1.3-docker-image.tar.gz" `
  -ImageRef "playwright-player:v0.1.3" `
  -DisableIpcHost
```

## 5. 직접 명령으로 실행하는 방법

### Windows PowerShell

```powershell
tar -xzf .\\playwright-player-v0.1.3-docker-image.tar.gz
docker load -i .\\playwright-player-v0.1.3-docker-image.tar

New-Item -ItemType Directory -Force -Path .\\offline-runtime\\scripts | Out-Null
New-Item -ItemType Directory -Force -Path .\\offline-runtime\\storage-states | Out-Null
New-Item -ItemType Directory -Force -Path .\\offline-runtime\\data | Out-Null

docker rm -f playwright-player 2>$null

docker run -d `
  --name playwright-player `
  --init `
  --ipc=host `
  -p 3000:3000 `
  -e PORT=3000 `
  -e DEFAULT_HEADLESS=true `
  -e ENABLE_EVALUATE=true `
  -v "${PWD}\\offline-runtime\\scripts:/app/scripts" `
  -v "${PWD}\\offline-runtime\\storage-states:/app/storage-states" `
  -v "${PWD}\\offline-runtime\\data:/app/data" `
  playwright-player:v0.1.3
```

### Linux / Bash

```bash
gzip -dc ./playwright-player-v0.1.3-docker-image.tar.gz > ./playwright-player-v0.1.3-docker-image.tar
docker load -i ./playwright-player-v0.1.3-docker-image.tar

mkdir -p ./offline-runtime/scripts ./offline-runtime/storage-states ./offline-runtime/data
docker rm -f playwright-player >/dev/null 2>&1 || true

docker run -d \
  --name playwright-player \
  --init \
  --ipc=host \
  -p 3000:3000 \
  -e PORT=3000 \
  -e DEFAULT_HEADLESS=true \
  -e ENABLE_EVALUATE=true \
  -v "$(pwd)/offline-runtime/scripts:/app/scripts" \
  -v "$(pwd)/offline-runtime/storage-states:/app/storage-states" \
  -v "$(pwd)/offline-runtime/data:/app/data" \
  playwright-player:v0.1.3
```

## 6. 실행 확인

헬스체크:

```powershell
Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:3000/health" | ConvertTo-Json -Depth 5
```

예상:

- `success: true`
- `data.service: playwright-player`

## 7. Playwright 스크립트 넣는 위치

기본 경로:

- `offline-runtime/scripts`

자동 등록되는 파일 패턴:

- `*.spec.js`
- `*.spec.ts`
- `*.test.js`
- `*.test.ts`
- `*.pw.js`
- `*.pw.ts`

예:

```text
offline-runtime/scripts/
  smoke/
    demo-page.spec.js
```

서비스 실행 중에도 `POST /api/scripts/sync`로 다시 스캔할 수 있습니다.

## 8. 중지 및 삭제

```powershell
docker stop playwright-player
docker rm playwright-player
```

포트나 이름을 바꿨다면 같은 값으로 바꿔서 실행합니다.

## 9. 운영 팁

- 인증 상태 파일은 `offline-runtime/storage-states`에 둡니다.
- 실행 산출물과 스크린샷은 `offline-runtime/data`에 쌓입니다.
- 브라우저 언어 대응 내장 페이지:
  - `/`
  - `/playground`
  - `/demo/test-page`
- 위 페이지는 `Accept-Language`를 따라 한국어/영어를 전환하며 `?lang=ko`, `?lang=en`도 지원합니다.

## 10. 관련 문서

- `README.md`
- `API_CALL_EXAMPLES_KO.md`
- `I18N_IMPROVEMENT_REPORT_KO.md`
- `LLM_AUTHORING_ASSIST_KO.md`

