> **유지관리자 검토용 초안 — 법률 자문이 아닙니다.** 공개 전에 유지관리자가 직접 법률 검토, 처리 위치, 보관·삭제 범위와 연락처를 확정해 주세요. 아래 영문은 검토용 번역이며 공개용 한국어 문구의 일부가 아닙니다.

# hena 개인정보 처리 안내 (한국어)

**버전: 초안 0.1 (2026-09-27; 게시 전 확정 필요)**

hena는 iMessage에서 AI 캐릭터와 대화하는 시험 서비스입니다. 대화를 시작하기 전에 이 안내를 읽고 명시적으로 동의해야 합니다. 첫 메시지는 서비스의 AI 안내이고, 그다음에 캐릭터의 인사가 옵니다.

**수집하는 정보와 쓰는 이유**

- 입력한 iMessage 연락처(전화번호 또는 Apple ID 이메일, 이하 ‘Handle’): 첫 안내와 대화를 보내고, 같은 연락처에 중복 안내를 보내지 않으며, 차단·삭제 요청을 처리하기 위해 사용합니다.
- 언어 설정(locale), 동의한 안내의 버전·언어·동의 시각: 알맞은 언어로 안내하고 동의 사실을 기록하기 위해 사용합니다.
- 대화 내용(주고받은 글, 사진 등 첨부물, 반응, 대화 기억과 전송 기록): 캐릭터가 답하고 지난 대화를 기억하며 전달 오류와 남용을 확인하기 위해 사용합니다. 대화를 계속하면 그 내용이 AI 모델에 전달될 수 있습니다.
- 대기 명단에 신청하면 이메일 주소, 언어 설정 및 대기 이유: 나중에 서비스를 이용할 수 있게 될 때 연락하기 위해 사용합니다.
- 신청 과정의 IP 주소와 사람 확인 정보는 남용 방지 및 Cloudflare Turnstile 확인에 이용합니다. IP 주소는 서버의 요청 제한을 위해 일시적으로만 쓰며 영구 목록으로 저장하지 않습니다.

**어디서 처리하나요?** hena의 서버는 운영자의 Mac mini에서 iMessage 대화와 캐릭터의 기억을 처리·저장합니다. 야간 백업도 이 Mac mini에만 보관하며 외부 백업 저장소로 전송하지 않습니다. 메시지 전달에는 Apple iMessage가 관여합니다. 사이트와 공개 API에는 Cloudflare가 관여합니다. 답변을 만들 때 대화 내용은 **OpenCode Go (Anomaly Innovations, Inc.)**를 거쳐 **DeepSeek** 모델 제공 경로로 전송·처리됩니다. 외부 제공업체의 실제 처리 국가를 공개 전에 확인해야 합니다. **[확인 후 지역/국외 이전 내용 기입]**

**얼마나 보관하나요?** 서비스는 대화를 운영하는 동안 연락처, 동의 기록, 대화와 기억을 보관합니다. 삭제 요청을 받으면 서비스의 사용자 기록과 캐릭터 기억을 삭제합니다. 서비스가 관리하는 야간 백업에는 이미 삭제한 정보가 남을 수 있지만, Mac mini의 야간 백업은 최대 **14일**만 보관되므로 해당 정보는 그 기간 안에 서비스 백업에서 없어집니다. 대기 명단 이메일의 보관 종료 기준은 공개 전에 확정해야 합니다. **[대기 명단 보관 기간/종료 기준 기입]**

OpenCode의 [이용약관](https://opencode.ai/legal/terms-of-service)은 OpenCode가 입력·출력 대화 내용을 보관하지 않는다고 설명하지만, 제3자 모델 제공업체의 보관 방식까지 통제한다고 약속하지는 않습니다. OpenCode Go의 [모델별 개인정보 표](https://opencode.ai/docs/go/#privacy)는 **DeepSeek V4.1 Flash**에 대해 ‘모델 학습에 사용하지 않음’, ‘데이터 보관 0일’이라고 표시합니다. 다만 이 **DeepSeek 영 보관 계약은 매달 갱신되며 현재 게시된 계약은 2026년 9월 30일까지만 유효**하다고 명시되어 있습니다. 이는 현재 게시된 조건이지 이후의 영구적인 무보관 보증이 아닙니다. 9월 30일 이후 제공 조건과 실제 사용 모델을 출시 전에 다시 확인해야 합니다. Apple 및 각 제공업체가 자체적으로 처리하는 데이터까지 서비스의 14일 백업 삭제 약속에 포함되지는 않습니다.

**그만 받거나 삭제를 요청하려면** iMessage에서 이 대화를 **차단**하면 더 이상 캐릭터 메시지를 받지 않습니다. 차단만으로 이전 대화가 삭제되지는 않습니다. 데이터 삭제나 대기 명단 탈퇴를 요청하려면 **[유지관리자의 삭제 요청 연락처]**로 연락해 주세요. 요청 시 본인 확인에 필요한 연락처를 확인할 수 있습니다. Apple 기기의 메시지 기록과 제공업체가 별도로 보관하는 정보의 삭제 범위는 공개 전에 확인해야 합니다.

---

## English gloss (for maintainer review, not site copy)

**Version: draft 0.1, September 27, 2026; finalize before publication.** This is a Korean-language pilot of an AI character on iMessage. Explicit consent is required before the first service Notice, which identifies the character as AI; the character's greeting follows.

We collect the submitted iMessage Handle (phone number or Apple ID email) to deliver messages, prevent duplicate notices, and handle blocking and removal; locale and the consented notice's version, language and timestamp to record consent and choose language; conversation text, images/attachments, reactions, memory and send records to run and troubleshoot conversations; and, if a visitor joins the Waitlist, email, locale and reason for being waitlisted for later invitations. IP and Turnstile verification are used transiently to limit abuse; the server does not persist IPs as a rate-limit list.

The operator's Mac mini processes and stores the conversation and memory. Nightly backups remain only on that Mac mini; no backup is uploaded to outside storage. Apple iMessage handles message delivery, and Cloudflare handles the site and public API. Conversation material is sent through OpenCode Go (Anomaly Innovations, Inc.) to the DeepSeek model path. The physical regions for outside processing must be verified and disclosed before publication.

Active service records are retained during service use and the user records and character memory are removed on a removal request. Deleted records may remain in service-controlled nightly backups for up to 14 days, after which those backups expire. The Waitlist retention end date still needs a decision. OpenCode's terms say it does not retain conversation content but cannot control third-party model providers' retention. Go's DeepSeek V4.1 Flash listing says “Not used” for training and “0 days” retention under a monthly renewed DeepSeek zero-data-retention agreement **valid only through September 30, 2026** as currently posted. This is not a perpetual guarantee or a promise about Apple's or other providers' separately held copies.

Block the iMessage conversation to stop receiving character messages; blocking does not delete past data. Request removal, including Waitlist removal, via **[maintainer's removal-request contact]**. The maintainer must confirm the extent of deletion for Apple Messages copies and provider-held material.

### Review references and unresolved publication checks (not site copy)

- [Issue #55](https://github.com/hena-agent/ren-ai/issues/55) and [current product spec #23](https://github.com/hena-agent/ren-ai/issues/23): required copy and data flow. The Korean testing period uses local-only nightly backups kept for 14 days, superseding the spec's earlier remote-copy plan. The spec's removal procedure deletes service records and OpenCode sessions but does **not expressly delete the Apple Messages history**; resolve this before promising removal from “every copy.”
- [OpenCode Terms of Use, effective August 15, 2026](https://opencode.ai/legal/terms-of-service) (“Who Owns the Services and Content?”): says it will not retain Content but does not control Third Party Model retention; also limits use to internal use and prohibits auto-responders. Maintainer should resolve this launch risk separately.
- [OpenCode Go privacy table, page last updated September 26, 2026](https://opencode.ai/docs/go/#privacy): DeepSeek V4.1 Flash is listed as not used for training, 0-day retention; DeepSeek ZDR agreement is renewed monthly and valid through September 30, 2026. Recheck near publication and after expiration.
- [OpenCode Privacy Policy, effective March 6, 2026](https://opencode.ai/legal/privacy-policy): conversations passed upstream and not stored by OpenCode; other personal data can be retained as necessary and in some cases longer for legal reasons. Do not generalize the conversation-specific statement to all metadata or providers.
- **Before release:** fill in the contact and Waitlist deadline, verify model and provider terms after September 30, identify processing countries, decide how Apple Messages/device copies are handled on deletion, and approve final Notice wording (currently in [#10](https://github.com/hena-agent/ren-ai/issues/10): “안녕하세요, hena예요. 이제 AI 캐릭터가 메시지를 보낼 거예요. 그만 받고 싶으면 이 대화를 차단해 주세요.”).
