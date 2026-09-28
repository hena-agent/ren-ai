#!/bin/bash
# MANUAL ONLY on the Mac mini, from the signed Bun/terminal with Accessibility,
# Automation (Messages and System Events), and Full Disk Access grants.
# Arrange a consenting test Conversation on a DIFFERENT Apple Account; send it a
# new inbound message first. Set Messages > Settings > iMessage > Send read receipts.
# Usage: bash packages/api-msg.hena.dev/src/gestures/smoke.sh <test-handle> <chat-id> <tapback>
# The tapback WILL be sent on the latest bubble; never use a personal chat.
set -euo pipefail
if [[ $# != 3 ]]; then echo "Usage: $0 <test-handle> <chat-id> <love|like|dislike|laugh|emphasis|question>" >&2; exit 2; fi
handle=$1 chat=$2 tapback=$3
[[ $chat =~ ^[1-9][0-9]*$ ]] || { echo 'A numeric test chat ID is required' >&2; exit 2; }
[[ $tapback =~ ^(love|like|dislike|laugh|emphasis|question)$ ]] || { echo 'Invalid tapback' >&2; exit 2; }
script="$(dirname "$0")/messages-ui.applescript"
echo "This will type (but NOT send) a draft, mark $handle read, and SEND $tapback to chat $chat."
read -r -p 'Confirm the test chat ID matches this handle, and type YES to proceed: ' answer
[[ $answer == YES ]] || exit 1
url="sms://open?groupid=$(HANDLE="$handle" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["HANDLE"],safe=""))')"
trap 'osascript "$script" clear "$url" >/dev/null 2>&1 || :; osascript "$script" park >/dev/null 2>&1 || :' EXIT
osascript "$script" ensure
osascript "$script" open "$url"
for char in t y p i n g; do osascript "$script" key "$char"; done
echo 'Check that the other device shows typing; no message will be sent.'
sleep 5
osascript "$script" clear "$url"
osascript "$script" park
read -r -p 'Ready to mark the test message read? Type YES: ' answer
[[ $answer == YES ]] || exit 1
osascript "$script" ensure
osascript "$script" read "$url"
osascript "$script" park
echo 'Check the other device for a read receipt. Next step actually sends a tapback.'
read -r -p 'Type YES to send the test tapback: ' answer
[[ $answer == YES ]] || exit 1
osascript "$script" ensure
imsg react --chat-id "$chat" --reaction "$tapback" --json
osascript "$script" park
echo 'Verify the tapback on the other device; inspect the chat if imsg reported uncertainty. Do not blindly retry.'
