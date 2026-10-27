"""Single ignored pseudo capture contract; derived from existing same-harness Chromium identity runner."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

NAME = "native::client_capture::pseudo_tests::chromium_pseudo_capture_preserves_public_pixels_and_refuses_secure_generated_paint"
OUTER_SECONDS = 180
LIST_SECONDS = 30
STAGES = set("ensure-enter ensure-bypass ensure-serial ensure-navigation ensure-navigation-result ensure-flush ensure-flush-result ensure-complete ensure-result guard-check cdp-reserve cdp-reply cdp-result cdp-admission cdp-submit nav-enter nav-frame nav-subscribe nav-trigger-result nav-wait nav-event nav-origin-read nav-complete other-stage".split())
METHODS = set("Page.setLifecycleEventsEnabled Page.getFrameTree Page.navigate Runtime.evaluate Page.lifecycleEvent Page.frameNavigated Page.navigatedWithinDocument Inspector.detached Target.detachedFromTarget Target.getTargets Target.getTargetInfo Page.createIsolatedWorld Page.addScriptToEvaluateOnNewDocument Runtime.addBinding Runtime.runIfWaitingForDebugger Target.setAutoAttach Network.enable Page.enable Runtime.enable DOM.enable Fetch.enable Fetch.continueRequest Fetch.failRequest Fetch.continueWithAuth Runtime.getIsolateId Runtime.releaseObject Runtime.releaseObjectGroup other-command-or-event".split())
OUTCOMES = set("entered ok failed bypass error-ack local-failure channel-closed deadline owner-changed admission-refused admission-revoked transport-closed cdp-error send-failed other-failure overflow malformed-frame download error-text cancelled received other-outcome".split())
ERRORS = set("invalid-frame unsupported-protocol unsupported-capability stale-generation scope-unavailable sequence-reused invalid-sequence invalid-timeout capacity-exceeded operation-missing decision-missing decision-expired decision-kind-mismatch registry-missing registry-in-use identifier-exhausted unsupported-command deadline-exceeded cancelled invalid-arguments browser-failure stale-scope cleanup-failed stale-reference policy-denied not-actionable locator-not-found content-length-mismatch redirect-body-unavailable intercepted-pointer checked-state-unchanged checked-control-replaced frame-not-found frame-ambiguous".split())
PHASES = set("ready initial-title-complete original-target-closed reopen-result-complete replacement-title-complete".split())
DIAGNOSTIC_KEYS = {"sequence", "stage", "method", "outcome", "protocolError", "matches", "limitReached"}

class Refused(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refused(code)

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()

def child_environment(source):
    clean = {key: value for key, value in source.items() if key not in {"GH_TOKEN", "GITHUB_TOKEN"}}
    clean.update(AGENT_BROWSER_DEBUG="1", RUST_MIN_STACK="16777216")
    return clean

def safe_diagnostic(value):
    if not isinstance(value, dict) or set(value) != DIAGNOSTIC_KEYS:
        return None
    if type(value["sequence"]) is not int or not 1 <= value["sequence"] <= 129:
        return None
    if value["stage"] not in STAGES or value["outcome"] not in OUTCOMES:
        return None
    if value["method"] is not None and value["method"] not in METHODS:
        return None
    if value["protocolError"] is not None and value["protocolError"] not in ERRORS:
        return None
    if type(value["limitReached"]) is not bool:
        return None
    matches = value["matches"]
    if matches is not None and (not isinstance(matches, list) or len(matches) != 4 or any(type(item) is not bool for item in matches)):
        return None
    return value

def project_output(path):
    result = {"panicSites": [], "activation": [], "phases": [], "counts": [], "rejectedDiagnosticRows": 0, "oversizeLines": 0,
              "webSocket": {"closeReported": False, "errorReported": False, "closeReports": 0, "errorReports": 0, "observations": [], "observationsTruncated": False}}
    with path.open("r", encoding="utf-8", errors="replace") as source:
        while True:
            line = source.readline(16385)
            if not line:
                break
            if len(line) > 16384:
                result["oversizeLines"] += 1
                while line and not line.endswith("\n"):
                    line = source.readline(16385)
                continue
            # Preserve only repository source locations, never panic message/value.
            match = re.fullmatch(r"thread '[^\r\n]{1,512}' (?:\(\d{1,12}\) )?panicked at (src/native/[a-z_]{1,100}\.rs):([0-9]{1,7}):([0-9]{1,5}):\n?", line)
            if match and len(result["panicSites"]) < 8:
                result["panicSites"].append({"file": match.group(1), "line": int(match.group(2)), "column": int(match.group(3))})
            # Existing debug prints arbitrary close reasons/errors. Retain only
            # occurrence facts, not the reason, error string, or inferred cause.
            for marker, flag, counter in [("[cdp] WebSocket Close:", "closeReported", "closeReports"), ("[cdp] WebSocket Error:", "errorReported", "errorReports")]:
                if marker in line:
                    result["webSocket"][flag] = True
                    result["webSocket"][counter] = min(2048, result["webSocket"][counter] + 1)
                    if len(result["webSocket"]["observations"]) < 32:
                        result["webSocket"]["observations"].append({
                            "kind": "close" if flag == "closeReported" else "error",
                            "afterActivationSequence": result["activation"][-1]["sequence"] if result["activation"] else 0,
                            "afterPhase": result["phases"][-1] if result["phases"] else None,
                        })
                    else:
                        result["webSocket"]["observationsTruncated"] = True
            marker = "PERSISTENT_ACTIVATION_DIAGNOSTIC "
            if line.startswith(marker):
                try:
                    value = safe_diagnostic(json.loads(line[len(marker):]))
                except (ValueError, TypeError):
                    value = None
                if value is not None and len(result["activation"]) < 129:
                    result["activation"].append(value)
                else:
                    result["rejectedDiagnosticRows"] += 1
            marker = "PERSISTENT_REOPEN_PHASE "
            if marker in line:
                phase = line.split(marker, 1)[1].strip()
                if phase in PHASES and len(result["phases"]) < 8:
                    result["phases"].append(phase)
                else:
                    result["rejectedDiagnosticRows"] += 1
            for counts in re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;", line):
                if len(result["counts"]) < 8:
                    result["counts"].append(list(counts))
    return result

def observe_descendants(pid, chrome, chrome_digest, version, seen):
    table = {}
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            table[int(entry.name)] = int((entry / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError):
            pass
    descendants = {pid}
    while True:
        count = len(descendants)
        descendants.update(child for child, parent in table.items() if parent in descendants)
        if len(descendants) == count:
            break
    for child in descendants - {pid}:
        try:
            actual = (pathlib.Path("/proc") / str(child) / "exe").resolve(strict=True)
            if actual == chrome:
                seen[child] = {"pid": child, "executablePath": str(actual), "sha256": chrome_digest, "version": version}
        except OSError:
            pass

def run(harness, meta_path, out):
    harness = harness.resolve(strict=True)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads(meta_path.read_text())
    chrome = pathlib.Path(meta["executablePath"]).resolve(strict=True)
    chrome_digest = digest(chrome)
    require(chrome_digest == meta["sha256"], "chrome-hash-mismatch")
    env = child_environment(os.environ)
    for key in ("AGENT_BROWSER_CDP", "AGENT_BROWSER_AUTO_CONNECT", "AGENT_BROWSER_PROVIDER", "AGENT_BROWSER_PROFILE"):
        require(not env.get(key), "ambient-browser-configuration")
    version_raw = subprocess.check_output([str(chrome), "--version"], env=env, text=True, timeout=LIST_SECONDS).strip()
    version = re.fullmatch(r"(?:Google Chrome for Testing|Google Chrome|Chromium) (156\.\d+\.\d+\.\d+)", version_raw)
    require(version is not None, "unexpected-chrome-version")
    version = version.group(1)
    harness_digest = digest(harness)
    started = time.monotonic()
    listing = subprocess.run([str(harness), "--exact", NAME, "--ignored", "--list"], env=env, capture_output=True, text=True, timeout=LIST_SECONDS)
    require(listing.returncode == 0 and [line for line in listing.stdout.splitlines() if line.endswith(": test")] == [NAME + ": test"], "exact-inventory-mismatch")
    seen = {}
    timed_out = False
    # Never put raw harness/debug output below the artifact directory. Both raw
    # output and the optional existing cleanup sink die with this temp directory.
    with tempfile.TemporaryDirectory(prefix="owned-pseudo-capture-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        require(not pathlib.Path(temporary).resolve().is_relative_to(out.resolve()), "raw-temp-inside-artifact-directory")
        raw = pathlib.Path(temporary) / "raw.log"
        cleanup = pathlib.Path(temporary) / "cleanup.jsonl"
        cleanup.touch(mode=0o600, exist_ok=False)
        env["AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE"] = str(cleanup)
        with raw.open("w") as output:
            proc = subprocess.Popen([str(harness), "--exact", NAME, "--ignored", "--test-threads=1", "--nocapture"], cwd=pathlib.Path(os.environ["GITHUB_WORKSPACE"]) / "native/cli", stdout=output, stderr=subprocess.STDOUT, env=env)
            try:
                launched = time.monotonic()
                while proc.poll() is None:
                    if time.monotonic() - launched >= OUTER_SECONDS:
                        timed_out = True
                        proc.terminate()
                        try:
                            proc.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait()
                        break
                    observe_descendants(proc.pid, chrome, chrome_digest, version, seen)
                    time.sleep(.01)
                code = proc.wait()
            finally:
                # A runner-side /proc or filesystem error must not abandon its
                # owned test process. This is not a test retry or timeout extension.
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
        projection = project_output(raw)
    remaining = []
    for pid in seen:
        try:
            if (pathlib.Path("/proc") / str(pid) / "exe").resolve(strict=True) == chrome:
                remaining.append(pid)
        except OSError:
            pass
    unchanged = digest(chrome) == chrome_digest
    harness_unchanged = digest(harness) == harness_digest
    receipt = {"name": NAME, "kind": "same-binary-closed-debug-diagnostic", "attempt": 1,
               "exitCode": code, "timedOut": timed_out, "outerTimeoutSeconds": OUTER_SECONDS,
               "listTimeoutSeconds": LIST_SECONDS, "counts": projection["counts"],
               "observedDescendantBrowserBinaries": list(seen.values()), "remainingBrowserPids": remaining,
               "browserIdentityRequired": True, "binaryUnchangedAfter": unchanged,
               "harnessSHA256": harness_digest, "harnessUnchangedAfter": harness_unchanged,
               "durationSeconds": time.monotonic() - started, "releaseEligible": False,
               "rawOutputRetained": False, "debugReasonRetained": False,
               "activationDiagnosticPresent": bool(projection["activation"])}
    (out / "pseudo-capture.closed-diagnostic.json").write_text(json.dumps(projection, indent=2) + "\n")
    (out / "pseudo-capture.result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    failed = code != 0 or timed_out or projection["counts"] != [["1", "0", "0"]] or remaining or not unchanged or not harness_unchanged or not seen or projection["rejectedDiagnosticRows"] or projection["oversizeLines"]
    return int(bool(failed))

def main():
    require(len(sys.argv) == 4, "argument-count")
    out = pathlib.Path(sys.argv[3]).resolve()
    try:
        return run(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), out)
    except Exception as error:
        out.mkdir(parents=True, exist_ok=True)
        cause = str(error) if isinstance(error, Refused) else "setup-or-runner-failure"
        (out / "runner-failure.json").write_text(json.dumps({"kind": "same-binary-closed-debug-diagnostic", "cause": cause, "releaseEligible": False}) + "\n")
        return 1

if __name__ == "__main__":
    sys.exit(main())
