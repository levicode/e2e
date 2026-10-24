#!/usr/bin/env python3
"""Exact failed-worker RED/GREEN witnesses, adapted from run-producer-tests.py."""
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

RED_TEST = "native::client_enrollment::tests::service_worker_failed_retired_waits_for_applied_detach_without_poison"
RED_ASSERTION = "joined failed startup must remain pending until exact detach applies; failure="
RED_PANIC_FILE = "src/native/client_enrollment.rs"
RED_PANIC_LINE = 12800
GREEN_TESTS = tuple("native::" + module + "::tests::" + name for module, names in (
    ("cdp::client", (
        "service_worker_startup_serial_enables_cannot_reach_resume_without_ack",
        "service_worker_startup_submits_in_order_then_joins_every_real_ack",
        "service_worker_startup_submission_failure_drains_sent_command_without_resume",
        "service_worker_startup_checks_session_owner_retirement_and_original_deadline",
        "service_worker_startup_cancel_drop_or_deadline_preserves_debt_until_late_acks",
        "service_worker_startup_deadline_does_not_wait_for_pending_cleanup_lock",
        "service_worker_startup_exact_detach_creates_retired_candidate_without_an_ack",
        "service_worker_retirement_malformed_or_unverified_reply_is_not_an_error_ack_or_retirement",
        "service_worker_retirement_wrong_session_ancestor_or_target_destroyed_is_insufficient",
        "service_worker_retirement_final_consumer_rechecks_original_owner_generation_and_bound",
        "service_worker_retirement_final_lock_rechecks_operation_and_bootstrap_bounds",
        "service_worker_all_ack_final_lock_rechecks_operation_and_bootstrap_bounds",
        "service_worker_all_ack_consumer_rejects_owner_replaced_while_waiting",
        "service_worker_all_ack_reader_publication_retains_startup_receipt",
        "service_worker_other_owned_publication_rechecks_normal_ready",
        "service_worker_retired_reader_publication_retains_original_proof",
        "service_worker_publication_wait_preserves_bounds_and_owner",
        "service_worker_startup_connection_loss_does_not_prove_worker_retirement",
        "service_worker_startup_replacement_detach_cannot_settle_original_owner_debt",
        "service_worker_failed_terminal_preserves_errors_and_refuses_ready_authority",
        "service_worker_startup_error_ack_is_not_pardoned_by_sibling_detachment",
    )),
    ("client_enrollment", (
        "service_worker_ready_exact_detach_before_commit_keeps_owner_healthy",
        "service_worker_ready_exact_detach_cancel_before_commit_remains_failure",
        "service_worker_failed_retired_waits_for_applied_detach_without_poison",
        "service_worker_detach_rejects_conflicting_target_identity",
        "service_worker_failed_terminal_target_destroyed_alone_fails_promptly",
        "service_worker_error_ack_never_reaches_ready_commit_gate",
        "service_worker_retirement_waits_for_applied_detach_without_publishing_ready",
        "service_worker_enrollment_joins_observers_after_resume_in_fixed_order",
        "service_worker_enrollment_main_script_policy_runs_before_observer_acks",
        "service_worker_enrollment_fetch_failure_never_resumes",
        "service_worker_enrollment_observer_failure_never_publishes_ready",
    )),
    ("client_targets", (
        "service_worker_retirement_requires_exact_detach_and_absent_original_tenure",
        "service_worker_startup_keeps_configuration_false_until_complete",
        "service_worker_startup_refuses_wrong_kind_session_and_retired_owner",
        "service_worker_startup_drop_cannot_publish_ready",
        "service_worker_startup_same_id_replacement_rejects_old_permit",
        "service_worker_startup_replacement_while_waiting_is_rejected",
        "service_worker_startup_capacity_failure_does_not_set_pending",
        "service_worker_startup_waits_for_protected_read_without_setting_configured",
    )),
) for name in names)


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
    """Preserve every command and result; kill/reap only its newly owned process group."""
    save(Path(str(prefix) + ".command.json"), command)
    result = {"state": "not-started", "exit": None, "timed_out": False}
    start = time.monotonic()
    with Path(str(prefix) + ".stdout.log").open("w") as out, Path(str(prefix) + ".stderr.log").open("w") as err:
        try:
            with subprocess.Popen(command, cwd=cwd, stdout=out, stderr=err, start_new_session=True) as process:
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
    return (result["exit"] == 0 and not result["timed_out"] and
            [line for line in output.splitlines() if line] == [f"{name}: test", "1 test, 0 benchmarks"])


def passed_once(name, result, output):
    lines = output.splitlines()
    summaries = [line for line in lines if line.startswith("test result:")]
    outcomes = [line for line in lines if line.startswith("test ") and " ... " in line]
    running = [line for line in lines if line.startswith("running ")]
    return (result["exit"] == 0 and not result["timed_out"] and running == ["running 1 test"]
            and outcomes == [f"test {name} ... ok"] and len(summaries) == 1
            and re.fullmatch(r"test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; "
                             r"[0-9]+ filtered out; finished in [0-9]+(?:\.[0-9]+)?s", summaries[0]) is not None)


def failed_once(name, result, output, stderr):
    """Only the single intended RED assertion is an accepted failing witness."""
    lines = output.splitlines()
    summaries = [line for line in lines if line.startswith("test result:")]
    outcomes = [line for line in lines if line.startswith("test ") and " ... " in line]
    running = [line for line in lines if line.startswith("running ")]
    combined = output + "\n" + stderr
    headers = re.findall(r"(?m)^thread '[^']+'(?: \([0-9]+\))? panicked at [^\n]+$", combined)
    location = re.escape(RED_PANIC_FILE) + ":" + str(RED_PANIC_LINE) + r":[0-9]+:"
    intended = len(headers) == 1 and re.fullmatch(
        r"thread '" + re.escape(name) + r"'(?: \([0-9]+\))? panicked at " + location, headers[0]) is not None
    tail = combined.split(headers[0] + "\n", 1)[1] if intended and headers[0] + "\n" in combined else ""
    message = next(iter(tail.splitlines()), "")
    return (result["exit"] == 101 and not result["timed_out"] and running == ["running 1 test"]
            and outcomes == [f"test {name} ... FAILED"] and len(summaries) == 1
            and re.fullmatch(r"test result: FAILED\. 0 passed; 1 failed; 0 ignored; 0 measured; "
                             r"[0-9]+ filtered out; finished in [0-9]+(?:\.[0-9]+)?s", summaries[0]) is not None
            and intended and message.startswith(RED_ASSERTION) and combined.count("panicked at") == 1)


def run(args):
    tests = (RED_TEST,) if args.phase == "red" else GREEN_TESTS
    evidence = args.evidence_dir
    evidence.mkdir(parents=True, exist_ok=True)
    summary = {"scope": "failed-worker exact native regression only; not formal acceptance", "phase": args.phase,
               "expected": "one intended assertion failure (101)" if args.phase == "red" else "40 exact passes",
               "test_inventory": list(tests), "profile": "test (dev-derived), no default features",
               "tests": [], "accepted": False}
    for index, name in enumerate(tests, 1):
        row = {"name": name, "list": {"state": "not-run"}, "run": {"state": "not-run"}, "accepted": False}
        summary["tests"].append(row)
        for phase in ("list", "run"):
            prefix = evidence / f"{index:02d}-{phase}"
            for suffix, content in (("exit", "not-run\n"), ("stdout.log", ""), ("stderr.log", "")):
                Path(str(prefix) + "." + suffix).write_text(content)
            save(Path(str(prefix) + ".result.json"), {"state": "not-run"})
    try:
        if len(tests) != len(set(tests)) or not tests:
            raise ValueError("test inventory must be nonempty and unique")
        harness, artifact = select_harness(args.cargo_json, args.build_exit, args.manifest, args.target_dir)
        digest = sha256(harness)
        summary["harness"] = {"path": str(harness), "sha256_before": digest, "cargo_artifact": artifact}
        save(evidence / "harness.json", summary["harness"])
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
            stderr = (evidence / f"{index:02d}-run.stderr.log").read_text(errors="replace")
            row["accepted"] = (failed_once(row["name"], result, output, stderr) if args.phase == "red"
                               else passed_once(row["name"], result, output))
            row["outcome"] = ("failed-as-expected" if args.phase == "red" else "passed") if row["accepted"] else "invalid-witness"
        summary["harness"]["sha256_after"] = sha256(harness)
        summary["accepted"] = summary["harness"]["sha256_after"] == digest and all(row["accepted"] for row in summary["tests"])
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        summary["error"] = str(error)
    finally:
        save(evidence / "summary.json", summary)
    print(json.dumps({"accepted": summary["accepted"], "accepted_witnesses": sum(row["accepted"] for row in summary["tests"]),
                      "summary": str(evidence / "summary.json"), "error": summary.get("error")}))
    return 0 if summary["accepted"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cargo-json", "build-exit", "manifest", "target-dir", "evidence-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--phase", choices=("red", "green"), required=True)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    args = parser.parse_args()
    if not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0:
        parser.error("timeout must be finite and greater than zero")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
