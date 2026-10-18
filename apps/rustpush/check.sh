#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p target
python3 check-gates.py
# Only owned source: the pinned Rustpush dependency prohibits rustfmt in its tree.
rustfmt --check --edition 2021 --config skip_children=true src/*.rs tests/*.rs build.rs
rust-code-analysis-cli -m -p src -p tests -p build.rs -O json -o target
python3 check-metrics.py
cargo clippy --locked --all-targets --no-deps -- -D warnings -D clippy::cognitive_complexity
# Cargo locks compilation, but coverage also cleans artifacts and reads them later.
python3 - <<'PY'
import fcntl
import json
import pathlib
import subprocess

metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--locked", "--no-deps", "--format-version", "1",
]))
build = pathlib.Path(metadata["build_directory"])
build.mkdir(parents=True, exist_ok=True)
with (build / ".coverage.lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    subprocess.run(["cargo", "llvm-cov", "--locked", "--json", "--output-path", "target/coverage.json"], check=True)
    subprocess.run(["python3", "check-coverage.py", "target/coverage.json"], check=True)
PY
