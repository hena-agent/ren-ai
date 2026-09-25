#!/bin/bash
# Stream imsg watch output, prefixing each line with the local time it arrived.
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"
imsg watch --json --reactions --attachments 2>>"$OUT/watch.stderr" |
  perl -MTime::HiRes=time -MPOSIX=strftime -ne 'BEGIN { $| = 1 } my $t = time; printf "%s.%03d\t%s", strftime("%Y-%m-%dT%H:%M:%S", localtime $t), ($t - int $t) * 1000, $_' \
    >>"$OUT/watch.ndjson"
