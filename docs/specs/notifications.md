# Notifications

Agreed on 2026-10-19. [ADR-0020](../adr/0020-notifications-come-from-noti-renai-im.md)
records the identity and transport decision. This document distinguishes the Mac
capability from the separate Discovery rollout.

## Step 1: Mac capability

- Personas use `hi@renai.im`; Notifications use `noti@renai.im` on the same Apple
  Account. There is one supervised Rustpush bridge. Only those two roles can send;
  other registered personal aliases are not permitted senders.
- Existing `sendText`, history, follow, status and gesture RPCs remain scoped to
  the Service handle. New `notify` and `notificationStatus` calls use a separate
  outgoing ledger. An older Mac rejects the new calls, never sending through `hi@`.
- Record each outgoing Notification before native submission. One call makes one
  attempt. A timeout or disconnect stays uncertain; neither restart nor status
  lookup resubmits it. Receipts can settle an uncertain GUID later.
- `notify` returns a GUID and a server-generated request ID shared with native
  diagnostics. Status uses `pending`, `sent`, `delivered` and `failed`; `pending`
  is an uncertain outcome, not permission to retry. Error 22 can mean Apple rate
  limiting as well as a recipient without iMessage.
- Replies to the Notification handle are not retained as messages or attachments,
  routed to Personas, acted upon or answered. Raw APNs spool data still follows the
  existing persistence-before-acknowledgement and certification lifecycle.
- The Service handle is required at startup. Notification readiness is reported
  separately in authenticated health responses. During Step 1 it is optional for
  overall readiness and the Mac updater, so an unprovisioned alias cannot roll back
  an otherwise healthy Persona transport.
- Follow [the alias runbook](../../apps/imsg/ops/notifications.md). Verify exact
  artifact identity locally and through the tunnel, independent sender/thread
  presentation, dropped replies and intact Persona messaging before Step 2.

## Step 2: Discovery, API and Admin (separate release)

Step 1 live acceptance passed on `e00db759e20c0cbfb095eec27b270a796b5a869f`;
[the rollout record](https://github.com/hena-agent/ren-ai/pull/115#issuecomment-6259688946)
includes sender separation, dropped replies/photos, Persona replies and restart
persistence. Step 2 uses consent version `discovery-2026-10-19` in all locales.

- Save a Notification atomically with each new Waitlist entry. New joins,
  Reselection and test-handle joins after Reset qualify. Repeat submissions and
  already-active handles do not send another message. Existing registrations are
  not a backfill campaign.
- Joining succeeds before sending. Attempt on the next background tick, normally
  within seconds. This is informational, with no confirmation reply or number
  verification and no delivery result exposed on the public site.
- Cap Waitlist Notifications at 30 per hour across the service. Excess joins still succeed;
  their Notifications are skipped, not deferred into a later backlog.
  Admission to a send attempt uses a rolling hour of anonymous timestamps in
  SQLite, committed with the uncertain state before calling the Mac. Removing a
  registration or resetting a test handle cannot reset that budget.
- One attempt only: no automatic retry or Admin resend button. Admin shows queued,
  sent, failed, uncertain or skipped results on Waitlist entries. Delivery receipts
  may update the transport record. Failure never changes eligibility, Selection or
  the person's contact state.
- Use the display/consent `locale` saved with the join, not preferred Conversation
  language. All three supported locales receive equivalent copy.
- Delete application Notification records with their Waitlist entry. Existing Mac
  message-history/backup retention remains a separate operational responsibility.
- Update Discovery's receipt, localized consent version and the conflicting
  no-message-on-join statements in `persona-discovery-admin.md` together. A stale
  consent version is rejected and requires reloading and accepting the new text.

### Notification copy

**English**

> [Ren AI] This number has joined the Ren AI waitlist. There's no set order or date
> for contact. If you're selected, a persona you liked will text you from
> hi@renai.im. This address only sends notifications and doesn't read replies. To
> leave the waitlist, or if you didn't sign up, email hi@renai.im.

**Korean**

> [Ren AI] 이 번호로 Ren AI 대기 등록이 완료되었습니다. 연락 순서와 시점은 정해져 있지 않아요.
> 선택되면 좋아한 페르소나가 hi@renai.im에서 먼저 메시지를 보내요. 이 주소는 안내 전용이라
> 답장을 확인하지 않습니다. 대기 등록을 취소하거나 직접 등록하지 않았다면 hi@renai.im로
> 이메일을 보내 주세요.

Japanese must express the same content. Reselection joins use the same message.
Blocking the Notification handle is not a Waitlist removal request. Support and
deletion instructions explicitly say **email**, since an iMessage to `hi@` from a
waiting person is not a support inbox.

### Discovery receipt copy

**English:** There is no guaranteed order or contact date. On iMessage, Ren AI's
notifications come from noti@renai.im and the persona's first greeting comes from
hi@renai.im.

**Korean:** 등록 순서와 연락 시점은 정해져 있지 않아요. iMessage에서 Ren AI 안내는
noti@renai.im, 페르소나의 첫 인사는 hi@renai.im에서 와요.

Use equivalent Japanese. Do not claim a Notification was sent: repeated joins,
limits and failed attempts can all produce the same successful Waitlist receipt.

### Consent changes

Explain that the number is also used for a registration Notification; joining
attempts one immediate iMessage from `noti@renai.im` without starting an AI
Conversation; a selected Persona later texts from `hi@renai.im`. Delivery is not
guaranteed. Replace “contact hi@renai.im” with “email hi@renai.im”. Update all three
languages under a new consent version at the Step 2 release.

## Relationship ending Notifications

- After a Persona or operator ends a relationship, send the relationship-ended
  notice and private Reselection link from `noti@renai.im` using `notify` and
  `notificationStatus`. The Persona's farewell remains on `hi@renai.im`.
- Persist the notice work with the ending, and record each attempt in the separate
  `ending_notification` ledger before submitting it. It never enters Persona
  message history or ordinary send reconciliation. Missing acknowledgements remain
  uncertain across restarts and never trigger automatic resubmission.
- Farewell failure or uncertainty does not block the Notification. Admin observes
  Notification receipts and can explicitly re-send a settled notice; uncertain
  attempts must be checked first. Blocking, removal, or completed Reselection
  suppresses further notices for the old relationship.
- The existing localized relationship-ended and Reselection copy uses the User's
  locale and explains that this address does not read replies. The Waitlist-only
  30-per-hour admission cap does not discard relationship-ending notices.
- A test handle's `/reset` is also a user-initiated Relationship ending. It sends
  the same Notice with copy that says the User requested the ending; it does not
  delete the User, reset their consent, or create a new Conversation automatically.

## Explicit exceptions and deferred work

- The new-Conversation marker remains prefixed to the new Persona's first bubble,
  so a change of Persona is visible in the shared `hi@` thread.
- No Selection Notification, keyword opt-out, reply inbox, number verification,
  retry UI or separate Apple Account is introduced here.
- Apple client presentation, unknown-sender filtering and link treatment depend
  on the recipient's device. A live test must confirm separation; the API cannot
  guarantee a particular iOS notification banner or thread arrangement.
