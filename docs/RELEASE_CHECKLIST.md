# 릴리즈 체크리스트

이 프로젝트의 산출물은 git 태그가 아니라 **오프라인망에 반입해 `docker load` 하는 이미지**입니다. 따라서 이미지가 실제로 동작하는 것을 확인한 뒤에 릴리즈를 공개합니다.

아래 항목은 과거에 실제로 놓쳐서 깨진 릴리즈가 나간 적이 있는 것들입니다. 줄여서 실행하지 마세요.

## 1. 코드

```bash
SMOKE_REQUIRE_BROWSER=1 npm test
```

`npm test` 만으로는 부족합니다. 브라우저 미설치를 `SKIP` 으로 넘기면 실행 실패를 놓칩니다.

## 2. 이미지 빌드

```bash
docker build -t playwright-player:vX.Y.Z .
```

## 3. 이미지 검증 — **README에 적힌 방식 그대로**

볼륨을 마운트하지 않고 띄우면 통과하지만 실제 사용에서는 깨지는 문제가 있습니다. v0.3.0·v0.4.0 이 이렇게 나갔습니다.

```bash
docker run -d --name ppcheck --init --ipc=host -p 3000:3000 \
  -v "$PWD/data:/app/data" -v "$PWD/scripts:/app/scripts" \
  playwright-player:vX.Y.Z
```

| 확인 | 왜 |
| --- | --- |
| `/health` 가 응답하고 버전이 맞는지 | 기본 |
| `node server.js` 가 비root 인지 (`ps -eo user,args`) | 권한 축소가 유지되는지 |
| **세션 생성** (`POST /api/sessions`) | 스크립트 실행만 확인하면 놓칩니다. v0.5.1·v0.6.0 이 이렇게 나갔고, 컨테이너에서 브라우저 세션이 깨져 있었습니다 |
| 세션에서 goto + 스크린샷 | 렌더러가 실제로 동작하는지 |
| **스크립트 실행**이 `completed` 인지 | `running` 이 아님을 보는 것으로는 부족합니다 |
| `URL_ALLOWLIST` 를 준 실행이 정책을 따르는지 | 실행 경로는 세션과 다른 메커니즘을 씁니다 |
| 호스트 `scripts` 디렉터리 소유권이 바뀌지 않았는지 | entrypoint 가 사용자 소스를 건드리면 안 됩니다 |
| `docker kill` 후 **새 컨테이너**로 이력·증적 조회 | 영속성의 목적 |
| `docker inspect --format '{{.State.Health.Status}}'` → `healthy` | HEALTHCHECK |
| `docker stop` 이 10초 안에 끝나고 graceful shutdown 로그가 남는지 | 신호 전달. 권한 축소 방식을 바꾸면 깨질 수 있습니다 |
| 내장 페이지 5개(`/`, `/playground`, `/runs`, `/demo/test-page`, `/docs`)와 `/ui/*` 자산이 200 인지 | 페이지는 `public/` 에서 읽습니다. 이미지에 디렉터리를 넣지 않으면 `500 UI_TEMPLATE_MISSING` 이 납니다 |
| 렌더된 페이지에 `{{` 가 남아 있지 않은지 | 치환되지 않은 플레이스홀더는 빈 화면이나 깨진 스크립트로 나타납니다 |
| 이미지에 `secrets/` 내용이 들어가지 않았는지 (`ls -A /app/secrets` → 0) | 비밀값이 이미지에 구워지면 이미지를 받은 모든 곳에 유출됩니다 |
| `{{secret.NAME}}` 를 쓰는 실행의 로그에 값이 아니라 `***` 가 남는지 | 스크러빙이 꺼지면 조용히 평문이 저장됩니다 |
| `/health` 의 `version` 이 `package.json` 과 같은지 | v0.13.0 이 `0.12.0` 으로 보고된 적이 있습니다. 이제 `package.json` 에서 읽으므로 버전은 한 곳만 올리면 됩니다 |
| 녹화한 시나리오가 새 페이지에서 `execute` 로 재생되는지 | 재생되지 않는 녹화는 녹화가 아닙니다 |
| 비밀번호 필드가 `{{secret.NAME}}` 로 기록되고 내보낸 스크립트에도 평문이 없는지 | 시나리오는 커밋됩니다 |
| `/playground` 녹화 패널에서 단계가 보이고 지울 수 있는지 | locator 는 사람이 판단할 수 있어야 합니다 |
| `principals.json` 을 준 컨테이너에서 역할·범위가 막히는지 (viewer 가 실행 생성 403, 범위 밖 스크립트 403) | 권한이 적용되지 않으면 적혀 있을 뿐입니다 |
| 승인이 토큰에 귀속되고 `decidedByVerified: true` 로 기록되는지 | 증명할 수 없는 이름이 증명된 것처럼 보이면 이름이 없는 것보다 나쁩니다 |
| MCP `tools/list` 가 역할에 따라 걸러지고 금지된 도구 호출이 `FORBIDDEN` 인지 | 도구 단위 검사가 없으면 `/mcp` 가 권한 우회로가 됩니다 |
| `principals.json` 이 깨졌을 때 서버가 뜨지 않는지 | 아무도 설정하지 않은 권한 모델로 도는 것보다 낫습니다 |
| `/runs` 실패 상세에서 사람이 원인 분석을 요청하고 가설·근거를 읽을 수 있는지 | 사람이 읽을 수 없는 분석은 쓸모가 없습니다 |
| `LLM_BASE_URL` 없이 `analyze` 가 `503 LLM_NOT_CONFIGURED` 인지 | 설정이 비었을 때 조용히 아무것도 안 하면 운영자가 원인을 못 찾습니다 |
| `LLM_BASE_URL` 를 준 컨테이너에서 `capabilities?probe=true` 가 reachable 을 보고하는지 | 환경변수만으로 설정하므로 값이 들어갔는지 확인할 수단이 필요합니다 |
| 형제 모듈을 import 하는 스크립트가 `completed` 로 끝나는지 | 스냅샷이 단일 파일만 복사하던 동안 저장소가 제공하는 스크립트 9개 중 7개가 API 로 실행되지 않았습니다 |
| 반복·분기 워크플로가 `completed` 로 끝나는지 | 컴파일러의 점프 주소가 틀리면 엉뚱한 분기가 돌면서도 성공으로 보고됩니다 |
| 승인 게이트가 `awaiting_approval` 로 멈추고 결정 후 `resume` 이 같은 회차로 이어지는지 | 중단-재개는 컨테이너 안에서 한 번은 확인해야 하는 경로입니다 |
| `/playground` 에서 게이트를 사람이 승인·반려할 수 있는지 | 사람이 쓸 수 없는 승인은 승인이 아닙니다 |
| `--network none` 컨테이너에서 `npm run --silent doctor -- --json` 이 `status: "ok"` 로 끝나는지 | `/health` 만으로는 브라우저·렌더링·PNG 픽셀·파일 저장이 정상인지 알 수 없습니다 |
| MCP `browser_navigate` → `browser_snapshot` → `browser_take_screenshot` 과 기존 `page_screenshot` 이 이미지 바이트를 반환하는지 | 오프라인 MCP 클라이언트는 서버 파일 경로나 인증된 이미지 URL에 직접 접근하지 못할 수 있습니다 |
| 외부 폰트·스크립트가 응답하지 않는 화면에서도 캡처가 끝나고, 명시적으로 폰트를 기다리면 설정한 시간 제한이 적용되는지 | 반입 후 외부 리소스가 끊겼을 때만 드러나는 무한 대기를 방지합니다 |
| MCP 팝업 전환·충돌 후 재생성·진행 중 호출의 `DELETE /mcp` 취소와 동시 세션 상한이 지켜지는지 | 실패한 작업을 중복 실행하거나 종료 중 브라우저가 쌓이면 운영 작업에 영향을 줍니다 |

이미지에 테스트 파일을 포함할 필요는 없습니다. 별도 검증 컨테이너에 `tools/`만 읽기 전용으로 마운트하고 `SMOKE_REQUIRE_BROWSER=1 npm test`를 실행하면 이미지에 담긴 서버·UI·의존성으로 회귀 테스트를 수행할 수 있습니다. 실제 배포 방식의 볼륨 권한·컨테이너 교체 후 복구·HEALTHCHECK·종료 신호 검증도 별도로 수행합니다.

## 4. 패키징

```bash
docker save playwright-player:vX.Y.Z | gzip > playwright-player-vX.Y.Z-docker-image.tar.gz
sha256sum playwright-player-vX.Y.Z-docker-image.tar.gz > playwright-player-vX.Y.Z-docker-image.tar.gz.sha256
```

## 5. 공개

```bash
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
gh release create vX.Y.Z --title "..." --notes-file notes.md
gh release upload vX.Y.Z playwright-player-vX.Y.Z-docker-image.tar.gz{,.sha256}
```

업로드 후 원격 에셋 크기가 로컬과 일치하는지 확인합니다.

## 릴리즈 노트 형식

`## vX.Y.Z Changes` → `| Issue | Root cause | Fix |` 표 → 새 기능 → 새 환경 변수 → `### Upgrade notes`(동작이 바뀐 지점) → `### Docker image`(`docker load` 안내).
