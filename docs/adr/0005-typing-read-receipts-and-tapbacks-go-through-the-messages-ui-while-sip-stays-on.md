# Typing, read receipts and tapbacks go through Messages' UI while SIP stays on

With SIP on, the only way to show typing, send read receipts or send a tapback is to drive Messages' UI. imsg's own `typing` and `read`, and tapbacks on a chosen message, need its injected helper, and the helper needs SIP off.

So for the testing period the server scripts the UI:

- it types into the conversation's composer to show typing;
- it brings a conversation into view to mark it read;
- it uses `imsg react` for tapbacks, which can only hit the latest message.

These run one at a time across all conversations, and after each one the server parks Messages on a neutral view. All of it is best-effort: messages still go out through imsg's send, which needs no UI. When traffic outgrows one-at-a-time UI automation, the plan is to disable SIP and move these actions to imsg's helper.

## Considered Options

- **Disable SIP now.** Typing, receipts and targeted tapbacks would work without the UI or a shared lock. But it means rebooting into Recovery on a Mac that holds the owner's personal Apple Account and weakening its security, for a helper that imsg's own docs call unreliable on macOS 26. Deferred until traffic needs it.

## Consequences

- Typing, read receipts and tapbacks sit behind one seam, so the helper can replace the UI adapter without touching the persona's tools.
- The Mac must stay awake and unlocked with Messages' window open, because display sleep locks it at once.
- Messages' "Send read receipts" is on, so anything that uncovers a conversation can mark it read. Parking the UI after each action keeps that from happening before the persona chooses.
- Whether another account's iPhone shows the typing indicator is still unverified, because the probe that would check it is on hold.
