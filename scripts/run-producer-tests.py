#!/usr/bin/env python3
"""Run only the six frozen native producer witnesses; never infer a pass from exit 0."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import time

TESTS = (
    "native::client_actions::tests::direct_point_clicks::direct_point_original_fractional_tap_and_swipe_round_to_css_pixels",
    "native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_110_20_uses_midpoint",
    "native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_70_20_paces_three_moves_over_48_ms",
    "native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_70_20_cancel_after_first_move_releases_once",
    "native::client_actions::tests::pointer_original_down_swipe_800x600_waits_for_post_wheel_render_ack",
    "native::client_actions::tests::recording_first_start_failure_dispatch_disarms_without_stop_or_late_segment",
)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def select_harness(cargo_json, build_exit, manifest, target_dir):
    if build_exit.read_text().strip() != "0":
        raise ValueError("default-test-build did not finish with exit 0")
    rows = [json.loads(line) for line in cargo_json.read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get("reason") == "build-finished"]
    if len(finished) != 1 or finished[0].get("success") is not True:
        raise ValueError("need exactly one successful Cargo build-finished record")
    candidates = [row for row in rows if row.get("reason") == "compiler-artifact"
                  and row.get("target", {}).get("name") == "agent-browser"
                  and row.get("profile", {}).get("test") is True]
    if len(candidates) != 1:
        raise ValueError(f"need exactly one agent-browser test harness, got {len(candidates)}")
    artifact = candidates[0]
    if artifact.get("features") != [] or artifact["target"].get("kind") != ["bin"]:
        raise ValueError("harness must be the feature-free binary unit-test target")
    if artifact.get("manifest_path") != str(manifest.resolve()):
        raise ValueError("harness manifest does not match frozen native source")
    if artifact["target"].get("src_path") != str((manifest.parent / "src/main.rs").resolve()):
        raise ValueError("harness source is not the frozen cli/src/main.rs")
    executable = artifact.get("executable")
    if not isinstance(executable, str) or not Path(executable).is_absolute():
        raise ValueError("Cargo did not provide an absolute executable path")
    harness = Path(executable).resolve(strict=True)
    if harness.parent != (target_dir / "debug/deps").resolve():
        raise ValueError("test-profile harness must be inside the isolated target/debug/deps")
    if not harness.is_file() or not os.access(harness, os.X_OK):
        raise ValueError("Cargo harness is not an executable regular file")
    return harness, artifact


def execute(command, prefix, timeout, cwd):
    """Keep real stdout, stderr, return code and timeout state, including after failure."""
    save(Path(str(prefix) + ".command.json"), command)
    result = {"state": "not-started", "exit": None, "timed_out": False}
    start = time.monotonic()
    with Path(str(prefix) + ".stdout.log").open("w") as out, Path(str(prefix) + ".stderr.log").open("w") as err:
        try:
            with subprocess.Popen(command, cwd=cwd, stdout=out, stderr=err,
                                  start_new_session=True) as process:
                result["state"] = "started"
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    result["timed_out"] = True
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                result["exit"] = process.returncode
                result["state"] = "finished"
        except OSError as error:
            result["error"] = str(error)
    result["elapsed_seconds"] = round(time.monotonic() - start, 6)
    Path(str(prefix) + ".exit").write_text(str(result["exit"]) + "\n")
    save(Path(str(prefix) + ".result.json"), result)
    return result, Path(str(prefix) + ".stdout.log").read_text(errors="replace")


def listed_once(name, result, output):
    return (result["exit"] == 0 and not result["timed_out"]
            and [line for line in output.splitlines() if line]
            == [f"{name}: test", "1 test, 0 benchmarks"])


def passed_once(name, result, output):
    lines = output.splitlines()
    summaries = [line for line in lines if line.startswith("test result:")]
    outcomes = [line for line in lines if line.startswith("test ") and " ... " in line]
    running = [line for line in lines if line.startswith("running ")]
    return (result["exit"] == 0 and not result["timed_out"]
            and running == ["running 1 test"]
            and outcomes == [f"test {name} ... ok"]
            and len(summaries) == 1
            and re.fullmatch(r"test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; "
                             r"[0-9]+ filtered out; finished in [0-9]+(?:\.[0-9]+)?s", summaries[0])
            is not None)


def run(args):
    evidence = args.evidence_dir
    evidence.mkdir(parents=True, exist_ok=True)
    summary = {"scope": "six pure native producer witnesses only; not formal production acceptance",
               "profile": "test (dev-derived), no default features", "tests": [], "passed": False}
    for index, name in enumerate(TESTS, 1):
        row = {"name": name, "list": {"state": "not-run"}, "run": {"state": "not-run"}, "passed": False}
        summary["tests"].append(row)
        for phase in ("list", "run"):
            prefix = evidence / f"{index:02d}-{phase}"
            Path(str(prefix) + ".exit").write_text("not-run\n")
            Path(str(prefix) + ".stdout.log").write_text("")
            Path(str(prefix) + ".stderr.log").write_text("")
            save(Path(str(prefix) + ".result.json"), {"state": "not-run"})
    try:
        harness, artifact = select_harness(args.cargo_json, args.build_exit, args.manifest, args.target_dir)
        digest = sha256(harness)
        summary["harness"] = {"path": str(harness), "sha256_before": digest, "cargo_artifact": artifact}
        save(evidence / "harness.json", summary["harness"])
        # List all six first; failure on one does not erase evidence for the other five.
        for index, row in enumerate(summary["tests"], 1):
            command = [str(harness), row["name"], "--exact", "--list", "--format", "pretty", "--color", "never"]
            result, output = execute(command, evidence / f"{index:02d}-list", args.timeout_seconds, args.manifest.parent)
            row["list"] = {**result, "unique_match": listed_once(row["name"], result, output)}
        for index, row in enumerate(summary["tests"], 1):
            if not row["list"]["unique_match"]:
                row["run"]["reason"] = "exact list did not prove one test"
                continue
            command = [str(harness), row["name"], "--exact", "--test-threads=1", "--format", "pretty", "--color", "never"]
            result, output = execute(command, evidence / f"{index:02d}-run", args.timeout_seconds, args.manifest.parent)
            row["run"] = result
            row["passed"] = passed_once(row["name"], result, output)
        summary["harness"]["sha256_after"] = sha256(harness)
        summary["passed"] = (summary["harness"]["sha256_after"] == digest
                             and len(summary["tests"]) == 6 and all(row["passed"] for row in summary["tests"]))
    except (OSError, ValueError, TypeError, KeyError) as error:
        summary["error"] = str(error)
    finally:
        save(evidence / "summary.json", summary)
    print(json.dumps({"passed": summary["passed"], "passed_tests": sum(row["passed"] for row in summary["tests"]),
                      "summary": str(evidence / "summary.json"), "error": summary.get("error")}))
    return 0 if summary["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cargo-json", "build-exit", "manifest", "target-dir", "evidence-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    args = parser.parse_args()
    if not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0:
        parser.error("timeout must be finite and greater than zero")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
