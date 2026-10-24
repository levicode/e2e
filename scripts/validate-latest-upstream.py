#!/usr/bin/env python3
"""Bounded CI receipts and immutable-source checks. No browser/install helper."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

EVIDENCE = Path(os.environ.get("EVIDENCE_DIR", "."))
ACTIVE_GROUPS = set()


def terminate_owned(signum, _frame):
    for group in tuple(ACTIVE_GROUPS):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)



def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def execute(name, seconds, command):
    """Keep the real exit and timeout; reap only this command's owned process group."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {"command": command, "exit": None, "timed_out": False}
    save(EVIDENCE / f"{name}.command.json", command)
    started = time.monotonic()
    with (EVIDENCE / f"{name}.stdout.log").open("w") as out, (EVIDENCE / f"{name}.stderr.log").open("w") as err:
        try:
            with subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True) as process:
                ACTIVE_GROUPS.add(process.pid)
                try:
                    process.wait(timeout=seconds)
                except subprocess.TimeoutExpired:
                    result["timed_out"] = True
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    # The immediate parent may have exited while descendants
                    # ignored TERM. Escalate the still-owned group regardless.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                finally:
                    ACTIVE_GROUPS.discard(process.pid)
                result["exit"] = process.returncode
        except OSError as error:
            result["error"] = str(error)
        except (SystemExit, KeyboardInterrupt) as error:
            result["interrupted"] = True
            result["exit"] = error.code if isinstance(error, SystemExit) else 130
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    status = 124 if result["timed_out"] else result["exit"]
    if status is None:
        status = 127
    (EVIDENCE / f"{name}.exit").write_text(f"{status}\n")
    save(EVIDENCE / f"{name}.result.json", result)
    for kind in ("stdout", "stderr"):
        print((EVIDENCE / f"{name}.{kind}.log").read_text(errors="replace"), end="", flush=True)
    print(f"{name}: exit={status}; timed_out={result['timed_out']}", flush=True)
    if result.get("interrupted"):
        raise SystemExit(status)
    return status


def identity(root, sha, tree, lock, lock_sha):
    root = Path(root).resolve()
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
    actual = {"sha": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}"),
              "status": git("status", "--porcelain", "--untracked-files=all"),
              "ignored": git("ls-files", "--others", "--ignored", "--exclude-standard").splitlines()}
    if lock != "-":
        actual["lock_sha256"] = digest(root / lock)
    print(json.dumps(actual, indent=2))
    assert re.fullmatch(r"[0-9a-f]{40}", sha), "unfrozen commit pin"
    assert actual["sha"] == sha and not actual["status"], "source commit/worktree mismatch"
    assert tree == "-" or actual["tree"] == tree, "source tree mismatch"
    assert lock == "-" or actual["lock_sha256"] == lock_sha, "lock digest mismatch"


def binding():
    for name in ("NATIVE_SHA", "NATIVE_TREE", "E2E_SHA", "E2E_TREE"):
        assert re.fullmatch(r"[0-9a-f]{40}", os.environ[name]), f"unfrozen {name}"
    for name in ("NATIVE_LOCK_SHA256", "E2E_LOCK_SHA256"):
        assert re.fullmatch(r"[0-9a-f]{64}", os.environ[name]), f"unfrozen {name}"
    assert os.environ["SEMANTIC_TESTS_FROZEN"] == "yes", "semantic witness list is not frozen"
    print(json.dumps({key: os.environ[key] for key in ("NATIVE_SHA", "NATIVE_TREE", "NATIVE_LOCK_SHA256", "E2E_SHA", "E2E_TREE", "E2E_LOCK_SHA256")}))


def aggregate(names):
    states = {name: ((EVIDENCE / f"{name}.exit").read_text().strip() if (EVIDENCE / f"{name}.exit").exists() else "missing") for name in names}
    result = {"accepted": all(status == "0" for status in states.values()), "phases": states,
              "scope": "compile/unit/artifact only; not installed-browser, source-retirement, acceptance, promotion or release"}
    save(EVIDENCE / "aggregate.json", result)
    print(json.dumps(result, indent=2))
    assert result["accepted"], "failed, timed-out, skipped or missing gate"


# Frozen requirement: 40 SW + 6 producer + 15 upstream semantic/handshake
# witnesses. Every selected witness must actually pass, never skip.
REQUIRED_TESTS = """native::cdp::client::tests::service_worker_startup_serial_enables_cannot_reach_resume_without_ack
native::cdp::client::tests::service_worker_startup_submits_in_order_then_joins_every_real_ack
native::cdp::client::tests::service_worker_startup_submission_failure_drains_sent_command_without_resume
native::cdp::client::tests::service_worker_startup_checks_session_owner_retirement_and_original_deadline
native::cdp::client::tests::service_worker_startup_cancel_drop_or_deadline_preserves_debt_until_late_acks
native::cdp::client::tests::service_worker_startup_deadline_does_not_wait_for_pending_cleanup_lock
native::cdp::client::tests::service_worker_startup_exact_detach_creates_retired_candidate_without_an_ack
native::cdp::client::tests::service_worker_retirement_malformed_or_unverified_reply_is_not_an_error_ack_or_retirement
native::cdp::client::tests::service_worker_retirement_wrong_session_ancestor_or_target_destroyed_is_insufficient
native::cdp::client::tests::service_worker_retirement_final_consumer_rechecks_original_owner_generation_and_bound
native::cdp::client::tests::service_worker_retirement_final_lock_rechecks_operation_and_bootstrap_bounds
native::cdp::client::tests::service_worker_all_ack_final_lock_rechecks_operation_and_bootstrap_bounds
native::cdp::client::tests::service_worker_all_ack_consumer_rejects_owner_replaced_while_waiting
native::cdp::client::tests::service_worker_all_ack_reader_publication_retains_startup_receipt
native::cdp::client::tests::service_worker_other_owned_publication_rechecks_normal_ready
native::cdp::client::tests::service_worker_retired_reader_publication_retains_original_proof
native::cdp::client::tests::service_worker_publication_wait_preserves_bounds_and_owner
native::cdp::client::tests::service_worker_startup_connection_loss_does_not_prove_worker_retirement
native::cdp::client::tests::service_worker_startup_replacement_detach_cannot_settle_original_owner_debt
native::cdp::client::tests::service_worker_failed_terminal_preserves_errors_and_refuses_ready_authority
native::cdp::client::tests::service_worker_startup_error_ack_is_not_pardoned_by_sibling_detachment
native::client_enrollment::tests::service_worker_ready_exact_detach_before_commit_keeps_owner_healthy
native::client_enrollment::tests::service_worker_ready_exact_detach_cancel_before_commit_remains_failure
native::client_enrollment::tests::service_worker_failed_retired_waits_for_applied_detach_without_poison
native::client_enrollment::tests::service_worker_detach_rejects_conflicting_target_identity
native::client_enrollment::tests::service_worker_failed_terminal_target_destroyed_alone_fails_promptly
native::client_enrollment::tests::service_worker_error_ack_never_reaches_ready_commit_gate
native::client_enrollment::tests::service_worker_retirement_waits_for_applied_detach_without_publishing_ready
native::client_enrollment::tests::service_worker_enrollment_joins_observers_after_resume_in_fixed_order
native::client_enrollment::tests::service_worker_enrollment_main_script_policy_runs_before_observer_acks
native::client_enrollment::tests::service_worker_enrollment_fetch_failure_never_resumes
native::client_enrollment::tests::service_worker_enrollment_observer_failure_never_publishes_ready
native::client_targets::tests::service_worker_retirement_requires_exact_detach_and_absent_original_tenure
native::client_targets::tests::service_worker_startup_keeps_configuration_false_until_complete
native::client_targets::tests::service_worker_startup_refuses_wrong_kind_session_and_retired_owner
native::client_targets::tests::service_worker_startup_drop_cannot_publish_ready
native::client_targets::tests::service_worker_startup_same_id_replacement_rejects_old_permit
native::client_targets::tests::service_worker_startup_replacement_while_waiting_is_rejected
native::client_targets::tests::service_worker_startup_capacity_failure_does_not_set_pending
native::client_targets::tests::service_worker_startup_waits_for_protected_read_without_setting_configured
native::client_actions::tests::pointer_original_down_swipe_800x600_waits_for_post_wheel_render_ack
native::client_actions::tests::recording_first_start_failure_dispatch_disarms_without_stop_or_late_segment
native::client_actions::tests::direct_point_clicks::direct_point_original_fractional_tap_and_swipe_round_to_css_pixels
native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_110_20_uses_midpoint
native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_70_20_paces_three_moves_over_48_ms
native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_70_20_cancel_after_first_move_releases_once
native::client_observation::composition_tests::union_is_plain_and_composable_even_with_exact_label_visible_branches
native::client_observation::composition_tests::union_frame_paths_are_exact_and_stripped_before_matching
native::client_observation::composition_tests::union_validates_both_branches_without_weakening_syntax_or_depth_limits
native::client_observation::composition_tests::union_admission_counts_all_occurrences_at_the_shared_node_budget
native::client_observation::tests::effective_presentation_role_preserves_native_controls_and_implicit_tags
native::client_observation::tests::ignored_presentation_restores_controls_even_when_ax_omits_the_receiver
native::client_observation::tests::decorative_image_fact_only_changes_implicit_image_semantics
native::client_observation::tests::ignored_presentation_uses_bounded_header_neighbor_fact_without_ax
native::client_observation::tests::ignored_presentation_header_fallback_preserves_single_cell_suppression
native::client_observation::author_projection::tests::offered_choices_flatten_groups_and_cap_after_exclusions_per_select
native::client_observation::author_projection::tests::closed_details_exclusion_precedes_the_offered_choice_budget
native::client_observation::author_projection::tests::offered_choices_use_native_light_ownership_and_do_not_publish_option_children
native::client_observation_dispatch::composition_tests::unsupported_composition_never_dispatches_cdp_or_stages_references
native::client_browser::tests::candidate_advertises_the_complete_wired_public_contract
native::daemon::tests::client_session_negotiation_preserves_legacy_and_excludes_mutation""".splitlines()


def cargo_artifacts(name):
    assert (EVIDENCE / f"{name}.exit").read_text().strip() == "0", "Cargo gate did not pass"
    rows = [json.loads(line) for line in (EVIDENCE / f"{name}.stdout.log").read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get("reason") == "build-finished"]
    assert len(finished) == 1 and finished[0].get("success") is True
    return [row for row in rows if row.get("reason") == "compiler-artifact" and row.get("executable")]


def native_tests():
    deadline = time.monotonic() + 2100
    def budget(maximum):
        remaining = int(deadline - time.monotonic())
        assert remaining > 0, "overall default-test deadline exhausted"
        return min(maximum, remaining)
    root = Path.cwd().resolve()
    target = Path(os.environ["CARGO_TARGET_DIR"]).resolve()
    artifacts = [row for row in cargo_artifacts("default-no-run") if row.get("profile", {}).get("test") is True]
    assert artifacts and len({row["executable"] for row in artifacts}) == len(artifacts)
    assert {row["target"]["name"] for row in artifacts} == {"agent-browser", "dashboard_cli", "doctor_cli", "obscura_cli", "pin_tab_cli", "tls_cli"}, "default harness set changed"
    assert sum(row["target"]["name"] == "agent-browser" for row in artifacts) == 1
    required_seen, results = set(), []
    for row in artifacts:
        name = row["target"]["name"]
        assert re.fullmatch(r"[A-Za-z0-9_-]+", name)
        binary = Path(row["executable"]).resolve(strict=True)
        assert row["manifest_path"] == str(root / "Cargo.toml") and row["features"] == []
        assert row["target"]["kind"] in (["bin"], ["test"])
        assert row["profile"]["opt_level"] == "3" and row["profile"]["debug_assertions"] is False
        assert binary.parent == target / "ci/deps" and binary.is_file() and os.access(binary, os.X_OK)
        before = digest(binary)
        listed = execute(f"list-{name}", budget(60), [str(binary), "--list", "--format", "pretty", "--color", "never"])
        listing = (EVIDENCE / f"list-{name}.stdout.log").read_text()
        inventory = re.findall(r"(?m)^(.+): test$", listing)
        assert listed == 0 and len(inventory) == len(set(inventory)), "invalid harness inventory"
        # Empty or entirely ignored original integration harnesses remain visible,
        # but they cannot satisfy required unit coverage.
        status = execute(f"tests-{name}", budget(1500), [str(binary), "--test-threads=1", "--format", "pretty", "--color", "never"])
        output = (EVIDENCE / f"tests-{name}.stdout.log").read_text()
        outcomes = re.findall(r"(?m)^test (\S+) \.\.\. (ok|ignored(?:, [^\n]*)?|FAILED)$", output)
        summaries = re.findall(r"(?m)^test result: ok\. (\d+) passed; 0 failed; (\d+) ignored; 0 measured; 0 filtered out; finished in [0-9.]+s$", output)
        passed = {test for test, state in outcomes if state == "ok"}
        ignored = {test for test, state in outcomes if state.startswith("ignored")}
        valid = (status == 0 and len(summaries) == 1 and len(outcomes) == len(inventory)
                 and {test for test, _ in outcomes} == set(inventory)
                 and (passed | ignored) == set(inventory)
                 and summaries[0] == (str(len(passed)), str(len(ignored))))
        if name == "agent-browser":
            required_seen.update(passed.intersection(REQUIRED_TESTS))
        results.append({"target": name, "cargo_artifact": row, "sha256_before": before,
                        "sha256_after": digest(binary), "passed": len(passed), "ignored": sorted(ignored),
                        "inventory": inventory, "accepted": valid and before == digest(binary)})
    result = {"targets": results, "required_tests": REQUIRED_TESTS,
              "required_missing_or_not_passed": sorted(set(REQUIRED_TESTS) - required_seen),
              "accepted": all(row["accepted"] for row in results) and set(REQUIRED_TESTS) == required_seen}
    save(EVIDENCE / "native-tests.json", result)
    assert len(REQUIRED_TESTS) == len(set(REQUIRED_TESTS)) == 61
    assert result["accepted"], "default test run failed or required exact witness did not pass"


def production(destination, label):
    assert label in ("production", "acceptance-faults")
    features = [] if label == "production" else ["acceptance-faults"]
    root = Path.cwd().resolve()
    rows = [row for row in cargo_artifacts(f"{label}-build") if row.get("target", {}).get("name") == "agent-browser"]
    assert len(rows) == 1
    row = rows[0]
    binary = Path(row["executable"]).resolve(strict=True)
    assert row["manifest_path"] == str(root / "Cargo.toml")
    assert row["target"]["src_path"] == str(root / "src/main.rs")
    assert row["target"]["kind"] == ["bin"] and row["features"] == features and not row["profile"]["test"]
    assert row["profile"]["opt_level"] == "3" and row["profile"]["debug_assertions"] is False
    assert binary == Path(os.environ["CARGO_TARGET_DIR"]).resolve() / "ci/agent-browser"
    with binary.open("rb") as stream:
        header = stream.read(20)
    assert header[:6] == bytes.fromhex("7f454c460201") and int.from_bytes(header[18:20], "little") == 62
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    image = destination / "agent-browser"
    shutil.copyfile(binary, image)
    image.chmod(0o755)
    result = {key: os.environ[key] for key in ("NATIVE_SHA", "NATIVE_TREE", "NATIVE_LOCK_SHA256", "E2E_SHA", "E2E_TREE", "E2E_LOCK_SHA256", "RUSTUP_TOOLCHAIN", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_SHA")}
    result.update(profile="ci", features=features, artifact_label=label, binary_sha256=digest(image), binary_bytes=image.stat().st_size,
                  cargo_artifact=row, helper_sha256=digest(Path(__file__)),
                  scope="unpromoted native validation artifact; browser/source-retirement/full acceptance NOT established",
                  distribution_eligible=False, dashboard_frontend_built=False)
    save(destination / "provenance.json", result)
    save(EVIDENCE / f"{label}-provenance.json", result)
    print(json.dumps(result, indent=2))


# The flat decision directory contains one real-browser suite. Keep its exact
# obligations pending in the runtime ledger instead of relabeling them as units.
DECISION_PURE_FILES = (
    "ai-version.test.ts", "budget.test.ts", "elements.test.ts", "executor-vision.test.ts",
    "executor.test.ts", "filter-runner.test.ts", "filter.test.ts", "openai.test.ts",
    "overlay.test.ts", "text.test.ts",
)
DECISION_RUNTIME_CASES = (
    "completes the todo flow in plain language",
    "fills a runner-authorized secret without sending it anywhere",
    "completes a long page past the choice cap",
    "asks the operation first and the target in its own call",
)


def decision_selection():
    directory = Path("packages/decision/tests")
    assert {str(path.relative_to(directory)) for path in directory.rglob("*.test.ts")} == set(DECISION_PURE_FILES) | {"cli.test.ts"}, "decision inventory changed; reclassify instead of silently omitting files"
    source = (directory / "cli.test.ts").read_text()
    assert len(re.findall(r"\bit\(", source)) == 4
    assert all("it('" + name + "'" in source for name in DECISION_RUNTIME_CASES)
    record = {
        "source_commit": os.environ["E2E_SHA"], "source_tree": os.environ["E2E_TREE"],
        "pure_unit_files": [{"path": str(directory / name), "sha256": digest(directory / name)} for name in DECISION_PURE_FILES],
        "required_runtime": [{
            "file": str(directory / "cli.test.ts"), "sha256": digest(directory / "cli.test.ts"),
            "suite": "decision executor through the built CLI and real Chromium",
            "assertions": list(DECISION_RUNTIME_CASES), "required": True,
            "status": "REQUIRED_PENDING_RUNTIME", "execution_status": "not-run", "passed": False, "outside_original_329": True,
            "command": ["pnpm", "--filter", "@e2e-dev/decision", "exec", "vitest", "run", "tests/cli.test.ts"],
            "prerequisites": ["built e2e, Web and decision packages", "verified matching production native executable", "real pinned Chromium"],
            "prior_run": "40123162559", "prior_outcome": "setup failed before browser; missing native bundle; no runtime tests executed",
        }],
    }
    save(EVIDENCE / "required-runtime.json", record)
    print(json.dumps(record, indent=2))


def reference_history():
    revision = os.environ["CANVAS_BASELINE_SHA"]
    tree = os.environ["CANVAS_BASELINE_TREE"]
    assert subprocess.check_output(["git", "rev-parse", revision + "^{commit}"], text=True).strip() == revision
    assert subprocess.check_output(["git", "rev-parse", revision + "^{tree}"], text=True).strip() == tree
    manifest = json.loads(Path("packages/web/tests/helpers/canvas-oracle-manifest.json").read_text())
    assert manifest["baselineRevision"] == revision
    verified = []
    for row in manifest["sources"]:
        path = row["path"]
        assert re.fullmatch(r"packages/(web|e2e)/[A-Za-z0-9_./-]+", path) and ".." not in path.split("/")
        result = subprocess.run(["git", "show", revision + ":" + path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        expected = row["baselineSha256"]
        assert (result.returncode != 0) if expected is None else (result.returncode == 0 and hashlib.sha256(result.stdout).hexdigest() == expected), path
        verified.append({"path": path, "baseline_sha256": expected, "expected_absent": expected is None})
    extra = "packages/web/tests/integration/read-node-roles.test.ts"
    content = subprocess.check_output(["git", "show", revision + ":" + extra])
    verified.append({"path": extra, "baseline_sha256": hashlib.sha256(content).hexdigest(), "expected_absent": False})
    assert len(manifest["sources"]) == 27 and sum(row["baselineSha256"] is None for row in manifest["sources"]) == 2
    record = {"commit": revision, "tree": tree, "source_files": verified, "baseline_code_executed": False}
    save(EVIDENCE / "reference-history.json", record)
    print(json.dumps(record, indent=2))


def main():
    command, *args = sys.argv[1:]
    if command == "run":
        return execute(args[0], int(args[1]), args[2:])
    if command == "identity":
        identity(*args)
    elif command == "binding":
        binding()
    elif command == "aggregate":
        aggregate(args)
    elif command == "decision-selection":
        decision_selection()
    elif command == "reference-history":
        reference_history()
    elif command == "native-tests":
        native_tests()
    elif command == "production":
        production(*args)
    elif command == "image-integrity":
        for directory in args:
            directory = Path(directory)
            provenance = json.loads((directory / "provenance.json").read_text())
            assert digest(directory / "agent-browser") == provenance["binary_sha256"]
            print(json.dumps({"label": provenance["artifact_label"], "sha256": provenance["binary_sha256"], "unchanged": True}))
    else:
        raise ValueError(f"unknown mode: {command}")
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate_owned)
    signal.signal(signal.SIGINT, terminate_owned)
    sys.exit(main())
