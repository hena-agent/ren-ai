#!/usr/bin/env python3
"""Enforce the repository's file-size and complexity limits on owned Rust."""
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
sources = sorted((root / "src").glob("*.rs")) + sorted((root / "tests").glob("*.rs")) + [root / "build.rs"]
failures = []
for source in sources:
    relative = source.relative_to(root)
    lines = len(source.read_text().splitlines())
    if lines >= 500:
        failures.append(f"{relative}: {lines} lines (requires < 500)")
    report = json.loads((root / "target" / f"{relative}.json").read_text())
    for metric in ("cyclomatic", "cognitive"):
        maximum = report["metrics"][metric]["max"]
        if maximum >= 22:
            failures.append(f"{relative}: {metric} {maximum} (requires < 22)")
if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
