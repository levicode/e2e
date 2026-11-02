"""Archive only existing-schema HUNG metadata; raw files stay outside artifacts."""
import importlib.util
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
VALIDATOR_PATH = HERE / "check-engine-secrets-native-custody.py"
VALIDATOR_BYTES = VALIDATOR_PATH.read_bytes()
VALIDATOR_SHA256 = hashlib.sha256(VALIDATOR_BYTES).hexdigest()
spec = importlib.util.spec_from_file_location("closed_custody", VALIDATOR_PATH)
closed = importlib.util.module_from_spec(spec)
exec(compile(VALIDATOR_BYTES, str(VALIDATOR_PATH), "exec"), closed.__dict__)
MAX_BYTES = 256 * 1024
MAX_RECORDS = 2048
BOUND_FILES = {
    "collectorSha256": "scripts/ci/collect-spec-hung-cleanup.py",
    "validatorSha256": "scripts/ci/check-engine-secrets-native-custody.py",
    "schemaSha256": "scripts/ci/native-closed-trace-schema.json",
    "testSha256": "packages/web/tests/integration/cdp-recovery.test.ts",
    "helperSha256": "packages/web/tests/helpers/case-cleanup-capture.ts",
}


def directory(path):
    """Accept only canonical, process-owned private directories."""
    value = pathlib.Path(path)
    info = value.lstat()
    closed.need(value.is_absolute() and value.resolve() == value and stat.S_ISDIR(info.st_mode), "directory")
    closed.need(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, "directory-owner")
    closed.need(all(not part.is_symlink() for part in [value, *value.parents]), "directory-link")
    return value


def identity(workspace, raw, env):
    """Bind the existing collector, closed schema, test and selected runtime."""
    binding = closed.parse(closed.read(raw / "binding.json", 8192))
    closed.exact(binding, {"schemaVersion", "sourceCommit", "sourceTree", "run", "attempt", "nodeVersion", "nativeCommit", "nativeSha256", *BOUND_FILES})
    closed.need(binding["schemaVersion"] == 1, "binding")
    for key in ["sourceCommit", "sourceTree", "nativeCommit"]:
        closed.need(type(binding[key]) is str and re.fullmatch("[a-f0-9]{40}", binding[key]), "binding")
    for key in ["nativeSha256", *BOUND_FILES]:
        closed.need(type(binding[key]) is str and re.fullmatch("[a-f0-9]{64}", binding[key]), "binding")
    for key, name in [("sourceCommit", "GITHUB_SHA"), ("run", "GITHUB_RUN_ID"), ("attempt", "GITHUB_RUN_ATTEMPT")]:
        closed.need(binding[key] == env.get(name), "binding")
    closed.need(all(type(binding[key]) is str and re.fullmatch("[1-9][0-9]*", binding[key]) for key in ["run", "attempt"]), "binding")
    closed.need(type(binding["nodeVersion"]) is str and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", binding["nodeVersion"]), "binding")
    for key, revision in [("sourceCommit", "HEAD"), ("sourceTree", "HEAD^{tree}")]:
        actual = subprocess.check_output(["git", "rev-parse", revision], cwd=workspace, text=True, stderr=subprocess.DEVNULL).strip()
        closed.need(binding[key] == actual, "binding")
    pin = closed.parse(closed.read(workspace / ".github/native-candidate.json", 8192))
    closed.need(binding["nativeCommit"] == pin["commit"], "binding")
    if binding["validatorSha256"] != VALIDATOR_SHA256:
        raise ValueError("loaded-validator")
    schema = None
    for key, file in BOUND_FILES.items():
        data = closed.read(workspace / file, (128 if key == "schemaSha256" else 256) * 1024)
        closed.need(binding[key] == closed.sha(data), "binding")
        if key == "schemaSha256":
            # Inspect this exact verified snapshot; later path changes cannot widen it.
            schema = closed.parse(data)
    binary = pathlib.Path(env.get("E2E_AGENT_BROWSER_EXECUTABLE", "")).resolve(strict=True)
    closed.need(binding["nativeSha256"] == closed.sha(closed.read(binary, 128 * 1024 * 1024)), "binding")
    return binding, schema


def inspect(data, schema):
    """Keep closed rows only; missing, invalid or lossy capture stays unknown."""
    reasons = set()
    records = []
    lines = data.splitlines(keepends=True)
    if not lines:
        reasons.add("empty")
    if len(lines) > MAX_RECORDS:
        return [], {"record-limit"}
    fields = {"object": schema["fields"], "required": schema["required"]}
    pid = None
    for index, line in enumerate(lines):
        try:
            row = closed.parse(line)
            closed.need(len(line) <= 512 and line.endswith(b"\n"), "line")
            closed.need(closed.rule(row, fields) and closed.new_failure_fields(row), "schema")
            closed.need(row["source"] == "native" and closed.integer(row["pid"], 1, 2**32 - 1), "process")
        except Exception:
            reasons.add("invalid-record")
            continue
        records.append(row)
        if index == 0:
            pid = row["pid"]
            if row["phase"] != "CaptureStarted":
                reasons.add("missing-capture-start")
        if row["pid"] != pid or row["record"] != index or row["emittedBefore"] != index:
            reasons.add("process-or-record-gap")
        if row["phase"] in ["CaptureLimitReached", "TargetObservationLost"] or row["droppedBefore"] or row["suppressedBefore"] or row["overflow"]:
            reasons.add("capture-loss")
    if not any(row["phase"] == "TerminalCleanupCheckpoint" and row.get("terminalCleanupStage") == "shutdown-joins" for row in records):
        reasons.add("missing-shutdown-checkpoint")
    return records, reasons


def collect(workspace, evidence, raw, env):
    """Produce diagnostic observations without a business or cleanup verdict."""
    result = {"schemaVersion": 1, "caseId": "hung-recovery", "status": "unknown", "reasons": [],
              "diagnosticOnly": True, "releaseEligible": False, "caseAssociation": "helper-filename-only",
              "processCoverage": "unproven", "noAbsenceInference": True, "records": []}
    try:
        raw = directory(raw)
        closed.need(raw != evidence and evidence not in raw.parents and raw not in evidence.parents, "raw-placement")
        binding, schema = identity(workspace, raw, env)
        result["binding"] = binding
    except Exception:
        result["reasons"] = ["binding-unavailable"]
        return result
    try:
        data = closed.read(raw / "hung-recovery.cleanup.jsonl", MAX_BYTES)
        records, reasons = inspect(data, schema)
        result.update(records=records, reasons=sorted(reasons), status="unknown" if reasons else "observed")
    except Exception:
        result["reasons"] = ["capture-unavailable-or-byte-limit"]
    return result


def main():
    """An unavailable diagnostic cannot replace the original spec exit status."""
    try:
        evidence = directory(os.environ.get("E2E_SPEC_EVIDENCE_DIR", ""))
        workspace = pathlib.Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
        result = collect(workspace, evidence, os.environ.get("E2E_CASE_CLEANUP_DIAGNOSTIC_DIR", ""), os.environ)
        target = evidence / "hung-recovery.cleanup-diagnostics.json"
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result, output, separators=(",", ":"))
            output.write("\n")
    except Exception:
        print("SPEC_HUNG_CLEANUP_ARCHIVE_UNAVAILABLE")


if __name__ == "__main__":
    main()
