# Ren AI 오픈 준비 — 점검 및 개선 기록

## 기준과 사용법

- 작성일: 2026-10-21.
- 원문: 사용자가 제공한 `ren-ai-preopen-review.md`(원본 위치: `~/Downloads/ren-ai-preopen-review.md`). 원문의 검토 기준은 `577f2cd`이며, 파일 1,159개를 검토했다고 기술한다.
- 이 문서의 초기 코드 확인 기준: `95ff3b387d644c94bbc192fb55fd1ea7ff6772e7`. 아래에 확인 근거를 적은 항목만 부분 확인했으며 전체 재점검을 완료한 것은 아니다.
- 목적: 원문 지적을 빠짐없이 보존하고, 현재 사실 확인과 필요한 결정을 거쳐 처리한다. 기록은 항목별로 유지하고 관련 구현·최종 검증은 승인된 묶음 단위로 진행한다.
- 원문의 P0·분야별 중복은 합쳤다. 독립적으로 완료할 수 있는 문제는 나누고, 각 카드에 원문 번호를 남겼다.
- **원문 지적과 제안은 확정된 사실이나 승인된 요구사항이 아니다.** 플랫폼 한도, 토큰·비용 추산, 법적 요건, 배포 상태는 각각 현재 근거로 확인한다. 라이브 상태를 저장소 코드만 보고 단정하지 않는다.
- 카드의 `위치`는 원문이 지목한 경로·심볼이다. 현재 경로를 확인한 경우에만 전체 경로로 갱신했다. 옛 경로는 착수 시 다시 찾는다.
- 제품 용어는 [CONTEXT.md](../../CONTEXT.md), 구현 원칙은 [AGENTS.md](../../AGENTS.md)를 따른다. 정책을 바꿔야 하는 항목은 먼저 결정을 기록하고 관련 명세를 함께 수정한다.

### 상태와 완료 규칙

- `미검증`: 원문 주장이 현재도 성립하는지 확인 전.
- `부분 확인`: 일부 코드·명세 근거를 확인했지만 영향·해결 범위·동작 검증이 남음.
- `결정 필요`: 기존 정책과 충돌하거나 제품·운영자의 선택이 필요함.
- `진행 중`: 현재 승인된 묶음에서 처리하는 항목. 실행 순서와 결과는 개별 카드에 기록한다.
- `검증 대기`: 구현 또는 기존 해결책을 찾았고 완료 조건 확인이 남음.
- `완료`: 필요한 수정과 검증, 해당하는 배포·운영 확인까지 결과를 기록함.
- `변경 불필요`: 현재 동작이 요구사항을 만족하거나 원문이 성립하지 않음을 근거로 확인함.

착수 시 카드에 검증 커밋, 현재 경로, 재현 결과, 선행 항목을 보강한다. 개발 중에는 관련 검사만 실행하고 묶음의 최종 검토 후 전체 CI를 한 번 실행한다. 결정 대기 항목은 명시적으로 보류하고 나머지 작업을 계속한다.

코드 변경에는 영향에 맞는 검증과 저장소 필수 게이트를 적용한다. 먼저 `.nvmrc`의 Node를 활성화하고 버전을 확인한다. 구현·최종 검토 후 `bun run ci`를 한 번 실행하며, coverage와 `verify-gates`는 같은 checkout에서 직렬 실행한다. 코드 통과와 배포 확인은 구분하고, 배포가 필요한 항목은 운영 검증 전까지 완료로 표시하지 않는다.

## 실행 현황

- 현재 단계: **R03·R08·R10·R11·R06·R02 구현·코드 검증 완료, 배포·운영 확인 대기**. 사용자 승인에 따라 중간 승인 없이 연속 처리했다. 아래 항목은 배포·운영 확인 전까지 검증 대기로 둔다.
- 실행 순서: 수신·재연결·조회 경로 → alarm 예산·영속 재개 → 메시징 헬스 → 공개 Catalog 장애 대응. 전체 CI는 묶음 종료 시 한 번 실행한다.
- 기존 배포 대기: R09 구현·코드 검증 완료. 배포 후 운영 검증은 미실행이다.
- 종결 항목: **R01 — 설정값 변경 불필요**. 운영·테스트의 서로 다른 모델 예산을 혼동한 지적으로 판정하고 주석·운영 문서를 보강했다.
- 오픈 판단: 미확정. 아래 오픈 전 검토 대상의 차단 여부를 확인하고, 미해결 항목의 처리 또는 명시적 보류 결정을 기록한다.

### 이번 묶음의 최종 검사

- 2026-10-22 / `00a4f8f53b64dbdcab912f24443cbf90da9d2458` 기반 작업 트리에서 최종 검토 후 `bun run ci`를 한 번 실행해 전체 통과했다. 코드 변경은 아직 커밋·배포하지 않았다.
- Node v24.15.0·Bun 1.4.2: 포맷, lint, 17개 workspace 및 루트 타입, dead code, duplication 0, 예외 검사, Discovery production build, **340개 파일·1,568개 테스트·파일별 lines/functions/branches/statements 100%**, `verify-gates` 통과.
- Rust 1.95의 Cargo PATH와 checkout 전용 `CARGO_TARGET_DIR`·`CARGO_BUILD_BUILD_DIR`를 사용했다. native 크기·복잡도·coverage 자체 검증, rustfmt, clippy, Rust **44개 단위 + 2개 CLI 테스트**, 기존 예외를 적용한 coverage 검사를 통과했다. 미해결 검사 실패 없음.
- 여섯 카드의 운영 완료 조건은 미실행이다. API·Discovery·api-msg·Messages Mac의 실제 artifact revision과 해당 장애·부하 경계를 확인한 뒤 상태를 종결한다.

### 처리 순서

1. **R01**: 설정·테스트 불일치와 OpenCode의 실제 compaction 의미 확인.
2. **R09 → R03**: 원격 호출의 시간 예산을 확인한 뒤 alarm 전체의 작업 예산·재개 동작 검증.
3. **R07 → R06 → R02 → R05**: 불명확한 전송 결과 복구, 메시징 헬스, Catalog 장애 대응, 등록 제한.
4. **R36 → R37 → R38 → R24**: 연령·고지 정합성과 번호 소유 확인. 필요한 제품·운영 결정을 함께 기록.
5. **R04**의 알림 정책·관측을 확인하고, 나머지 항목은 영향과 선행 관계에 따라 다음 대상으로 지정.

원문 로드맵은 다음과 같이 보존한다. 이는 최초 분류이며 확정된 출시 기준이 아니다.

- 오픈 전: R01–R07, R24, R36–R37.
- 첫 100명: R14–R15, R21–R22, R25–R26, R28, R32.
- 그 다음: R12, R30–R31, R39–R45.
- 시점 미지정: R08–R11, R13, R16–R20, R23, R27, R29, R33–R35, R38.

### 선행 결정·기존 요구사항

- **R04**: [Notification 명세](notifications.md)는 시간당 30건 초과분을 건너뛰고 Admin에 결과를 표시하도록 한다. 상한 인상·지연 큐·재발송은 정책 변경이다.
- **R21**: [이미지 제작 최신 흐름](persona-discovery-admin.md#사진별-프롬프트공통-순차-큐보이는-생성-과정)과 AGENTS.md는 전역 Durable Object FIFO, 한 번에 이미지 하나, 중단된 유료 호출의 운영자 확인 재시도를 요구한다. 병렬화를 기본 해결책으로 채택하지 않는다.
- **R23**: 현재 이미지 명세는 초안·미참조 객체도 직접 URL로 접근 가능하다고 명시한다. 접근 회수 요구를 결정하고 캐시·공유 이미지 경로까지 함께 설계해야 한다.
- **R24·R27**: 번호 소유 확인과 재등록 정보 변경은 기존 Onboarding 계약의 변경이다. 가입 여부 노출과 데이터 변경 권한을 함께 다룬다.
- **R32·R35**: 무응답이 항상 실패인지, Relationship ending 후 어떤 기록을 보관할지는 현재 Conversation·Memory 규칙과 대조한다.
- **R42**: API·클라이언트·자체 업데이트하는 Messages Mac 사이의 배포 계약을 유지한다. 번들 게시 성공과 실제 설치·터널 준비 완료는 서로 다른 확인이다.

## 작업 카드

### R01. compaction 설정과 테스트 불일치

- 원문: P0-7, M1. 상태: **변경 불필요**. 선행: 없음.
- 지적·위치: `apps/api/src/operations/location-config.ts`는 `buffer: 400_000`, `apps/api/test/host.test-helper.ts`는 `40000`을 기대한다. 두 값의 불일치를 현재 코드에서 확인했다.
- 확인 결과: OpenCode 2.0.19의 `SessionCompaction.Settings`는 buffer를 남겨 둘 토큰으로 정의하고, 구현의 `calculateCeiling`은 `(limit.input || limit.context) - buffer`, `due`는 추정 사용량이 그 기준 이상인지 검사한다. 1M 한도·400k buffer는 600k 기준이며 40k로 낮추면 960k까지 늦어진다. 128k–200k 한도에 400k를 쓰면 음수 기준이 돼 너무 일찍 compaction을 시도한다. 원문의 “작은 모델에서 compaction이 돌지 않는다”는 설명은 반대다.
- 설정 경로: `apps/api/ops/location-config.ts`가 운영 JSON을 생성하고 runbook에 따라 `/srv/ren-ai/opencode.json`에 설치한다. OpenCode의 `opencode.config.compaction` 플러그인이 해당 설정을 적용한다. 반면 `apps/api/test/embedded-host.test-helper.ts`는 별도 100k context·60k budget에서 buffer 40k를 계산하고, `host.test-helper.ts`는 그 테스트 host의 응답을 검증한다. 운영 generator의 직접 테스트 `apps/api/src/operations/location-config.test.ts`는 400k를 기대한다.
- 방향·완료 조건: 오타 수정과 운영·테스트 buffer 통일은 불필요하다. 기존 설정 생성·실제 host·자동 compaction 테스트를 실행하고 설정 주석·runbook에 의미와 모델 변경 시 재검토 조건을 명시한다. 운영 600k 예산 축소 여부는 사용량·비용 측정과 함께 R30·R34에서 판단한다.
- 결과·검증·배포: `6d209f8153193d39061277e1efacc046de8554a3`에서 검증했다. 40k 일치 assertion은 실패했으나 서로 다른 설정 경로를 같다고 가정한 재현임을 확인했다. 설정값 변경 없이 주석·runbook을 보강했다. Node v24.15.0에서 아래 4개 파일·8개 테스트가 통과했다. 운영 동작을 변경하지 않아 배포는 필요하지 않으며, 운영 인스턴스의 설치값·모델 한도를 검증한 것으로 해석하지 않는다.
- 검증 명령: `bun x vitest run apps/api/src/operations/location-config.test.ts apps/api/src/opencode/host.test.ts apps/api/src/opencode/memory.test.ts apps/api/src/opencode/conversation-memory.test.ts --maxWorkers=2`.
- 필수 검사: `bun run ci`에서 정적 검사·Discovery 빌드·1,525개 테스트(333개 파일)·파일별 커버리지 100%·`verify-gates` 통과. native 단계는 PATH의 Homebrew rustc 1.94가 저장소 지정 1.95보다 먼저 실행돼 `atomic_try_update` E0658로 실패했다. `export PATH="$HOME/.cargo/bin:$PATH"` 후 `bun run ci:native`만 재실행해 clippy·Rust 테스트 46개·coverage 검사를 통과했다. 미해결 검사 실패 없음.

### R02. 공개 Catalog의 캐시와 장애 대응

- 원문: P0-1, A1. 상태: **검증 대기**. 선행: 공개 중단·삭제 반영 정책 확인.
- 지적·위치: `apps/api/src/personas/catalog.ts`의 `publicList`가 `/api/personas`를 요청하는 것은 확인했다. 전체 경로의 무캐시·방문당 비용·오류 표시 주장은 추가 확인이 필요하다. 관련 위치: `apps/discovery/src/client.ts`, `apps/api/src/discovery/discovery.ts`.
- 방향: 마지막 정상 공개 스냅샷, 원문의 TTL 60초·stale 300초·HTTP 캐시 제안을 검토한다. private Catalog를 공개 캐시에 넣지 않고, 등록 시 후보 검증과 비공개·은퇴 반영을 분리한다.
- 완료 조건: Admin 장애·느린 응답·동시 만료 때 탐색 응답과 재검증 횟수가 예측 가능하다. 허용 stale 기간, 삭제 반영, 초기 스냅샷 부재, 오류 HTTP 상태를 검증한다.
- 확인·구현: 공개 탐색은 요청마다 Admin을 읽었고 클라이언트도 `no-store`였다. `apps/api/src/personas/public-catalog.ts`에 공개 Schema만 저장하는 SQLite singleton 캐시를 추가했다. fresh 60초, upstream 실패 때만 최대 추가 300초 stale, 실패 재확인 10초, semaphore로 동시 갱신을 합친다. 정상 GET은 `Age`와 `public, max-age=60, stale-while-revalidate=300`, 오류는 no-store·HTTP 503이다. 등록·Selection은 fresh source를 재확인한다.
- 무효화·검증: Admin 갱신이 snapshot을 지우고 generation fence로 진행 중 요청의 이전 데이터 재저장을 막는다. 브라우저·CDN에 이미 저장된 응답은 HTTP freshness 기간까지 남을 수 있다. 동시 20회, actor 교체, warm read 무쓰기, 만료·초기 장애·잘못된 snapshot·갱신 경합·공개 필드 allowlist·실제 endpoint 503·fresh 후보 검증 테스트를 통과했다. 상태 archive에서는 재구축 가능한 공개 캐시를 제외하며 Node export의 JSON import 속성도 보강했다.
- 배포 완료 조건: API·Discovery·Admin 갱신 경로의 실제 revision을 확인하고, Admin 응답 중단 시 fresh/stale/503 전환·공개 중단 반영·등록 거절을 운영 경계에서 확인한다. 실제 배포는 미실행.

### R03. alarm 작업 예산과 중단 후 재개

- 원문: P0-2, A2. 상태: **검증 대기**. 선행: R09.
- 지적·위치: `apps/api/src/execution-runtime.ts`에 intake·첫 Greeting·사용량·Notification 등 작업이 모인다. 원문 추산은 intake 100건·4 Handle 병렬·개별 30초, usage 20세션·개별 30초, Notification 30건·개별 45초다.
- 방향: 현재 작업별 상한과 Cloudflare CPU·벽시계 한도를 확인하고 전체 예산·저장된 재개 지점을 둔다. 5건 단위와 Queues 이관은 원문 제안이며 필요성 검증 후 선택한다.
- 완료 조건: 버스트·느린 의존성·강제 중단·actor 교체에서도 다른 종류의 작업이 굶지 않고, 처리 진척이 영속되며 재개된다. 실제 SQL 경계에서 읽기·쓰기 비용도 제한된다.
- 플랫폼 근거: 2026-10-22 [Cloudflare DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)를 확인했다. 기본 active CPU 30초와 alarm wall time 15분은 다르며 네트워크 대기를 CPU 시간으로 계산하지 않는다. 배포 설정의 CPU 증가는 채택하지 않았다.
- 구현: `work-budget.ts`가 45초 또는 40 admissions 후 새 작업을 멈추고 1초 뒤 영속 재개를 예약한다. 이는 실행 중 mutation을 취소하는 hard timeout이 아니다. 기존 개별 deadline과 함께 사용한다. alarm·execution lane cursor를 I/O 전에 저장하고 lane별 30초–5분 backoff로 장애를 격리한다. SQL batch는 alarm에서 5개, 실패 복구는 개별 session 검사·quota 해제 후 재개도 영속한다. 실패한 startup은 부분 자원을 닫고 같은 actor에서 다시 연다.
- 저장 경계: Intake는 indexed Handle head로 먼저 제한하고 실패한 head 한 행만 갱신한다. replay는 cursor·간격·reply/send 진척을, Catalog는 fingerprint·bound/native/apply 단계와 native cursor/offset을 저장한다. Catalog는 모든 managed session 검증 후 적용한다. first contact·usage·rebuild·follow-up 초기화도 제한하며 정상 lane은 다음 cursor에서 계속한다. alarm의 다음 기한은 indexed MIN·고정 lane 조회로 계산한다. quota 해제의 SQL 재분류는 해당 cap에 속한 행 수에 비례하는 일회성 transaction이며 원격 재개는 batch로 나눈다.
- 검증: 느린 lane의 안전한 완료와 actor 교체, lane/session 장애 격리, 취소·generation 경합·quota 재발, 5,000행 실패 prefix 이후 다른 Handle 진행과 작은 write 수, 10,000개 turn 예약·query plan, 1,000개 Conversation의 복구 공정성, replay/Catalog 중단 후 재개, 실제 compiled SQLite DO의 sent/uncertain 첫 Greeting 재시작 시나리오를 확인했다. 테스트에서 발견한 quota 재발 관측 지연과 rejected startup Promise 고착도 수정했다.
- 배포 완료 조건: 정확한 Worker·Mac revision 반영 후 버스트·느린 executor·actor 교체의 실제 alarm duration·subrequest·storage rows read/written과 진척을 확인한다. admission 45초가 alarm 총 실행 45초를 보장한다고 해석하지 않는다. 실제 배포·부하 측정은 미실행.

### R04. Waitlist Notification 상한과 운영 가시성

- 원문: P0-3. 상태: **결정 필요**. 선행: Notification 정책 유지·변경 결정.
- 지적·위치: 원문은 시간당 30건 초과분이 조용히 `skipped` 된다고 지적한다. `docs/specs/notifications.md`는 초과분을 이월하지 않고 Admin에 skipped·failed·uncertain을 표시하도록 명시한다. 실제 표시·운영 알림은 미검증이다.
- 방향: 명세와 구현을 먼저 대조한다. 무조건 상한을 올리거나 재전송하지 않고, 기존 가시성 결함과 정책 변경을 분리한다.
- 완료 조건: 한도 전후·실패·uncertain 결과를 운영자가 식별하고, 공개 접수 화면은 전송 성공을 보장하지 않는다. 정책 변경 시 예산·재시도·동의 문구를 함께 검증한다.
- 결과·검증·배포: 미착수.

### R05. Turnstile과 등록 제한의 순서·전역 상한

- 원문: P0-4. 상태: **부분 확인**. 선행: R38과 데이터 처리 정책 정합성.
- 지적·위치: `apps/api/src/discovery/rate-limit.ts`의 IP당 5회·1시간, 전체 10,000개 IP 제한과 SQLite 저장을 확인했다. `apps/api/src/discovery/discovery.ts`의 Turnstile 이전 차감 경로는 착수 시 재확인한다.
- 방향: 검증 실패 요청이 정상 사용자의 등록 예산을 고갈시키는지 재현한다. Turnstile 이후 차감과 실패율 기준은 원문 제안이며 검증 호출 자체의 남용 방지도 함께 검토한다.
- 완료 조건: 검증 실패·IPv6 다수 주소·동일 IP 동시 요청·만료 후 재시도에서 정상 등록과 자원 상한이 유지되고, 전체 방문자를 장시간 차단하는 경로가 통제된다.
- 결과·검증·배포: 미착수.

### R06. Mac·게이트웨이·APNs 헬스 감지와 복구

- 원문: P0-5, G1. 상태: **검증 대기**. 선행: 실제 health 구성·경로 확인.
- 지적·위치: 원문은 `apps/imsg/src/gateway/runtime.ts`, `apps/api/src/execution-health.ts`, `apps/api-msg/src/health.ts`가 게이트웨이·APNs 장애를 관측하지 못한다고 지적한다.
- 방향: imsg 직접 probe, 2회 실패 시 `messaging-unavailable`, 5분 이내 감지를 후보 기준으로 검증한다. 재시작 가능한 장애와 Apple Account 재로그인이 필요한 장애를 구분한다.
- 완료 조건: 잠자기·브리지 중단·APNs 단절·인증 상실을 실제 경계에서 감지하고 상관 ID가 있는 운영 알림·복구 결과를 확인한다. 서비스·artifact revision·필수 의존성 준비 상태가 구분된다.
- 확인·구현: 기존 native `handles` RPC는 이미 APNs ping/pong·등록 readiness를 검사했다. 새 Apple probe를 만들지 않고 Worker에서 기존 imsg probe를 직접 사용한다. 정상 120초·실패 20초 재확인, 2회 연속 실패 시 durable `messaging-unavailable`, 정상 복구 시 clear하며 다음 기한과 실패 횟수는 actor 교체 후 유지한다. 공개 health는 DB·executor·messaging을 구분하고 메시징 자체를 5초 제한으로 검사한다.
- 진단·검증: Mac probe는 server-generated requestId로 원인·코드를 안전하게 기록한다. API health의 requestId와 Mac operationId를 연결하며 Handle·Apple 오류 본문은 제외한다. 실제 RPC 경계의 APNs 실패·HTTP 503·민감 정보 제외·별도 의존성 상태, 지속 실패·교체·알림 dedup·복구를 테스트했다. bootstrap-only health도 메시징 장애를 숨기지 않는다.
- 배포 완료 조건: Worker 및 Mac의 정확한 artifact revision을 확인하고 잠자기·브리지 중단·APNs 단절·등록 상실 후 감지 시간과 복구/alert clear를 실제 장비에서 확인한다. 자동 재발송·임의 Apple Account 재로그인·재시작은 추가하지 않았다. 운영 절차는 `apps/api/ops/README.md`에 기록했다. 실제 장애 주입·배포는 미실행.

### R07. uncertain 전송의 정산·경고·운영자 복구

- 원문: P0-6, G2. 상태: **미검증**. 선행: Mac 전송 영수증·status 계약 확인.
- 지적·위치: 원문의 `outbox.ts`, `rustpush.ts`, `gateway/rpc.rs`는 uncertain이 이후 전송을 막고 identified attempt는 운영자도 해제할 수 없다고 한다. 현재 outbox 위치는 `apps/api/src/outbox/outbox.ts`다.
- 방향: 확실한 미전송과 제출 여부 불명을 구분하고 native SendResult·GUID 정산 근거를 보존한다. 오래된 uncertain 경고와 운영자 해결 경로를 검토하되, timeout·disconnect만으로 failed 처리하거나 자동 재전송하지 않는다.
- 완료 조건: 제출 전 실패·제출 후 응답 유실·늦은 receipt·Mac 재시작·운영자 정산에서 중복 전송 없이 대화가 복구된다. Assignment·지속 dedup·감사 기록이 유지된다.
- 결과·검증·배포: 미착수.

### R08. intake의 1초 wake 폴링

- 원문: A3. 상태: **검증 대기**. 선행: R03의 예산과 조율.
- 지적·위치: `intake/intake.ts`가 긴 처리 중 `messages.after`를 초당 호출해 최대 900회에 이른다는 주장이다.
- 방향: 현재 wake·follow 계약과 subrequest 한도를 확인하고 지수 backoff 또는 이벤트 기반 wake 중 최소 변경을 선택한다.
- 완료 조건: 느린 처리 중 호출 수가 제한되고, 새 메시지 감지 지연·중복·재시작 후 누락을 검증한다.
- 결과·검증: `apps/api/src/intake/intake.ts`의 처리 대기 중 관측 간격을 1·2·4·8·16·30초(최대)로 늘리고 bookmark 진척 시 1초로 초기화했다. 정상 follow/wake 경로는 유지한다. TestClock으로 느린 처리 중 호출 횟수, 30초 상한, 새 수신 후 간격 복귀 및 영속 queue의 중복 방지·재시작 복구를 확인했다.
- 운영 완료 조건: Worker 반영 후 느린 첨부·executor 상황에서 관측 호출 수와 새 메시지 지연(대기 중 관측은 최대 30초)을 확인한다. 전체 alarm 상한은 R03과 함께 확인한다. 배포 미실행.

### R09. Mac·OpenCode 원격 호출의 timeout과 취소

- 원문: A4. 상태: **검증 대기**. 선행: 호출 목록·읽기와 mutation 구분.
- 지적·위치: `opencode/remote.ts`, `failed-turns.ts`의 원격 호출에 timeout이 없어 alarm을 붙잡는다는 주장이다. Catalog에는 10초 timeout이 있다는 대조 근거가 있다.
- 확인 결과: `remoteHost`의 공통 OpenCode HTTP 클라이언트와 `remote.client` 직접 조회·session-folder RPC에 deadline이 없었다. 기존 intake·usage·Notification의 일부 상위 제한만으로는 failed-turn 조회 등 모든 호출을 보호하지 못했다. Executor health에는 fetch timeout이 있었지만 호출자 취소와 분리돼 있었고 Discord 알림 전달에는 제한이 없었다.
- 구현: OpenCode 2.0.19가 전달하는 HttpApiClient decoder transform과 Effect HttpClient의 응답 처리를 사용해 헤더 30초·유한 본문 decode 30초로 제한했다(느린 두 단계 합계 최대 약 60초). `session.wait`는 무본문 HTTP 응답의 헤더 대기 30초를 적용한다. `apps/imsg/src/gateway/client.ts`는 유한 RPC 전체에 30초를 적용한다. 기존의 더 짧은 제한은 유지하며, 확립된 OpenCode event·Messages follow 스트림의 수명은 일괄 timeout 대상에서 제외한다.
- 취소·정산: Effect interruption을 실제 fetch AbortSignal에 전달하고 원래 cause를 보존한다. 헬스·알림은 10초 deadline과 호출자 취소를 연결하고 불필요한 webhook 본문을 취소한다. 전송 deadline은 미전송 확정이나 재시도 허가가 아니며 기존 uncertain·Assignment·dedup·상태 조회 경로를 유지한다.
- 완료 조건: 응답 없는 원격 호출이 예산 안에 종료되고 자원이 해제된다. 취소 시 상태 정산과 원인·단계 진단을 검증한다.
- 결과·검증·배포: `00a4f8f53b64dbdcab912f24443cbf90da9d2458`에서 검증했다. TestClock으로 헤더·본문이 멈춘 실제 SDK 호출이 61초 뒤에도 살아 있는 실패를 재현한 후 수정했다. 관련 23개 파일·108개 테스트, API·imsg 타입 검사, 중복 검사, 최종 검토를 통과했다. 배포 후 운영 검증은 미실행이므로 상태는 검증 대기다.
- 검증 범위: session 조회·직접 history 조회·folder RPC·HTTP wait의 제한 및 abort, 2분 이상 idle 스트림 유지·scope 종료, 실제 발신 RPC 경계의 uncertain 저장·재전송 차단·request/operation ID·TimeoutError 진단 1회·민감 정보 제외, 헬스·알림 동시 장애 후 tick 종료를 확인했다.
- 필수 검사: Node v24.15.0·Rust 1.95 환경에서 `bun run ci`의 정적 검사·Discovery 빌드·1,538개 테스트(335개 파일)·파일별 커버리지 100%·`verify-gates`를 통과했다. native coverage 단계는 공유 빌드 캐시에 다른 checkout의 rustls 산출물이 섞여 E0277로 실패했다. 새로운 임시 `CARGO_TARGET_DIR`·`CARGO_BUILD_BUILD_DIR`로 `bun run ci:native`만 재실행해 clippy·Rust 테스트 46개·coverage 검사를 통과했다. 미해결 검사 실패 없음.
- 운영 완료 조건: API Worker 반영 후 정확한 artifact revision·readiness와 원격 응답 중단 시 alarm 재개·발신 정산을 확인한다. 공유 Messages 클라이언트의 Mac 소비자는 자체 업데이트 후 해당 artifact를 확인한다. 전체 alarm 예산·공정성은 R03에서 별도로 처리한다.

### R10. api-msg 연결 복구 backoff 초기화

- 원문: A5. 상태: **검증 대기**. 선행: 현재 watch 구현 찾기.
- 지적·위치: 원문의 `api-msg/watch.ts`는 reconnect attempts가 평생 누적돼 이후 모든 복구가 300초 대기한다고 한다.
- 방향: 성공 연결·안정 연결의 기준과 backoff 변수를 확인하고 적절한 시점에 초기화한다.
- 완료 조건: 여러 번 끊긴 뒤 정상 연결을 거친 다음 장애의 복구 지연이 초기 정책으로 돌아오며, 즉시 재단절 loop도 제어된다.
- 결과·검증: `apps/api-msg/src/watch.ts`는 재연결 attempts를 성공 연결 후 초기화하지 않았다. watch snapshot 검증과 follow 구독 준비가 완료된 시점에 0으로 돌린다. 실패 시 기존 지수 backoff는 유지하며, 반복 실패→연결 성공→다음 단절의 지연이 초기값으로 돌아가는 회귀 테스트를 추가했다. 미완료·잘못된 watch snapshot도 기존 복구 경로로 처리한다.
- 운영 완료 조건: api-msg 자체 업데이트의 정확한 revision을 확인하고 실제 Mac 스트림 단절·복구 후 다음 장애의 재연결 간격을 확인한다. 배포 미실행.

### R11. 메시지 전체 히스토리 스캔

- 원문: A6. 상태: **검증 대기**. 선행: 현재 intake·outbox 조회 경계 확인.
- 지적·위치: 원문 `outbox.ts`, `intake.ts`의 `messages.after(0)`·LIMIT -1이 Tapback 등에서 전체 이력을 읽는다는 주장이다.
- 방향: 정상 경로·최초 bootstrap·예외 복구를 나눠 커서·GUID 조회·SQL limit을 검토한다. [처리량 검증 기록](imessage-throughput-verification.md)의 기존 개선도 현재 구현과 대조한다.
- 완료 조건: 커진 실제 저장 경계에서 idle·신규 수신·Tapback·uncertain 복구의 조회량을 측정하고, 인덱스·query plan·교체 후 재개·중복 방지를 검증한다.
- 결과·구현: Tapback은 Handle별 최신 1건, 인용·reset boundary는 GUID 제한 1건, replay는 Handle별 row cursor·100행 page를 사용한다. Mac follow의 저장 backlog도 100행씩 읽는다. `recent` RPC에 optional guid/after/limit/reverse를 추가하고 실제 SQLite WHERE/ORDER/LIMIT와 기존 인덱스를 사용한다. 아직 업데이트되지 않은 Mac의 응답도 클라이언트에서 필터·정렬·제한해 점진 배포 계약을 유지한다.
- 범위·검증: 10,000행 실제 SQLite의 query plan·결과 제한, 구 Mac 응답·GUID·역순·100행 초과 follow·replay checkpoint·중복 방지 및 실제 Tapback 권한/차단 race를 검증했다. 최초 bookmark가 없는 bootstrap의 tail 확정은 여전히 기존 전체 이력을 읽는 일회성 경로이며, 기존 bookmark 이후 시작은 101행으로 제한한다. uncertain 정산은 send identity/status 계약을 그대로 사용한다.
- 운영 완료 조건: Messages Mac 자체 업데이트 후 제한이 실제 SQL에 적용되는 revision을 확인하고 커진 이력에서 Tapback·인용·reset·replay·follow의 읽기량과 재개를 측정한다. 배포 미실행.

### R12. 관리 자격증명의 권한 분리

- 원문: A7. 상태: **미검증**. 선행: 호출 주체와 배포 secret 목록 확인.
- 지적·위치: `cloudflare-config.ts`의 `TOKEN_MANAGEMENT` 하나가 callback·플러그인·Admin 갱신·api-msg에 공유돼 침해 범위가 크다는 주장이다.
- 방향: 실제 권한을 열거하고 역할별 자격증명과 경로별 인가를 설계한다. 토큰 개수 3개 자체를 완료 기준으로 삼지 않는다.
- 완료 조건: 각 호출 주체는 필요한 작업만 가능하고, 잘못된 역할의 호출은 거부된다. 배포·교체 절차와 로그의 비밀 제외를 검증한다.
- 결과·검증·배포: 미착수.

### R13. ack 불가 gateway 이벤트의 후속 처리 차단

- 원문: G3. 상태: **미검증**. 선행: spool의 persistence-before-ack·순서 계약 확인.
- 지적·위치: `gateway/rpc.rs`의 30초 재시도와 직렬 spool 처리가 디스크 부족·잘못된 이벤트 하나로 전체 수신을 막는다는 주장이다.
- 방향: 영속 격리·dead-letter·재시도 예산을 검토한다. 병렬 처리는 이벤트 순서·dedup·복구 보장이 확인되는 범위에서만 결정한다.
- 완료 조건: poison 이벤트와 저장 실패를 구분하고, 복구 가능한 원본을 보존하며 다른 Handle이 진행한다. 재시작·재처리 때 누락·중복이 없다.
- 결과·검증·배포: 미착수.

### R14. 첨부 다운로드·인코딩·보관 상한

- 원문: G4. 상태: **미검증**. 선행: 첨부 lifecycle과 모델 입력 계약 확인.
- 지적·위치: `gateway/rpc.rs`, `images.ts`의 무제한 다운로드·전체 base64·HEIC 한정 resize·원본 누적으로 30MB JPEG가 약 40MB data URI가 된다는 주장이다.
- 방향: 다운로드 단계의 byte·시간 상한, MIME별 처리, 실패·성공 후 정리를 검토한다. 업로드 참조로 대체 가능한지는 제공자 API에서 확인한다.
- 완료 조건: 큰 JPEG·HEIC·위조 MIME·중단 다운로드에서 메모리·디스크·턴 입력이 제한되고 사용자 데이터 및 필요한 재처리 자료의 수명도 명확하다.
- 결과·검증·배포: 미착수.

### R15. Service handle 전역 발신 pacing과 동시 실행 상한

- 원문: G5. 상태: **미검증**. 선행: R07, transport의 현재 전역 직렬화 확인.
- 지적·위치: `outbox.ts`, `gateway/rpc.rs`가 대화별 직렬화만 보장하고 요청 태스크는 무제한 생성해 첫 Greeting 버스트가 Apple Account에 집중된다는 주장이다.
- 방향: 현재 전송 경로의 계정 단위 pacing·대기열 상한을 확인한다. 2–3초 간격·jitter는 원문 제안이며 계정 차단 위험·안전한 처리량의 입증으로 취급하지 않는다.
- 완료 조건: 여러 Conversation·Notification의 동시 발신에서 실제 간격·in-flight·대기 시간이 제한되고, 재시작 후 dedup·공정성·uncertain 처리가 유지된다.
- 결과·검증·배포: 미착수.

### R16. Mac 잠자기·재부팅 후 복구

- 원문: G6. 상태: **미검증**. 선행: GUI 로그인·Keychain·실제 transport 요구 확인.
- 지적·위치: `apps/imsg/ops/install.sh`의 RunAtLoad·KeepAlive만으로 잠자기와 GUI 로그인 전 복구를 보장하지 못한다는 주장이다.
- 방향: 현재 전원 설정·LaunchAgent 의존을 확인하고 pmset·caffeinate 또는 명시적인 재로그인 복구 절차를 선택한다.
- 완료 조건: idle·화면 잠금·재부팅 후 필요한 사용자 동작과 자동 복구 범위를 실제 Mac에서 확인하고 R06 감지·runbook에 반영한다.
- 결과·검증·배포: 미착수.

### R17. Apple 자격증명 저장 보호

- 원문: G7. 상태: **미검증**. 선행: R16의 실행 사용자·로그인 요구.
- 지적·위치: `apple-session.rs`의 `NoEncryptor`와 umask 의존으로 Apple 자격증명이 평문 저장된다는 주장이다.
- 방향: 실제 저장 내용·파일 권한·Keychain 사용 가능성을 확인하고 암호화 및 백업 제외 범위를 정한다.
- 완료 조건: 비인가 로컬 읽기와 백업에 비밀이 노출되지 않으며, 허용된 실행 환경의 재시작·갱신·실패 진단에 비밀이 남지 않는다.
- 결과·검증·배포: 미착수.

### R18. 그룹 메시지의 처리·지원 범위

- 원문: G8(그룹챗). 상태: **미검증**. 선행: 1:1 Conversation 제품 범위 확인.
- 지적·위치: `history.ts`가 그룹 메시지를 조용히 무시한다는 주장이다.
- 방향: 1:1 전용 설계상 제외인지 결함인지 확인한다. 그룹 지원 추가를 기본 해결책으로 삼지 않고 필요한 운영 진단·사용자 안내를 결정한다.
- 완료 조건: 그룹 메시지가 1:1 Conversation에 유입되지 않고, 지원 범위와 제외 동작이 문서·검증에 명시된다.
- 결과·검증·배포: 미착수.

### R19. Mac 로그 로테이션 연결

- 원문: G8(로그 로테이션). 상태: **미검증**. 선행: 실제 서비스 plist·로그 sink 확인.
- 지적·위치: 원문은 로테이션 스크립트는 있으나 plist에 연결되지 않았다고 한다.
- 방향: 실행 주체·주기·파일 크기·보관량을 확인하고 실제 운영 경로에 연결한다.
- 완료 조건: 연속 로그와 서비스 재시작 중에도 파일이 회전하고 디스크 사용량·보관 기간이 제한된다. 운영 진단과 민감 정보 제외가 유지된다.
- 결과·검증·배포: 미착수.

### R20. OpenCode 세션 저장소 증가

- 원문: G8(세션 저장소). 상태: **미검증**. 선행: R35·R39의 보관·복구 정책.
- 지적·위치: 원문은 OpenCode 세션 저장소가 상한 없이 증가한다고 한다.
- 방향: 실제 크기·증가 원인·사용 중 세션을 측정하고 보관·정리 단위를 결정한다.
- 완료 조건: 활성 세션을 손상하지 않는 정리·용량 감시가 있고, 오래된 세션·첨부가 정책에 따라 처리되며 복구 자료와 일치한다.
- 결과·검증·배포: 미착수.

### R21. 이미지 FIFO의 중단 복구·중복 비용·고아 객체

- 원문: D1. 상태: **결정 필요**. 선행: 현재 영속 queue·provider 결과 저장 경계 확인.
- 지적·위치: `image-queue.ts`, `generation.ts`의 전역 1레인 대기, 120초 timeout 후 중복 과금, actor 교체 시 실패와 R2 고아 객체를 지적한다. 전역 FIFO 자체는 AGENTS.md와 최신 이미지 명세의 요구사항이다.
- 방향: FIFO를 유지한 채 실제 유료 호출·완료 결과·private draft·제출 dedup의 영속성을 확인한다. jobId 기반 키·존재 확인은 provider 호출 유무를 확정할 수 있는지 검토한다.
- 완료 조건: 저장 단계별 중단·actor 교체·같은 제출 재시도에서 완료 사진을 보존하고 유료 호출을 자동 반복하지 않는다. 불명확한 호출은 개별 확인 재시도만 가능하고 고아 객체 처리 기준이 있다.
- 결과·검증·배포: 미착수.

### R22. Admin 접근 인증과 운영자 식별

- 원문: D2. 상태: **미검증**. 선행: 실제 Cloudflare Access·공개 ingress 확인.
- 지적·위치: `apps/admin/src/admin.ts`의 공유 `ADMIN_PASSWORD` Basic 인증에 MFA·rate limit·운영자별 감사가 없다는 주장이다.
- 방향: 저장소와 배포 설정을 대조하고 Access 적용 여부·우회 경로·서비스 간 인증을 확인한다. 필요한 인증·운영자 식별 정책을 결정한다.
- 완료 조건: 보호할 화면·API·직접 origin 경로의 인가가 검증되고, 허용된 운영자만 접근하며 주요 변경의 주체를 확인할 수 있다.
- 결과·검증·배포: 미착수.

### R23. 초안·삭제 이미지 URL과 접근 회수

- 원문: D3. 상태: **결정 필요**. 선행: 이미지 공개·보관·takedown 정책 결정.
- 지적·위치: `image-url.ts`, `r2-images.ts`의 공개 R2 URL·1년 immutable 캐시가 초안·교체·삭제 사진도 계속 노출한다는 지적이다. 최신 이미지 명세도 직접 URL을 회수하지 않는 정책을 명시한다.
- 방향: 공개 여부를 확인하는 Worker·서명 URL 제안을 검토한다. 교체 시 삭제는 다른 draft·버전·시트 참조와 캐시 사본을 확인한 후 결정한다.
- 완료 조건: 초안·현재 공개·비공개·교체·삭제 이미지의 접근과 잔존 캐시 수명을 명시하고 검증한다. OG 이미지·기존 저장 참조·생성용 원본 읽기도 함께 작동한다.
- 결과·검증·배포: 미착수.

### R24. 번호 소유 확인과 가입 여부 노출

- 원문: D4, L6. 상태: **결정 필요**. 선행: 소유 확인 방식·Onboarding 계약 결정.
- 지적·위치: `apps/api/src/discovery/discovery.ts`가 소유 확인 없이 Handle을 받아 Notification·Greeting 대상으로 삼고 `active` 응답으로 가입 여부를 노출한다는 주장이다. Notification 명세는 현재 번호 확인을 제공하지 않는다고 명시한다.
- 방향: 회신 확인 또는 OTP의 신뢰 경계·남용 비용을 검토하고 응답 일반화를 설계한다. Notification handle은 답장을 처리하지 않으므로 확인 채널을 별도로 명확히 한다.
- 완료 조건: 제3자가 다른 번호의 Conversation을 시작·수정하거나 가입 여부를 알아낼 수 없다. 미확인·확인·만료·중복·Reselection과 동의·지원 안내를 검증한다.
- 결과·검증·배포: 미착수.

### R25. Like 취소

- 원문: D5(선택 해제). 상태: **미검증**. 선행: 현재 Discovery 상호작용 확인.
- 지적·위치: `chrome.tsx`, `join-form.tsx`, `app.tsx`에 Like 해제 동작이 없고 선택을 확정으로 취급한다는 주장이다.
- 방향: Like 목록·접수 전 선택에서 취소를 지원할 필요와 동작을 확인한다. [Discovery 디자인](discovery-design.md)을 따른다.
- 완료 조건: 취소 후 카드·목록·개수·저장된 브라우저 상태·등록 payload가 일치하고, 빈 선택·새로고침·스타일 전환도 작동한다.
- 결과·검증·배포: 미착수.

### R26. 배정 불가 시 접수 안내

- 원문: D5(선택 누락·접수증). 상태: **미검증**. 선행: Selection·Assignment·R02의 후보 신선도 확인.
- 지적·위치: `contacts.ts`가 이미 배정된 Like 후보를 건너뛰는데 접수 화면은 연락을 확정한 듯 안내한다는 주장이다.
- 방향: Waitlist 접수와 Selection·Greeting의 차이를 현재 문구와 대조하고, 후보 소진·지연을 오인하지 않는 안내를 정한다.
- 완료 조건: 모든 후보 소진·일부 후보 가능·등록 중 동시 Assignment에서 서버 결과와 화면이 일치하며 연락 시점·선정·특정 Persona를 보장하지 않는다.
- 결과·검증·배포: 미착수.

### R27. 재등록 시 프로필·Likes 갱신

- 원문: D6. 상태: **결정 필요**. 선행: R24 또는 동등한 정보 변경 권한 검증.
- 지적·위치: `apps/api/src/discovery/discovery.ts`의 `INSERT OR IGNORE`가 두 번째 신청의 Like·이름·나이·언어를 버린다는 주장이다. 기존 명세는 재제출이 Likes를 덮어쓰지 않는다고 명시한다.
- 방향: 의도된 중복 제출 처리와 수정 기능을 분리한다. 소유 확인 없는 UPSERT로 타인의 정보를 바꾸지 않도록 갱신 권한·동의 이력 정책을 결정한다.
- 완료 조건: 단순 재전송·정당한 수정·동시 제출·동의 버전 변경·이미 active인 Handle에서 정보와 Notification dedup이 일관된다.
- 결과·검증·배포: 미착수.

### R28. 모바일 이미지 스타일 전환의 로딩·실패

- 원문: D7. 상태: **미검증**. 선행: 현재 이미지 rendition·디자인 요구 확인.
- 지적·위치: `app.tsx`, `use-image-style.ts`가 모든 1K 사진 decode를 기다려 다운로드가 커지고 한 장의 404도 전체 전환을 막는다는 주장이다.
- 방향: 필요한 화면·카드의 이미지 준비 범위, 축소본, 개별 실패 허용을 검토한다. 현재 디자인의 decode 후 전환·선택과 포커스 보존 요구를 유지한다.
- 완료 조건: 느린 모바일·404·연속 전환·reduced motion에서 전환이 종료되고, 전송량이 필요한 이미지에 제한되며 현재 사진·Likes·입력·스크롤이 유지된다.
- 결과·검증·배포: 미착수.

### R29. 서버 렌더링·검색·링크 미리보기

- 원문: D8. 상태: **검증 대기**. 선행: 배포 응답·공유 이미지 경로 확인.
- 지적·위치: 원문은 빈 HTML shell과 OG 부재를 지적한다. 현재 `apps/discovery/src/public-html.tsx`에 Home·App 서버 렌더링, canonical·OG·Twitter·JSON-LD·sitemap 구현을 확인했다.
- 방향: 새 구현을 추가하기 전에 `/`, `/explore`, 공개 Persona 경로의 실제 HTML과 배포 응답을 검증해 기존 해결 범위를 판정한다.
- 완료 조건: JavaScript 없이 콘텐츠·메타데이터를 읽을 수 있고 크롤러·iMessage 미리보기의 이미지가 접근 가능하다. 없는 Persona의 404·noindex도 검증한다.
- 결과·검증·배포: 구현 존재 확인. 동작·운영 검증 전이므로 종결하지 않음.

### R30. 턴별 Memory 프롬프트 크기와 캐시

- 원문: M2. 상태: **미검증**. 선행: 실제 토큰·캐시 사용량 측정.
- 지적·위치: `memory-model.ts`, `context/index.ts`, `memory.ts`의 단기 Memory 16,000자·무제한 faded 요약으로 기본 입력이 2만–3.5만 토큰이고 변경 시 캐시가 깨진다는 추산이다.
- 방향: 실제 구성·tokenizer·provider cache 경계를 측정한다. 2–4천 자·상위 N개·고정 섹션은 원문 제안이며 기억 품질과 함께 평가한다.
- 완료 조건: 작은·장기 Conversation에서 입력량과 비용이 예산 내에 있고, 필요한 Memory 회상·provenance·기존 관계 상태가 유지된다.
- 결과·검증·배포: 미착수.

### R31. Conversation 재빌드의 모델 호출·복구 비용

- 원문: M3. 상태: **미검증**. 선행: OpenCode history import 기능·R39 복구 요구 확인.
- 지적·위치: `rebuild-session.ts`의 prompt·replay가 메시지마다 모델을 부르고 부팅 시 전부 재빌드한다는 주장이다. 2,000건당 6천–1만 호출·$36–60은 원문 추산이며 미검증이다.
- 방향: 실제 replay 단위·호출 수를 측정하고 transcript import·운영자 명시 실행을 검토한다. 제공 SDK의 지원 기능을 먼저 확인한다.
- 완료 조건: 긴 이력 복구의 호출·토큰·시간 상한이 측정되고, 재빌드가 발신·유료 작업을 반복하거나 Conversation의 Memory·State를 다른 관계와 섞지 않는다.
- 결과·검증·배포: 미착수.

### R32. send 없는 턴의 정상·실패 판정

- 원문: M4. 상태: **미검증**. 선행: Persona의 의도적 무응답·follow-up 계약 확인.
- 지적·위치: `failed-turns.ts`가 assistant 오류·inbox 작업만 확인해 일반 텍스트 응답으로 끝난 턴의 발신 누락을 놓친다는 주장이다.
- 방향: 모든 턴에 send를 강제하지 않고, 응답이 필요한 턴과 의도적으로 보내지 않는 턴을 구분해 종료 조건·진단을 정한다.
- 완료 조건: 발신 누락은 감지되고 정상 무응답은 실패로 재실행되지 않는다. 재시도·운영 알림·늦은 전송에서 중복 발신이 없다.
- 결과·검증·배포: 미착수.

### R33. 손상된 State·Memory 파일의 격리와 복구

- 원문: M5. 상태: **미검증**. 선행: R39의 정상 스냅샷·복구 정책.
- 지적·위치: `memory-files.ts`의 `readRuntime`, `context/index.ts`의 `orDie`, `failed-turns.ts`가 YAML 손상 후 15분마다 영구 재시도한다는 주장이다.
- 방향: 손상 파일 보존·격리, 마지막 정상본 사용 가능성, 유한한 재시도와 운영자 복구를 검토한다. 오래된 상태로 복구할 때 잃는 변경을 명시한다.
- 완료 조건: 한 Conversation의 파일 손상이 다른 대화를 막지 않고, 원인·알림·복구 출처가 남으며 무한 재시도와 조용한 Memory 유실이 없다.
- 결과·검증·배포: 미착수.

### R34. 사용자별 사용량·전역 모델 비용 상한

- 원문: M6. 상태: **미검증**. 선행: 현재 usage 수집·가격·운영 예산 확인.
- 지적·위치: 등록 제한 외에 사용자별 턴·토큰 제한이 없어 한 사람의 대량 메시지가 비용을 소진한다는 주장이다.
- 방향: 일일 턴·토큰 예산과 전역 알림·정지 정책을 결정한다. 늦게 확정되는 사용량과 병렬 예약분을 계산에 포함한다. R01에서 확인한 운영 compaction 기준 600k가 비용 예산에 적절한지도 R30의 실제 입력량·캐시 측정과 함께 판단한다.
- 완료 조건: 동시 턴·날짜 경계·늦은 비용 보고·재시작에서도 예산이 중복 차감되거나 무제한 초과하지 않으며, 제한 사유와 운영 대응을 확인할 수 있다.
- 결과·검증·배포: 미착수.

### R35. Relationship ending 후 데이터 보관·정리

- 원문: M7. 상태: **결정 필요**. 선행: R39–R41과 보관·삭제 정책 조율.
- 지적·위치: `conversations/end.ts`, `retained.ts`가 ended_at만 기록하고 세션·폴더를 영구 보관한다는 주장이다. CONTEXT.md는 Retired persona의 관계 이력을 운영자가 보관한다고 정의한다.
- 방향: 관계 이력 보관과 실행 세션·첨부의 수명을 분리해 필요한 기간과 정리 범위를 결정한다.
- 완료 조건: 만료 정리가 활성 관계를 건드리지 않고 세션·첨부·백업에 일관되게 적용된다. 보관하는 이력과 삭제한 정보가 정책·사용자 안내에 일치한다.
- 결과·검증·배포: 미착수.

### R36. 연령 조건·약관·개인정보 안내 접근성

- 원문: L1. 상태: **결정 필요**. 선행: 서비스 대상 연령·적용 지역·동의 요건 확인.
- 지적·위치: `optional-profile.tsx`의 선택적 age·`min={1}`, 약관 링크 부재를 지적하며 14세 미만 차단 또는 법정대리인 동의를 제안한다. 법적 요건은 이 문서에서 확정하지 않는다.
- 방향: 최소 이용 연령·필수 확인 정보·거부 흐름을 결정하고 브라우저와 서버 경계에 반영한다. 약관·처리방침을 등록 전 읽을 수 있게 한다.
- 완료 조건: 미입력·경계 나이·위조 payload·모든 지원 언어에서 동일한 조건이 적용되고, 안내·동의 버전·저장 정보가 일치한다.
- 결과·검증·배포: 미착수.

### R37. 국외이전·외부 처리 고지 정합성

- 원문: L2. 상태: **미검증**. 선행: 실제 제공자·subprocessor·처리 지역·계약 확인.
- 지적·위치: `packages/onboarding/src/discovery-notice.json`의 처리 국가 미확인 문구와 원문 당시 `opencode-go/deepseek-v4.1-flash`, `ADMIN_JURISDICTION: us`의 관계를 지적한다. 모델 이름이나 저장 위치만으로 처리 국가 전체를 단정할 수 없다.
- 방향: 이전받는 자·국가·항목·목적·기간을 근거로 확인하고, 필요한 고지·동의 방식을 결정한다.
- 완료 조건: 실제 데이터 흐름과 모든 언어의 고지·동의 버전이 일치하며, 확인되지 않은 사실을 확정적으로 쓰지 않고 필요한 운영 결정을 기록한다.
- 결과·검증·배포: 미착수.

### R38. IP 저장·해시·보관 고지

- 원문: L3. 상태: **부분 확인**. 선행: R05와 처리 목적·보관 정책 결정.
- 지적·위치: `apps/api/src/discovery/rate-limit.ts`의 비밀키 없는 SHA-256과 1시간 SQLite 저장을 확인했다. 고지의 “서버 메모리에 일시적으로”라는 원문 인용은 현재 동의 문서에서 재확인해야 한다.
- 방향: 실제 저장·삭제 시점과 고지를 맞추고 서버 secret 기반 해시 필요성을 검토한다. 요청이 없을 때 만료 행이 언제 물리 삭제되는지도 확인한다.
- 완료 조건: 원 IP·식별자가 로그에 남지 않고, 해시·저장 위치·실제 보관 기간·비밀 교체 동작이 고지와 일치한다.
- 결과·검증·배포: 미착수.

### R39. Conversation 데이터 백업과 복구 리허설

- 원문: L4, O3. 상태: **미검증**. 선행: authoritative state·Mac 파일·secret 경계 목록화.
- 지적·위치: State·Memory·transcript가 Mac 볼륨 하나에만 있고 `apps/api/ops/README.md`의 “Cloudflare owns all application state”와 다르다는 주장이다. 원문은 ADR-0006의 디스크 동시 손실 위험을 인용한다.
- 방향: 현재 저장 주체와 문구를 먼저 정정하고, 암호화된 외부 export·보관·복구 절차를 정한다. R17의 자격증명 제외와 R35·R40의 삭제 정책을 반영한다.
- 완료 조건: 별도 환경에서 유실 시나리오를 복원하고 State·Memory·이력·durable dedup·uncertain 전송의 정합성을 확인한다. 복구 시점·소요 시간·실패 알림을 기록한다.
- 결과·검증·배포: 미착수.

### R40. 사용자 삭제의 전체 저장 경계 정리

- 원문: L5(삭제). 상태: **미검증**. 선행: 데이터 위치·보관 예외 목록, R39.
- 지적·위치: `operator.ts`의 remove가 `intake_pending`, `intake_edit`을 지우지 않아 평문 메시지 JSON·Handle이 남는다는 주장이다.
- 방향: 모든 테이블·Mac 파일·세션·첨부·Notification·백업을 목록화하고 하나의 삭제 orchestration에서 재실행 가능하게 처리한다. 삭제 중 재유입과 보관해야 하는 익명 예산 기록을 구분한다.
- 완료 조건: 활동 중·대기 중·실패 중·중단 후 재시도 삭제를 실제 저장 경계에서 확인하고, 잔존 식별정보·재생성·부분 삭제가 없거나 명시된 정책대로 처리된다.
- 결과·검증·배포: 미착수.

### R41. 사용자 데이터 내보내기

- 원문: L5(내보내기). 상태: **미검증**. 선행: R24의 요청자 확인, R40의 데이터 목록.
- 지적·위치: 사용자 데이터 export 명령이 없다는 주장이다.
- 방향: 요청자 확인·내보낼 범위·형식·전달·만료 정책을 정하고 운영 경로를 구현한다. Persona의 비공개 설정이나 다른 사용자의 데이터를 혼입하지 않는다.
- 완료 조건: 요청한 사용자의 필요한 데이터가 완전하게 추출되고, 접근 권한·전달·중간 파일 정리·로그의 민감 정보 제외를 검증한다.
- 결과·검증·배포: 미착수.

### R42. Worker·Mac 배포 의존성과 실제 준비 확인

- 원문: O1. 상태: **미검증**. 선행: 현재 CI·Mac updater·서비스 간 계약 확인.
- 지적·위치: `.github/workflows/ci.yml`에서 admin·discovery·api가 gates에만 의존해 Mac bundle 실패나 구 API와의 불일치에도 배포된다는 주장이다.
- 방향: 원문의 API → Admin/Discovery·Mac bundle 선행·schema version 제안을 현재 배포 계약과 대조한다. 진행 중인 Mac 설치를 Worker CI에 대한 순환 의존으로 만들지 않는다.
- 완료 조건: bundle 실패·Worker 선배포·Mac 지연 설치·dependency degraded 상태를 명확히 구분한다. 필수 health는 예상 service·전체 artifact revision·readiness로 확인하고 최종 end-to-end 준비를 기록한다.
- 결과·검증·배포: 미착수.

### R43. 롤백과 저장 데이터 변경 복구

- 원문: O2(롤백). 상태: **미검증**. 선행: R39·R42, 현재 배포·schema 변경 방식 확인.
- 지적·위치: 롤백 workflow가 없고 migration은 전진만 한다는 주장이다.
- 방향: artifact 되돌리기와 데이터 복구를 나눠 실제 지원 가능한 절차를 결정한다. 데이터 손실을 일으키는 역 migration이나 영구적인 구버전 호환층을 기본 해법으로 추가하지 않는다.
- 완료 조건: 실패 배포 시 검증된 revision으로 복구하고 저장 데이터·서비스 계약·health를 확인하는 리허설이 있다. 복구 불가 조건과 필요한 운영 동작을 기록한다.
- 결과·검증·배포: 미착수.

### R44. 운영 알림 설정 누락 감지

- 원문: O2(알림). 상태: **미검증**. 선행: 실제 운영 알림 채널·secret 확인.
- 지적·위치: 선택적인 `DISCORD_WEBHOOK_URL` 누락이 운영 알림을 조용히 끈다는 주장이다.
- 방향: 운영에서 필수인 채널을 정하고 누락·전송 실패·rate limit 상태를 가시화한다. 다른 진단 경로 없이 같은 실패 알림만 반복하지 않는다.
- 완료 조건: secret 누락·채널 장애가 감지되고, 실제 시험 알림과 중복 제한·원인 보존·민감 정보 제외를 확인한다.
- 결과·검증·배포: 미착수.

### R45. 재배포 없는 실행 정지 스위치

- 원문: O2(정지 스위치). 상태: **미검증**. 선행: R07·R34, 정지할 작업의 범위 결정.
- 지적·위치: `BOOTSTRAP_ONLY`가 wrangler 변수여서 긴급 정지에 배포가 필요하다는 주장이다.
- 방향: 런타임에서 읽는 영속 실행 제어를 검토하고 새 수신 접수·모델 실행·발신·이미 진행 중인 요청의 동작을 명시한다.
- 완료 조건: 재배포 없이 권한 있는 운영자가 정지·재개하고, actor 교체 후에도 상태가 유지된다. 정지 중 작업 유실·중복 발신 없이 재개되며 감사 기록이 남는다.
- 결과·검증·배포: 미착수.

## 진행 기록

- 2026-10-21 / 문서: 원문 P0 7개와 A·G·D·M·L·O 전체 항목을 R01–R45로 통합했다. G8·D5·L5·O2는 독립 작업으로 나눴다.
- 2026-10-21 / 초기 확인: R01 설정·테스트 불일치, R02 공개 Catalog 요청, R05·R38 IP 저장 코드를 확인했다. R04·R21·R23 등의 기존 정책과 R29 서버 렌더링 구현을 기록했다. 코드 수정·전체 동작 재검증·운영 확인은 미착수다.
- 2026-10-21 / R01 종결: buffer 400k는 운영 1M 한도·600k 예산, 테스트의 40k는 별도 100k 한도·60k 예산임을 확인했다. buffer를 낮추면 compaction이 늦어지므로 원문의 오타 수정은 채택하지 않았다. 주석·runbook 보강, 관련 8개 테스트와 필수 검사 완료. native 검사는 Rust PATH를 바로잡아 해당 단계만 재실행했다. 다음 대상은 R09다.
- 2026-10-21 / R09 구현·코드 검증: OpenCode의 헤더·유한 본문, Messages의 유한 RPC, 헬스·운영 알림에 deadline과 실제 HTTP 취소를 연결했다. 장기 스트림·전송 uncertain 정산·민감 정보 없는 진단을 회귀 검증했다. 1,538개 TypeScript 테스트·파일별 커버리지 100%·게이트 자체 검증과 별도 빌드 디렉터리의 native 검사(46개 테스트) 통과. 배포·운영 확인은 대기하며 다음 코드 작업은 R03다.
- 2026-10-21 / 6개 묶음 착수: 사용자 승인으로 R03·R08·R10·R11·R06·R02를 연속 처리한다. 기준 커밋은 `00a4f8f53b64dbdcab912f24443cbf90da9d2458`이며 R01·R09의 기존 작업 변경을 포함한다. 개발 중 focused 검사, 마지막 전체 CI 1회와 필요한 실패 검사만 재실행한다.
- 2026-10-22 / 6개 묶음 코드 검증 완료: alarm admission 예산·영속 lane/session 재개, 관측 backoff·연결 복구 초기화·제한 조회, APNs readiness·durable 알림, 공개 Catalog 캐시·fresh 등록 검증을 구현했다. 최종 검토에서 startup 재시도 고착·quota 재발 관측 지연·실패 session의 hot wake를 수정하고 회귀 검증했다. `bun run ci` 전체가 첫 최종 실행에서 통과했다. 배포 미실행이므로 여섯 카드는 검증 대기다.
