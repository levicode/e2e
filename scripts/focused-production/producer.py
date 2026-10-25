#!/usr/bin/env python3
"""Focused production only. Existing bounded build/ELF functions are reused; no test execution."""
import hashlib, json, os, re, shutil, signal, subprocess, sys, time
from pathlib import Path
EVIDENCE = Path(os.environ.get("EVIDENCE_DIR", "."))
ACTIVE_GROUPS = set()
HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())


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

def aggregate(names):
    states = {name: ((EVIDENCE / f"{name}.exit").read_text().strip() if (EVIDENCE / f"{name}.exit").exists() else "missing") for name in names}
    result = {"accepted": all(status == "0" for status in states.values()), "phases": states,
              "scope": "compile/unit/artifact only; not installed-browser, source-retirement, acceptance, promotion or release"}
    save(EVIDENCE / "aggregate.json", result)
    print(json.dumps(result, indent=2))
    assert result["accepted"], "failed, timed-out, skipped or missing gate"

def cargo_artifacts(name):
    assert (EVIDENCE / f"{name}.exit").read_text().strip() == "0", "Cargo gate did not pass"
    rows = [json.loads(line) for line in (EVIDENCE / f"{name}.stdout.log").read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get("reason") == "build-finished"]
    assert len(finished) == 1 and finished[0].get("success") is True
    return [row for row in rows if row.get("reason") == "compiler-artifact" and row.get("executable")]

def production(destination, label):
    assert label == "production", "Only the genuine feature-free production image is permitted"
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
    receipt_file = EVIDENCE / "native-focused-verified.json"
    receipt = json.loads(receipt_file.read_text())
    assert receipt["verifiedSuccess"] is True and receipt["nativeSha"] == os.environ["NATIVE_SHA"]
    assert receipt["nativeTree"] == os.environ["NATIVE_TREE"] and receipt["runId"] == PINS["nativeFocused"]["runId"]
    result["native_validation"] = {"mode": "focused-native-prior-dev-fixtures", "run_id": receipt["runId"],
        "current_native_execution": False, "receipt_file": "native-focused-verified.json", "receipt_sha256": digest(receipt_file)}
    result["scope"] = "New feature-free ci ELF for original P06 runtime; actual eight focused dev cases plus four compile gates, not full native or optimized test acceptance"
    result.update(full_native_suite_passed=False, optimized_native_tests_executed=False,
                  installed_distribution_verified=False, focused_runtime_cases=["P06"])
    result["prior_e2e_validation"] = PINS["priorE2eValidation"]
    shutil.copyfile(receipt_file, destination / "native-focused-verified.json")
    save(destination / "provenance.json", result)
    save(EVIDENCE / f"{label}-provenance.json", result)
    print(json.dumps(result, indent=2))

def source_identity(root, sha, tree, lock, lock_sha, stage):
    identity(root, sha, tree, lock, lock_sha)
    assert stage in ("before", "after")
    root = Path(root).resolve()
    ignored = subprocess.check_output(["git", "-C", str(root), "ls-files", "--others", "--ignored", "--exclude-standard"], text=True).splitlines()
    allowed = [] if stage == "before" else ["packages/dashboard/out/index.html"]
    assert ignored == allowed, "Unexpected ignored source/build input"
    assert digest(root / "cli/build.rs") == PINS["nativeBuildRsSha256"]
    if stage == "after":
        expected = b"<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard &amp;&amp; pnpm build</p></body></html>\n"
        assert (root / allowed[0]).read_bytes() == expected, "Only the original Rust-only dashboard placeholder is permitted"

def guard():
    assert PINS.get("enabled") is True and PINS.get("sourceBindingFrozen") is True, "Disabled draft / final source or successful focused-native proof is not frozen"
    for key in ("nativeSha", "nativeTree", "e2eSha", "e2eTree"):
        assert isinstance(PINS.get(key), str) and re.fullmatch(r"[0-9a-f]{40}", PINS[key]) and PINS[key] != "0" * 40
    proof = PINS["nativeFocused"]
    for key in ("runId", "runAttempt", "jobId", "artifactId", "archiveBytes", "expectedCaseCount"):
        assert isinstance(proof.get(key), int) and proof[key] > 0
    assert proof["runId"] not in PINS["rejectedFocusedRuns"], "A known failed run cannot admit production"
    names = proof.get("expectedJobStepNames")
    assert isinstance(names, list) and names and all(isinstance(name, str) and name for name in names)
    assert len(names) == len(set(names)), "Exact successful original job step names are required"
    for key in ("recipeSha", "recipeTree"):
        assert re.fullmatch(r"[0-9a-f]{40}", proof[key])
    for key in ("archiveSha256", "helperSha256", "pinsSha256", "workflowSha256"):
        assert re.fullmatch(r"[0-9a-f]{64}", proof[key])
    for key in ("nativeLockSha256", "e2eLockSha256", "nativeBuildRsSha256"):
        assert re.fullmatch(r"[0-9a-f]{64}", PINS[key])
    prior = PINS["priorE2eValidation"]
    assert prior["e2eSha"] == PINS["e2eSha"] and prior["e2eTree"] == PINS["e2eTree"]
    assert prior["unitPassed"] == 1124 and prior["unitFailed"] == prior["unitSkipped"] == 0
    assert all(prior[key] is True for key in ("coreBuild", "webBuild", "webTypes", "repositoryLint"))
    assert re.fullmatch(r"[0-9a-f]{64}", prior["manifestSha256"])
    values = {"NATIVE_SHA":PINS["nativeSha"], "NATIVE_TREE":PINS["nativeTree"], "NATIVE_LOCK_SHA256":PINS["nativeLockSha256"],
              "E2E_SHA":PINS["e2eSha"], "E2E_TREE":PINS["e2eTree"], "E2E_LOCK_SHA256":PINS["e2eLockSha256"],
              "PROOF_RUN_ID":proof["runId"], "PROOF_RUN_ATTEMPT":proof["runAttempt"], "PROOF_ARTIFACT_ID":proof["artifactId"], "PROOF_RECIPE_SHA":proof["recipeSha"]}
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        for key, value in values.items(): stream.write(f"{key}={value}\n")
    save(EVIDENCE / "frozen-inputs.json", PINS)

def main():
    mode, *args = sys.argv[1:]
    if mode == "run": return execute(args[0], int(args[1]), args[2:])
    if mode == "guard": guard()
    elif mode == "identity": identity(*args)
    elif mode == "source": source_identity(*args)
    elif mode == "aggregate": aggregate(args)
    elif mode == "production": production(*args)
    elif mode == "integrity":
        directory = Path(args[0]); value = json.loads((directory / "provenance.json").read_text())
        assert digest(directory / "agent-browser") == value["binary_sha256"]
        assert value["profile"] == "ci" and value["features"] == []
        assert value["native_validation"]["receipt_sha256"] == digest(directory / "native-focused-verified.json")
        assert value["full_native_suite_passed"] is value["optimized_native_tests_executed"] is value["installed_distribution_verified"] is False
        print(json.dumps({"sha256":value["binary_sha256"],"unchanged":True,"focusedOnly":True}))
    else: raise AssertionError("Closed production-only command required")
    return 0

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate_owned)
    signal.signal(signal.SIGINT, terminate_owned)
    sys.exit(main())
