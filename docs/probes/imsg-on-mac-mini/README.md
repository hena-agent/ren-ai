# imsg probe scripts

Throwaway tooling from [Probe imsg on the Mac mini](https://github.com/hena-agent/ren-ai/issues/2), run on chris-mini (macOS 26.6.2, SIP on, imsg 0.15.9) on 2026-09-25. The findings are in that issue's resolution.

Run these from a process that holds the grants they need:

- **Full Disk Access** for every script that reads `chat.db`.
- **Automation → Messages** for sends.
- **Automation → System Events** and **Accessibility** for `react` and the typing test.

macOS attributes the grants to the launchd-started parent (the "responsible process"), not to imsg. The scripts need `sqlite3`, `jq`, and `gdate` (Homebrew coreutils). They write to `./out/`.

| Script                                           | What it does                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `snap.sh [min_rowid]`                            | Prints chat, handle, and message rows from `chat.db`, with delivered, read, edited, and retracted times.                              |
| `send-probe.sh <label> <handle> <text>`          | Times one `imsg send --service imessage --no-sms-fallback --json`, then logs every change to the new rows (`POLL_SECS`, default 120). |
| `watch.sh`                                       | Runs `imsg watch --json --reactions --attachments` and prefixes each line with the local time it arrived.                             |
| `react-probe.sh <label> <chat_id> <reaction>`    | Times one `imsg react` and shows the tapback row it wrote, if any.                                                                    |
| `read-monitor.sh <rowid> [secs]`                 | Logs changes to an outgoing row's `is_read` and `date_read`.                                                                          |
| `lock-log.sh`                                    | Logs screen-lock changes once a second.                                                                                               |
| `typing-test.applescript <sms://open?groupid=…>` | Types "typing test" into that conversation's composer, holds it for 8 s, then clears it without sending.                              |

In zsh, `log` is a builtin. Call `/usr/bin/log` to read Messages' unified logs.
