# Admin

## 실패 로그 찾기

루트 `bun run dev`는 Turbo stream UI와 stream 순서로 서비스 출력을 표시한다. TUI는
선택하지 않은 서비스의 별도 PTY 출력을 부모 터미널에서 놓칠 수 있으므로 사용하지 않는다.
Bun watch는 `--no-clear-screen`으로 재시작 때 이전 진단을 화면에서 지우지 않는다.
설정을 적용하려면 이미 실행 중인 `bun run dev`를 재시작한다.

Admin은 구조화된 JSON 이벤트를 터미널 stdout/stderr와
`apps/admin/data/logs/admin-YYYY-MM-DD.jsonl`에 함께 기록한다. 날짜는 UTC다.
`ADMIN_LOG_DIRECTORY`로 저장 폴더를 변경할 수 있다. 시작 이벤트에 실제 로그 폴더가
기록된다. 로그 파일은 재시작 후에도 append되며 디렉터리 권한은 0700, 새 로그 파일은
0600이다. 보관 기간에 도달한 파일은 운영자가 정리한다.

오류 화면의 요청 ID로 요청·작업 진단을 검색한다:

```sh
rg --fixed-strings '<요청 ID>' apps/admin/data/logs
```

`operation.failed`는 실패 단계·원인과 오류 코드·모델·upstream 상태를, 같은 요청의
`request.completed`는 최종 HTTP 상태를 담는다. 백그라운드 이미지 진단도 등록 요청 ID를
사용한다. Persona 내용, 프롬프트, Memory/State, 서명 draft, 자격 증명, 이미지 바이트는
로그에 기록하지 않는다. 파일 기록이 실패하면 stderr에 `logging.persistence_failed`와
저장 원인을 출력하며 원래 응답 결과는 바꾸지 않는다.

지속 파일 로거를 추가하기 전에 처리된 요청의 로그를 소급 복구할 수는 없다.
