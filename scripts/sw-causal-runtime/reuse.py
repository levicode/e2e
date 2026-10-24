#!/usr/bin/env python3
"""Reuse one pinned historical diagnostic image and positive control. Never execute either."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import shutil
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'pins.json').read_text())
REUSE = json.loads((HERE / 'reuse-pins.json').read_text())
TITLE = 'captures the first service-worker script console and errors with first fetch redirect and failure events'
DOCUMENTS = ('source-identity-before.json', 'source-identity.json', 'production-identity.json', 'browser-identity.json',
             'summary.json', 'FIRST_EVENTS/case-summary.json', 'FIRST_EVENTS/capture-binding.json',
             'FIRST_EVENTS/plan.json', 'FIRST_EVENTS/result.json', 'FIRST_EVENTS/inventory.json',
             'FIRST_EVENTS/vitest.json', 'FIRST_EVENTS/startup-events.json')
EXTRACT = set(DOCUMENTS) | {'FIRST_EVENTS/native.jsonl', 'FIRST_EVENTS/observer-errors.jsonl'}


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_origin_metadata(meta, jobs, archive_digest, *, prior=False):
    artifact_id = REUSE['priorEvidenceArtifactId' if prior else 'artifactId']
    expected = REUSE['priorEvidenceArtifactSha256' if prior else 'artifactSha256']
    assert archive_digest == expected and meta['digest'] == 'sha256:' + expected
    assert meta['id'] == artifact_id and meta['expired'] is False
    expected_name = (f"sw-causal-runtime-evidence-{REUSE['runId']}-{REUSE['runAttempt']}" if prior else
                     f"temporary-sw-causal-native-linux-x64-{PINS['nativeSha']}-{REUSE['runId']}-{REUSE['runAttempt']}")
    assert meta['name'] == expected_name
    assert meta['workflow_run']['id'] == REUSE['runId']
    assert meta['workflow_run']['head_sha'] == REUSE['recipeSha']
    assert meta['workflow_run']['head_branch'] == 'implement/sw-causal-diagnostic-ci'
    kind, job_id, conclusion = ('runtime', REUSE['runtimeJobId'], 'failure') if prior else ('compile', REUSE['compileJobId'], 'success')
    selected = [job for job in jobs['jobs'] if job['name'] == 'temporary-sw-causal-' + kind]
    assert len(selected) == 1
    job = selected[0]
    assert job['id'] == job_id and job['run_id'] == REUSE['runId'] and job['run_attempt'] == REUSE['runAttempt']
    assert job['head_sha'] == REUSE['recipeSha'] and job['status'] == 'completed' and job['conclusion'] == conclusion
    if not prior:
        assert meta['size_in_bytes'] == REUSE['artifactBytes']


def producer_environment():
    return {'GITHUB_RUN_ID': str(REUSE['runId']), 'GITHUB_RUN_ATTEMPT': str(REUSE['runAttempt']),
            'GITHUB_WORKFLOW_SHA': REUSE['recipeSha'], 'DIAGNOSTIC_ARTIFACT_ID': str(REUSE['artifactId']),
            'DIAGNOSTIC_ARTIFACT_DIGEST': 'sha256:' + REUSE['artifactSha256'],
            'DIAGNOSTIC_BINARY_SHA256': REUSE['binarySha256'], 'DIAGNOSTIC_BINARY_BYTES': str(REUSE['binaryBytes'])}


def artifact(evidence):
    meta = json.loads((evidence / 'artifact-metadata.json').read_text())
    jobs = json.loads((evidence / 'compile-jobs.json').read_text())
    verify_origin_metadata(meta, jobs, digest(evidence / 'diagnostic-artifact.zip'))
    assert digest(HERE.parent / 'sw-causal-diagnostic/compile-helper.py') == REUSE['compileHelperSha256']
    # The original verifier retains all producer source, toolchain, native-test,
    # ELF and receipt checks. Its environment describes the producer, not this job.
    values = producer_environment()
    before = {key: os.environ.get(key) for key in values}
    try:
        os.environ.update(values)
        with contextlib.redirect_stdout(io.StringIO()):
            load_module('producer_artifact', HERE / 'artifact.py').main()
    finally:
        for key, value in before.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value
    receipt = json.loads((evidence / 'production-identity.json').read_text())
    receipt.update(sameRunArtifactVerified=False, exactPriorArtifactVerified=True,
                   nativeCompilationExecutedThisRun=False, nativeTestsExecutedThisRun=False,
                   consumerRunId=os.environ['GITHUB_RUN_ID'], consumerRunAttempt=os.environ['GITHUB_RUN_ATTEMPT'],
                   consumerRecipeSha=os.environ['GITHUB_WORKFLOW_SHA'])
    save(evidence / 'production-identity.json', receipt)
    print(json.dumps(receipt, indent=2))


def safe_extract(archive, destination):
    destination.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        assert len(names) == len(set(names)) and len(names) <= 256
        assert EXTRACT <= set(names) and not any(name.startswith('HTTP500/') for name in names)
        assert sum(entry.file_size for entry in entries) <= 16 * 1024 * 1024
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename
            assert (entry.external_attr >> 16) & 0o170000 != 0o120000
            assert entry.file_size <= 4 * 1024 * 1024
            if entry.filename not in EXTRACT: continue
            assert not entry.is_dir()
            output = destination / entry.filename
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            output.write_bytes(bundle.read(entry))


def verify_prior_documents(documents, raw_sha256, raw_bytes, decoder, observer_errors=b''):
    source = documents['source-identity-before.json']
    assert documents['source-identity.json'] == source
    for kind in ('e2e', 'native'):
        assert source[kind] == dict(commit=PINS[kind + 'Sha'], tree=PINS[kind + 'Tree'], status='')
    assert source['recipe'] == dict(commit=REUSE['recipeSha'], tree=REUSE['recipeTree'], status='')
    assert source['pnpmLockSha256'] == PINS['e2eLockSha256']
    product = documents['production-identity.json']
    for key in ('nativeSha', 'nativeTree'): assert product[key] == PINS[key]
    for key in ('binarySha256', 'binaryBytes', 'artifactId', 'recipeSha'): assert product[key] == REUSE[key]
    assert product['artifactDigest'] == 'sha256:' + REUSE['artifactSha256']
    assert product['runId'] == str(REUSE['runId']) and product['runAttempt'] == str(REUSE['runAttempt'])
    assert product['sameRunArtifactVerified'] is True and product['diagnosticOnly'] is True
    assert product['formalCandidate'] is False and product['releaseEligible'] is False
    assert product['profile'] == 'ci' and product['features'] == []
    expected_binding = dict(sourceRevision=PINS['e2eSha'], nativeSourceRevision=PINS['nativeSha'],
                            testSourceDigest=REUSE['relocatedFixtureSha256'], binarySha256=REUSE['binarySha256'],
                            collectorSha256=REUSE['collectorSha256'])
    binding = documents['FIRST_EVENTS/capture-binding.json']
    assert binding['binding'] == expected_binding
    assert raw_sha256 == binding['rawSha256'] == REUSE['priorRawSha256']
    assert raw_bytes == binding['bytes'] == REUSE['priorRawBytes']
    plan = documents['FIRST_EVENTS/plan.json']
    assert plan['binding'] == expected_binding and plan['id'] == 'FIRST_EVENTS'
    assert plan['title'] == TITLE and plan['outerMaxMs'] == 45000 and plan['syntheticBatch'] is False
    assert plan['temporaryNoSandbox'] == 'only this owned CI loopback fixture'
    chrome = documents['browser-identity.json']
    assert plan['selectedChrome'] == chrome
    for key in ('sha256', 'playwrightVersion', 'chromiumRevision'):
        assert chrome[key] == PINS['chromeSha256' if key == 'sha256' else key]
    assert chrome['version'] == 'Google Chrome for Testing ' + PINS['chromeVersion']
    case = documents['FIRST_EVENTS/case-summary.json']
    assert case['id'] == 'FIRST_EVENTS'
    for key in ('testPassed', 'selectedEvidencePresent', 'runtimeImagesUnchanged', 'actualBrowserImageConfirmed', 'knownCleanupConfirmed'):
        assert case[key] is True
    assert not case['firstRunnerError'] and not case['observerFirstError']
    assert case['report']['selectionExact'] is True and case['report']['status'] == 'passed' and case['report']['success'] is True
    report = documents['FIRST_EVENTS/vitest.json']
    tests = [test for suite in report['testResults'] for test in suite['assertionResults']]
    selected = [test for test in tests if test['title'] == TITLE]
    executed = [test for test in tests if test['status'] not in ('skipped', 'pending', 'todo', 'disabled')]
    assert len(selected) == 1 and executed == selected and selected[0]['status'] == 'passed' and report['success'] is True
    assert not selected[0]['failureMessages']
    result = documents['FIRST_EVENTS/result.json']
    assert result['launcherExit']['code'] == 0 and result['launcherExit']['signal'] is None
    assert result['knownCleanupConfirmed'] is True and result['finallyEntered'] is True and result['observationStopped'] is True
    assert result['stdioClosed'] is True and not result['spawnError'] and not result['firstError'] and result['errors'] == [] and observer_errors == b''
    assert result['launcher']['spawnedByThisRunner'] is True and result['launcher']['argv'] == plan['argv']
    processes = documents['FIRST_EVENTS/inventory.json']['processes']
    assert len(processes) == 3 and sorted(item['role'] for item in processes) == ['chrome', 'native', 'proxy']
    final = {(item['pid'], item['startTicks']): item for item in result['currentKnownProcesses']}
    assert len(final) == len(processes)
    for item in processes:
        assert item['borrowed'] is False and item['current']['status'] == 'absent' and item['absentChecks'] >= 2
        state = final[(item['pid'], item['startTicks'])]
        assert state['status'] == 'absent' and state['absentChecks'] >= 2
        expected = PINS['chromeSha256'] if item['role'] == 'chrome' else REUSE['binarySha256']
        assert item['executableSha256'] == expected
        if item['role'] == 'native':
            owner = item['terminalFileOwnerObservation']
            assert owner['writable'] is True and owner['dev'] == binding['device'] and owner['ino'] == binding['inode']
            assert owner['startTicks'] == item['startTicks']
    summary = documents['summary.json']
    http500 = [item for item in summary['focusedCases'] if item['id'] == 'HTTP500']
    assert len(http500) == 1 and http500[0]['status'] == 'not-run'
    startup = documents['FIRST_EVENTS/startup-events.json']
    assert startup['count'] == 1 and startup['violations'] == [] and startup['error'] is None
    assert startup['cleanup'] == dict(end='passed', dispose='passed', server='passed')
    assert decoder['scopeDecoderVersion'] == 'sw-causal-scope-closure-v1'
    assert decoder['status'] == 'unknown'
    assert decoder['positiveControlVisible'] is True and decoder['globalLosslessCapture'] is False
    closed_controls = [trace for trace in decoder['traceVerdicts']
                       if trace.get('source') == 'native' and trace.get('status') == 'closed'
                       and trace.get('scopeClosed') is True and trace.get('successfulControl') is True
                       and trace.get('missingFacts') == []
                       and trace.get('decisionEvidence', {}).get('status') == 'closed'
                       and trace.get('decisionEvidence', {}).get('kind') == 'ready-initialized'
                       and type(trace.get('decisionEvidence', {}).get('finalOutcome')) is int
                       and trace.get('decisionEvidence', {}).get('finalOutcome') == 1
                       and type(trace.get('traceOwnedRecordsBeforeEnd')) is int
                       and trace.get('traceOwnedRecordsBeforeEnd', 0) > 0
                       and trace.get('traceOwnedRecordsBeforeEnd') == trace.get('traceAttemptPrefix')]
    assert closed_controls, 'No same-item fully closed native successful-control trace'
    assert decoder['rawSha256'] == raw_sha256 and decoder['diagnosticOnly'] is True
    assert decoder['formalCleanupPass'] is False and decoder['formalAcceptance'] is False
    # No prior failed global decode is rewritten or promoted to formal acceptance.
    return dict(id='FIRST_EVENTS', status='historical-positive-control-verified', executedThisRun=False,
                sourceRunId=REUSE['runId'], sourceRunAttempt=REUSE['runAttempt'], sourceRecipeSha=REUSE['recipeSha'],
                sourceArtifactId=REUSE['priorEvidenceArtifactId'], sourceArtifactSha256=REUSE['priorEvidenceArtifactSha256'],
                rawSha256=raw_sha256, testPassed=True, knownCleanupConfirmed=True, positiveControlVisible=True,
                globalLosslessCapture=False, formalCleanupPass=False, formalAcceptance=False,
                scopeDecoderVersion=decoder['scopeDecoderVersion'], closedSuccessfulTraceCount=len(closed_controls),
                nativeCompilationExecutedThisRun=False, historicalCaseStatus=case['status'],
                decoderSha256=digest(HERE / 'evidence.py'))


def positive(evidence):
    prior = Path(os.environ['PRIOR_EVIDENCE_DIR'])
    meta = json.loads((evidence / 'prior-artifact-metadata.json').read_text())
    jobs = json.loads((evidence / 'compile-jobs.json').read_text())
    archive = Path(os.environ['PRIOR_EVIDENCE_ZIP'])
    verify_origin_metadata(meta, jobs, digest(archive), prior=True)
    assert archive.stat().st_size == meta['size_in_bytes']
    safe_extract(archive, prior)
    assert digest(HERE / 'sw-startup-events.test.ts') == REUSE['relocatedFixtureSha256']
    assert digest(Path(os.environ['GITHUB_WORKSPACE']) / 'e2e-source/scripts/acceptance/candidate-cleanup-diagnostics.ts') == REUSE['collectorSha256']
    decoder = load_module('scoped_decoder', HERE / 'evidence.py')
    decoder.decode(prior / 'FIRST_EVENTS')
    documents = {name: json.loads((prior / name).read_text()) for name in DOCUMENTS}
    scoped = json.loads((prior / 'FIRST_EVENTS/causal-summary.json').read_text())
    raw = prior / 'FIRST_EVENTS/native.jsonl'
    receipt = verify_prior_documents(documents, digest(raw), raw.stat().st_size, scoped, (prior / 'FIRST_EVENTS/observer-errors.jsonl').read_bytes())
    save(evidence / 'historical-positive-control.json', receipt)
    print(json.dumps(receipt, indent=2))


def comparison_cell(cell_id, plan=None):
    plan = REUSE['comparison'] if plan is None else plan
    expected = [dict(id=f'{arm}-{replicate}', arm=arm, replicate=replicate) for arm in ('formal', 'diag') for replicate in (1, 2)]
    assert plan['cells'] == expected and set(plan['products']) == {'formal', 'diag'}
    assert plan['schemaVersion'] == 1 and plan['caseIds'] == ['HTTP500'] and plan['outerMaxMs'] == 45000
    assert plan['maxAttemptsPerCell'] == 1 and plan['conditionalRetries'] is False
    assert plan['additionalCasesAllowed'] is False and plan['failFast'] is False
    selected = [cell for cell in plan['cells'] if cell['id'] == cell_id]
    assert len(selected) == 1, 'Unknown fixed comparison cell'
    return dict(selected[0], product=plan['products'][selected[0]['arm']])


def comparison_environment():
    cell = comparison_cell(os.environ['COMPARISON_CELL'])
    assert os.environ['GITHUB_RUN_ATTEMPT'] == '1', 'The four-cell experiment has no reruns'
    assert os.environ['COMPARISON_ARM'] == cell['arm']
    assert os.environ['NATIVE_SHA'] == cell['product']['nativeSha']
    assert os.environ['NATIVE_TREE'] == cell['product']['nativeTree']
    return cell


def selection(evidence):
    cell = comparison_environment(); product = cell['product']
    save(evidence / 'experiment-plan.json', dict(REUSE['comparison'], selectedCell=cell['id'], executed=False))
    save(evidence / 'required-runtime.json', dict(experimentOnly=True, formalAcceptance=False, comparisonCell=cell['id'],
         FIRST_EVENTS='not-executed-this-run', HTTP500='not-run',
         historicalPositiveControl='pending-diag-proof' if cell['arm'] == 'diag' else 'not-required-formal-no-causal-hooks'))
    # Closed pinned fields only. No caller-supplied URL or arbitrary executable path.
    with Path(os.environ['GITHUB_ENV']).open('a') as env:
        for name, key in [('PRODUCT_ARTIFACT_ID', 'artifactId'), ('PRODUCT_RUN_ID', 'runId'),
                          ('PRODUCT_RUN_ATTEMPT', 'runAttempt'), ('PRODUCT_RECIPE_SHA', 'recipeSha')]:
            env.write(f'{name}={product[key]}\n')


def verify_comparison_metadata(meta, jobs, run, commit, archive_digest, cell):
    product = cell['product']
    assert meta['id'] == product['artifactId'] and meta['expired'] is False
    assert meta['digest'] == 'sha256:' + product['artifactSha256'] and archive_digest == product['artifactSha256']
    assert meta['size_in_bytes'] == product['artifactBytes'] and meta['name'] == product['artifactName']
    assert meta['workflow_run']['id'] == product['runId'] and meta['workflow_run']['head_sha'] == product['recipeSha']
    assert meta['workflow_run']['head_branch'] == product['branch']
    assert run['id'] == product['runId'] and run['run_attempt'] == product['runAttempt']
    assert run['head_sha'] == product['recipeSha'] and run['status'] == 'completed'
    assert run['conclusion'] == ('success' if cell['arm'] == 'formal' else 'failure')
    assert commit['sha'] == product['recipeSha'] and commit['tree']['sha'] == product['recipeTree']
    if cell['arm'] == 'formal': assert jobs['total_count'] == len(jobs['jobs']) == 3
    for expected in product['requiredJobs']:
        selected = [job for job in jobs['jobs'] if job['name'] == expected['name']]
        assert len(selected) == 1
        job = selected[0]
        assert job['id'] == expected['id'] and job['status'] == 'completed' and job['conclusion'] == 'success'
        assert job['head_sha'] == product['recipeSha'] and job['run_id'] == product['runId'] and job['run_attempt'] == product['runAttempt']


def extract_formal(archive, destination):
    destination.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        assert len(entries) == 2 and set(bundle.namelist()) == {'agent-browser', 'provenance.json'}
        for entry in entries:
            assert not entry.is_dir() and (entry.external_attr >> 16) & 0o170000 != 0o120000
            assert entry.file_size <= 64 * 1024 * 1024
            (destination / entry.filename).write_bytes(bundle.read(entry))


def comparison_artifact(evidence):
    cell = comparison_environment(); product = cell['product']; workspace = Path(os.environ['GITHUB_WORKSPACE'])
    archive = evidence / 'diagnostic-artifact.zip'
    documents = {name: json.loads((evidence / name).read_text()) for name in
                 ('artifact-metadata.json', 'compile-jobs.json', 'producer-run.json', 'producer-commit.json')}
    verify_comparison_metadata(documents['artifact-metadata.json'], documents['compile-jobs.json'],
                               documents['producer-run.json'], documents['producer-commit.json'], digest(archive), cell)
    assert archive.stat().st_size == product['artifactBytes']
    if cell['arm'] == 'diag':
        # Keep the entire existing four-member diagnostic verifier unchanged.
        with contextlib.redirect_stdout(io.StringIO()): artifact(evidence)
        receipt = json.loads((evidence / 'production-identity.json').read_text())
    else:
        destination = workspace / 'formal-artifact'
        extract_formal(archive, destination)
        # Reuse the original formal verifier's exact assertions, not the diagnostic envelope.
        node = shutil.which('node'); assert node
        checked = subprocess.check_output([node, str(HERE / 'runtime.mjs'), 'formal-provenance'], text=True, timeout=30)
        proof = json.loads(checked)
        assert proof['verified'] is True and proof['artifactClass'] == 'formal-production'
        image = workspace / 'agent-browser'; assert not image.exists()
        shutil.copyfile(destination / 'agent-browser', image); image.chmod(0o755)
        assert digest(image) == product['binarySha256'] and image.stat().st_size == product['binaryBytes']
        shutil.copyfile(destination / 'provenance.json', evidence / 'artifact-provenance.json')
        receipt = dict(nativeSha=product['nativeSha'], nativeTree=product['nativeTree'], profile='ci', features=[],
                       binarySha256=digest(image), binaryBytes=image.stat().st_size, artifactId=product['artifactId'],
                       artifactDigest='sha256:' + product['artifactSha256'], runId=str(product['runId']),
                       runAttempt=str(product['runAttempt']), recipeSha=product['recipeSha'], sameRunArtifactVerified=False,
                       exactPriorArtifactVerified=True, nativeCompilationExecutedThisRun=False, nativeTestsExecutedThisRun=False,
                       consumerRunId=os.environ['GITHUB_RUN_ID'], consumerRunAttempt=os.environ['GITHUB_RUN_ATTEMPT'],
                       consumerRecipeSha=os.environ['GITHUB_WORKFLOW_SHA'], releaseEligible=False)
    receipt.update(comparisonCell=cell['id'], comparisonArm=cell['arm'], replicate=cell['replicate'],
                   artifactClass='formal-production' if cell['arm'] == 'formal' else 'temporary-diagnostic',
                   causalHooksExpected=product['causalHooksExpected'], experimentOnly=True, formalCandidateRuntimePass=False)
    save(evidence / 'production-identity.json', receipt)
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    assert len(sys.argv) == 2 and sys.argv[1] in ('artifact', 'positive', 'selection', 'comparison-artifact')
    globals()[sys.argv[1].replace('-', '_')](Path(os.environ['EVIDENCE_DIR']))
