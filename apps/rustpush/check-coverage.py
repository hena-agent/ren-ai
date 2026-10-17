#!/usr/bin/env python3
"""Fail closed on incomplete coverage of every owned production Rust file."""
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
report = json.loads(pathlib.Path(sys.argv[1]).read_text())
files = {
    pathlib.Path(file["filename"]).resolve(): file["summary"]
    for data in report["data"]
    for file in data["files"]
}
failures = []
for source in sorted((root / "src").glob("*.rs")):
    if source.stem.endswith("_tests"):
        continue
    summary = files.get(source, {})
    for metric in ("lines", "functions", "regions"):
        counts = summary.get(metric, {})
        if not counts.get("count") or counts.get("covered") != counts.get("count"):
            failures.append(f"{source.name}: {metric} {counts.get('covered', 0)}/{counts.get('count', 0)}")
if failures:
    print("Native coverage requires 100% per file:\n" + "\n".join(failures), file=sys.stderr)
    sys.exit(1)
