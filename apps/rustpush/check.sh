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
cargo llvm-cov --locked --json --output-path target/coverage.json
python3 check-coverage.py target/coverage.json
