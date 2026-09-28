# hena 개인정보 처리 안내

**버전: 2026-09-28**

hena는 iMessage에서 AI 캐릭터와 대화하는 시험 서비스입니다. 대화를 시작하기 전에 이 안내를 읽고 명시적으로 동의해야 합니다.

첫 메시지는 서비스가 보내는 AI 안내이고, 그다음에 캐릭터의 인사가 옵니다.

## 수집하는 정보와 사용 목적

입력한 iMessage 연락처(전화번호 또는 Apple ID 이메일)는 안내와 대화를 보내고, 같은 연락처에 안내를 중복 전송하지 않으며, 차단·삭제 요청을 처리하는 데 사용합니다.

언어 설정과 동의한 안내의 버전·언어·시각은 알맞은 언어로 안내하고 동의 사실을 기록하는 데 사용합니다.

주고받은 글, 사진 등 첨부물, 반응, 캐릭터의 대화 기억과 전송 기록은 답변을 만들고 지난 대화를 기억하며 전달 오류와 남용을 확인하는 데 사용합니다. 대화를 계속하면 그 내용이 AI 모델로 전달될 수 있습니다.

대기 명단에 신청하면 이메일 주소, 언어 설정, 대기 이유를 기록하여 나중에 서비스를 이용할 수 있을 때 연락하는 데 사용합니다.

신청 과정의 IP 주소와 사람 확인 정보는 남용 방지와 Cloudflare Turnstile 확인에 사용합니다. IP 주소를 이용한 서버의 신청 횟수 제한 목록은 메모리에만 일시적으로 유지하며 파일로 저장하지 않습니다.

## 처리 경로와 위치

운영자의 Mac mini에서 iMessage 대화와 캐릭터의 기억을 처리·저장합니다. 야간 백업도 이 Mac mini에만 보관하며 외부 백업 저장소로 전송하지 않습니다.

메시지 전달에는 Apple iMessage가, 사이트와 공개 API에는 Cloudflare가 관여합니다. 답변을 만들 때 대화 내용은 OpenCode Go(Anomaly Innovations, Inc.)를 거쳐 DeepSeek V4.1 Flash 모델 제공 경로로 전송·처리됩니다.

외부 제공업체의 실제 데이터 처리 국가와 지역은 현재 확인되지 않았습니다. 한국에서만 처리된다고 보장하지 않습니다.

## 보관 기간과 삭제 범위

서비스를 이용하는 동안 연락처, 동의 기록, 대화 및 캐릭터의 기억을 보관합니다. 삭제를 요청하면 서비스가 관리하는 사용자 기록과 캐릭터의 기억을 삭제합니다.

대기 명단의 이메일·언어·대기 이유는 자동 만료 기한 없이 보관하며, 삭제 요청을 받으면 대기 명단에서 삭제합니다.

삭제한 정보가 이미 만들어진 야간 백업에는 남을 수 있습니다. 백업은 Mac mini에만 보관하며, 생성 후 14일이 지난 백업은 매일 야간 정리 때 삭제합니다.

사용자 기록과 캐릭터 기억의 삭제는 Apple Messages의 대화 기록(chat.db)이나 사용자 기기에 남은 메시지를 삭제하지 않습니다. Apple 및 외부 제공업체가 별도로 보관하는 정보도 저희가 직접 삭제한다고 약속할 수 없습니다.

## 외부 모델의 데이터 처리

OpenCode 이용약관은 OpenCode가 대화 입력·출력 내용을 보관하지 않는다고 설명하지만, 제3자 모델 제공업체의 보관 방식은 통제하지 않는다고 명시합니다.

2026년 9월 28일 확인한 OpenCode Go의 모델별 표에는 DeepSeek V4.1 Flash의 모델 학습 사용이 ‘하지 않음’, 데이터 보관이 ‘0일’로 표시되어 있습니다. 다만 DeepSeek 영 보관 계약은 매달 갱신되며 현재 공개된 계약의 유효 기간은 2026년 9월 30일까지입니다. 그 이후에도 같은 조건이 유지된다고 보장하지 않습니다.

## 메시지 중단과 삭제 요청

iMessage에서 대화를 차단하면 더 이상 캐릭터의 메시지를 받지 않습니다. 차단만으로 이전 대화나 서비스 기록이 삭제되지는 않습니다.

사용자 기록 삭제나 대기 명단 탈퇴를 요청할 때에는 아래 연락처로 알려 주세요. 요청을 처리하기 위해 해당 연락처의 본인 여부를 확인할 수 있습니다.

## 삭제 및 대기 명단 탈퇴 문의

[hi@hena.dev](mailto:hi@hena.dev)

---

## English gloss (maintainer reference; not published site copy)

**Version: 2026-09-28.** hena is a pilot iMessage service with an AI persona. Explicit agreement to this notice is required before onboarding. The service sends an AI disclosure first; the persona's greeting follows. The separate, unchanged service Notice says: “안녕하세요, hena예요. 이제 AI 캐릭터가 메시지를 보낼 거예요. 그만 받고 싶으면 이 대화를 차단해 주세요.”

We use a submitted phone number or Apple ID email to send messages, avoid duplicate notices, and handle blocking and removal; the locale and consent version/language/time to record consent; conversation text, images and other attachments, reactions, persona memory, and send records to operate and troubleshoot the service; and, for the Waitlist, the email, locale, and reason to make future contact. The server temporarily uses IPs in memory for rate limits; Cloudflare Turnstile checks the submission.

The operator's Mac mini processes and stores the conversation and memory. Nightly backups remain on that Mac mini, with no offsite upload. Apple delivers iMessages; Cloudflare serves the site and public API; conversation material goes through OpenCode Go (Anomaly Innovations, Inc.) to the DeepSeek V4.1 Flash model path. The actual external processing countries/regions have **not been confirmed**; this service cannot promise Korean-only processing. DeepSeek's general public privacy policy explicitly excludes downstream apps, so it does not establish the Go route's processing location.

Service-managed user records and persona memory remain during use and are deleted on request. Waitlist email, locale, and reason are **archived without automatic expiry**, and removed on request to [hi@hena.dev](mailto:hi@hena.dev). Deleted data may remain in existing local nightly backups; backup files older than 14 days are removed in the next nightly cleanup. The implemented user removal does **not** delete Apple Messages' `chat.db` history or messages on users' devices. Nor does hena promise to remove data retained separately by Apple or model providers. Blocking the conversation stops future persona messages but does not delete history or service data. A removal request may require confirming the relevant contact.

[OpenCode's terms](https://opencode.ai/legal/terms-of-service) say it does not retain conversation Input and Output, but it cannot control third-party models' retention; its [privacy policy](https://opencode.ai/legal/privacy-policy) also distinguishes conversation content passed upstream from other personal data. On September 28, 2026, the [OpenCode Go model privacy table](https://opencode.ai/docs/go/#privacy) listed DeepSeek V4.1 Flash as “Not used” for model training and “0 days” retention under a **monthly renewed DeepSeek ZDR agreement currently valid only through September 30, 2026**. Neither renewal nor continuation of those terms is guaranteed after that date. [DeepSeek's public policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) excludes downstream apps; do not use its location or consumer-app statements as a promise about the OpenCode Go route.

The Korean public text above matches `packages/onboarding/src/locales/ko.json`. Recheck the provider's then-current terms when reviewing a later privacy version; do not silently extend the September 30 claim.
