#!/usr/bin/env python3
"""Exercise native gates in an isolated fixture, without touching production source."""
import json
import pathlib
import shutil
import subprocess
import tempfile

source = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="rustpush-gates-") as temporary:
    repo = pathlib.Path(temporary)
    root = repo / "apps/rustpush"
    root.mkdir(parents=True)
    (repo / "quality-exceptions.json").write_text('{"coverage": []}')
    (root / "src").mkdir()
    (root / "target/src").mkdir(parents=True)
    for script in ("check-coverage.py", "check-metrics.py"):
        shutil.copy(source / script, root / script)
    owned = root / "src/owned.rs"
    owned.write_text("fn owned() {}\n")
    (root / "build.rs").write_text("fn main() {}\n")

    def check(script, expected, *args):
        result = subprocess.run(["python3", str(root / script), *args], capture_output=True)
        assert (result.returncode == 0) == expected, result.stderr.decode()

    def coverage(covered=1, count=1, include=True):
        summary = {key: {"covered": covered, "count": count}
                   for key in ("lines", "functions", "regions")}
        report = {"data": [{"files": [{"filename": str(owned), "summary": summary}]
                           if include else []}]}
        path = root / "coverage.json"
        path.write_text(json.dumps(report))
        return str(path)

    check("check-coverage.py", True, coverage())
    check("check-coverage.py", False, coverage(0))
    check("check-coverage.py", False, coverage(0, 0))
    check("check-coverage.py", False, coverage(include=False))
    (repo / "quality-exceptions.json").write_text(json.dumps({"coverage": [
        {"path": "apps/rustpush/src/owned.rs", "reason": "fixture: human-owned platform edge"}
    ]}))
    check("check-coverage.py", True, coverage(0))
    (repo / "quality-exceptions.json").write_text('{"coverage": []}')

    def metrics(cyclomatic=1, cognitive=0):
        report = {"metrics": {"cyclomatic": {"max": cyclomatic},
                              "cognitive": {"max": cognitive}}}
        for path in ("target/src/owned.rs.json", "target/build.rs.json"):
            (root / path).write_text(json.dumps(report))

    metrics(21, 21)
    check("check-metrics.py", True)
    metrics(22, 0)
    check("check-metrics.py", False)
    metrics(1, 22)
    check("check-metrics.py", False)
    metrics()
    owned.write_text("// line\n" * 499)
    check("check-metrics.py", True)
    owned.write_text("// line\n" * 500)
    check("check-metrics.py", False)
print("Native coverage, file-size and complexity gate self-checks passed")
