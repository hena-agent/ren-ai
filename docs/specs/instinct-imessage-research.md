# Instinct iMessage 조사 메모

## 결정

우리 서비스는 **하나의 iMessage 주소(tenant)**로 시작한다. 여러 사용자의 대화는 발신 주소를 기준으로 서버에서 분리하고, 사용자가 선택한 캐릭터와 관계 상태에 연결한다. 캐릭터마다 Apple 계정이나 번호를 만들지 않는다.

## Instinct에서 확인된 것

- [온보딩 코드](https://app.instinct.com/assets/OnboardingPage-C07nR6p9.js)는 사용자에게 `smsPhoneNumber`를 내려주고 화면에서는 이를 **iMessage number**라고 부른다. WhatsApp 번호는 별도 필드다. 변수명이나 화면 문구만으로 실제 전송이 항상 파란 말풍선 iMessage인지 확정할 수는 없다.
- [SMS 약관](https://instinct.com/legal/sms-terms.html)은 대기자에게 *assigned Instinct number*에서 문자를 보낸다고 명시한다. [번호 이전 화면](https://app.instinct.com/assets/TextInstinctPage-Cwnb_Qzr.js)도 있다. 이것만으로 사용자별 전용 번호인지, 공유 번호 풀인지 알 수 없다.
- [iMessage relay 연결 화면](https://app.instinct.com/assets/IMessageRelaySignInPage-Cho0Dpum.js)은 **사용자의 Apple ID를 연결하는 별도 기능**이다. 이 기능이 Instinct의 사용자 대화용 번호를 어떻게 운영하는지 설명해 주지는 않는다.
- 2026년 8월 [보도](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/) 당시 Instinct는 비공개 접근 단계였다. 공개된 활성 사용자 수, 번호 수, 번호당 처리량은 확인되지 않았다.

## 우리에게 중요한 미확인 사항

Apple은 일반적인 봇용 iMessage 서버 API나 계정별 자동 발송 한도를 공개하지 않는다. 따라서 **한 주소로 수용 가능한 사용자 수를 Instinct 사례만으로 산정할 수 없다.** 여러 번호로 나눌 필요가 있다고 미리 가정하지 않는다.

단일 주소로 베타를 운영하며 피크 시간대 발송·수신량, 응답 지연, 누락·중복·발송 실패, 계정 재인증·잠금을 측정한다. 발신 주소 변경(전화번호 ↔ Apple ID 이메일) 시 사용자 재연결 방식도 확인한다.
