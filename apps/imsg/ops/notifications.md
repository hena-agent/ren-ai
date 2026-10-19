# Provision and verify the Notification handle

This is the attended boundary between the Mac capability release and the later
Discovery release. Do not enable join Notifications until the checks below pass.
Record the full artifact revision and results in the rollout issue. An uploaded
artifact alone does not prove that the Mac installed it or that the tunnel routes
to it.

## 1. Install the Mac capability

Let the existing updater install the completed `main` artifact containing
[ADR-0020](../../../docs/adr/0020-notifications-come-from-noti-renai-im.md). Verify
the local service using its installed verifier:

```sh
ROOT="${MESSAGING_HOME:-/usr/local/lib/ren-ai-messaging}"
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" "$ROOT/verify.js"
IMSG_URL=https://imsg.renai.im/rpc "$ROOT/bin/bun" --env-file="$ROOT/imsg.env" "$ROOT/verify.js"
```

Both probes must identify `imsg` at the exact installed artifact revision. At this
stage overall health can be `ready` while `dependencies.notifications` is
`degraded`: the Notification alias is optional for installation, and existing
Persona messaging continues. `dependencies.messages` must be `ready`.

## 2. Add the alias to the existing Apple Account

1. Sign in to the Apple Account already holding `hi@renai.im`. In iCloud+ Custom
   Email Domain settings for `renai.im`, create **noti@renai.im** for that same
   account. See Apple's [custom-domain address instructions](https://support.apple.com/guide/icloud/mm11db96ba8e/icloud).
   Creating a DNS record or an email-forwarding rule alone is not iMessage
   registration.
2. Complete any Apple verification needed to make the address available to
   iMessage. Check the account's Messages Send & Receive settings. Rustpush chooses
   the sender explicitly; changing Messages' “Start New Conversations From” is not
   the transport configuration.
3. Allow IDS to refresh registration. Inspect authenticated health again. If the
   alias remains unavailable and attended reauthentication is necessary, use the
   [existing recovery procedure](README.md#durability-and-recovery): stop the
   gateway before `ren-rustpush login`, then restart it. Never run a second bridge
   against its Apple state.

Both addresses share account-level restrictions. This change does not move the
service to a separate Apple Account.

## 3. Require Notification readiness locally and publicly

Run this from the installed home with the expected full source SHA. It sends no
message and prints only health metadata. Run once with the local URL, then with
the public URL:

```sh
export EXPECTED_REVISION='FULL_SOURCE_COMMIT_FROM_THE_INSTALLED_ARTIFACT'
export IMSG_URL='http://127.0.0.1:4702/rpc'
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" --eval '
const response = await fetch(new URL("/health", process.env.IMSG_URL), {
  headers: { Authorization: `Bearer ${process.env.IMSG_TOKEN}` },
  redirect: "manual", signal: AbortSignal.timeout(4000),
});
const health = await response.json();
if (response.status !== 200 || health.service !== "imsg" ||
    health.revision !== process.env.EXPECTED_REVISION ||
    health.status !== "ready" || health.dependencies?.messages !== "ready" ||
    health.dependencies?.notifications !== "ready") throw new Error("Notification readiness not verified");
console.log(health);
'
```

Repeat with `IMSG_URL=https://imsg.renai.im/rpc`. Both dependencies must be `ready`
at the same expected revision. Do not infer alias readiness from the ordinary
updater probe's HTTP 200 alone.

## 4. Send one attended test Notification

Use an operator-controlled test handle, preferably on another Apple Account.
Choose that recipient explicitly. This command submits exactly one real iMessage;
do not repeat it after a timeout or unclear result.

```sh
read -r 'NOTIFICATION_TEST_HANDLE?Test iMessage phone number, including country code: '
export NOTIFICATION_TEST_HANDLE
export IMSG_URL='https://imsg.renai.im/rpc'
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" --eval '
const response = await fetch(process.env.IMSG_URL, {
  method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.IMSG_TOKEN}`, "Content-Type": "application/ndjson" },
  body: JSON.stringify({ _tag: "Request", id: "0", tag: "notify", headers: [],
    payload: { handle: process.env.NOTIFICATION_TEST_HANDLE,
      text: "[Ren AI] Notification handle test. Replies to this address are not read." } }) + "\n",
});
if (!response.ok) throw new Error(`RPC HTTP ${response.status}; do not resubmit`);
console.log(await response.text());
'
```

Retain the returned `guid` and `requestId` privately. A successful RPC response
does not prove delivery. Query `notificationStatus` with `{guid}` using the same
authenticated NDJSON envelope (a read-only call). `sent` means native acceptance;
`delivered` means a receipt arrived. `pending` includes uncertainty and an unknown
GUID. `failed` is definitive for this attempt; error 22 is not proof that the
recipient lacks iMessage. Never call `sendText` as a Notification fallback.

## 5. Live acceptance

- On the recipient's device, confirm the test arrived **from noti@renai.im** and
  is visibly separate from the existing **hi@renai.im** Persona thread. Inspect
  the actual addresses, since contact grouping can affect Apple's presentation.
- Reply to the Notification, including a test photo. It must cause no Persona
  response, no new Conversation or intake row, no persistent downloaded attachment
  for that reply, and no message row in either SQLite ledger. A sender may still
  see “Delivered”; there is no read, typing, reaction, automatic reply or STOP action.
- Send to the existing Persona thread. Verify the normal reply and gestures still
  use `hi@renai.im`; Notification sends and replies must not appear in Persona
  history or change the latest Persona-message status.
- Restart the gateway in an attended window, then read the test GUID with
  `notificationStatus`. Its state survives and no Notification is resubmitted.
- Repeat exact-revision local and public readiness checks after any restart or
  account refresh. Record the observed sender/thread and receipt behavior.

Keep `notifications.sqlite` and its WAL with the private installation backup, just
like `history.sqlite`. Do not publish phone numbers, message content, Apple state
or credentials in the rollout issue. Once these checks pass, proceed to the
separately scoped Discovery/API/Admin release in [the spec](../../../docs/specs/notifications.md).
