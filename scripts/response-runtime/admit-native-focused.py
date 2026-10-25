#!/usr/bin/env python3
"""One fixed prior focused-native receipt; reuse its exact raw-ledger parser, never execute tests."""
import hashlib, importlib.util, json, os, re, stat, sys, tempfile, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'pins.json').read_text())
EVIDENCE = Path(os.environ['EVIDENCE_DIR'])
PROOF = PINS['nativeFocused']
load = lambda path: json.loads(Path(path).read_text())
digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    assert PINS['enabled'] is True and PINS['sourceBindingFrozen'] is True
    assert PROOF['runId'] not in PINS['rejectedFocusedRuns']
    root = Path(sys.argv[1]).resolve()
    helper = root / 'scripts/response-entry/validate.py'
    proof_pins = helper.parent / 'pins.json'
    workflow = root / '.github/workflows/response-entry.yml'
    for path, key in [(helper,'helperSha256'),(proof_pins,'pinsSha256'),(workflow,'workflowSha256')]:
        assert digest(path) == PROOF[key], f'Prior verifier bytes changed: {key}'
    run, jobs, artifact, commit = [load(EVIDENCE / name) for name in ('native-focused-run.json','native-focused-jobs.json','native-focused-artifact.json','native-focused-recipe.json')]
    assert run['id'] == PROOF['runId'] and run['run_attempt'] == PROOF['runAttempt']
    assert run['status'] == 'completed' and run['conclusion'] == 'success'
    assert run['head_sha'] == PROOF['recipeSha'] and commit['sha'] == PROOF['recipeSha']
    assert commit['tree']['sha'] == PROOF['recipeTree']
    assert run['head_branch'] == 'validation/response-entry-green-20261025'
    assert run['repository']['full_name'] == 'levicode/e2e' and run['repository']['private'] is False
    assert run['event'] == 'push' and run['path'] == '.github/workflows/response-entry.yml'
    assert run['head_commit']['tree_id'] == PROOF['recipeTree']
    assert jobs['total_count'] == len(jobs['jobs'])
    selected = [job for job in jobs['jobs'] if job['id'] == PROOF['jobId']]
    assert len(selected) == 1
    job = selected[0]
    assert job['run_id'] == PROOF['runId'] and job['run_attempt'] == PROOF['runAttempt'] and job['head_sha'] == PROOF['recipeSha']
    assert job['name'] == 'response-entry-green-dev-evidence' and job['labels'] == ['ubuntu-24.04']
    assert job['status'] == 'completed' and job['conclusion'] == 'success'
    names = [step['name'] for step in job['steps']]
    assert names == PROOF['expectedJobStepNames'] and len(names) == len(set(names)), 'Missing, duplicate or unexpected original job step'
    assert all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in job['steps'])
    assert artifact['id'] == PROOF['artifactId'] and artifact['expired'] is False
    assert artifact['name'] == PROOF['artifactName'] == f"response-entry-green-{PROOF['runId']}-{PROOF['runAttempt']}"
    assert artifact['workflow_run']['id'] == PROOF['runId'] and artifact['workflow_run']['head_sha'] == PROOF['recipeSha']
    assert artifact['workflow_run']['repository_id'] == artifact['workflow_run']['head_repository_id'] == run['repository']['id'] == 1425853610
    assert artifact['digest'] == 'sha256:' + PROOF['archiveSha256']
    archive = EVIDENCE / 'native-focused.zip'
    assert archive.stat().st_size == artifact['size_in_bytes'] == PROOF['archiveBytes'] <= 64 * 1024 * 1024
    assert digest(archive) == PROOF['archiveSha256']
    e2e = load(EVIDENCE / 'e2e-source-commit.json')
    assert e2e['sha'] == PINS['e2eSha'] and e2e['tree']['sha'] == PINS['e2eTree']
    with tempfile.TemporaryDirectory(prefix='focused-native-proof-') as temp:
        evidence = Path(temp)
        with zipfile.ZipFile(archive) as zipped:
            members = zipped.infolist()
            assert len({m.filename for m in members}) == len(members)
            assert sum(m.file_size for m in members) <= 128 * 1024 * 1024
            for member in members:
                assert re.fullmatch(r'[A-Za-z0-9_.-]+', member.filename), 'Only original flat receipt files permitted'
                assert not stat.S_ISLNK(member.external_attr >> 16) and member.file_size <= 32 * 1024 * 1024
                (evidence / member.filename).write_bytes(zipped.read(member))
        spec = importlib.util.spec_from_file_location('frozen_native_focused_parser', helper)
        verifier = importlib.util.module_from_spec(spec); spec.loader.exec_module(verifier)
        verifier.EVIDENCE = evidence
        verifier.validate_pins()
        assert verifier.PINS['publishedNativeSha'] == PINS['nativeSha']
        assert verifier.PINS['candidateTree'] == PINS['nativeTree'] and verifier.PINS['nativeLockSha256'] == PINS['nativeLockSha256']
        binding = load(evidence / 'recipe-binding.json')
        assert binding['commit'] == PROOF['recipeSha'] and binding['tree'] == PROOF['recipeTree']
        assert binding['helperSha256'] == PROOF['helperSha256'] and binding['pinsSha256'] == PROOF['pinsSha256']
        assert binding['patchSha256'] == verifier.PINS['patchSha256']
        source = load(evidence / 'source-patch-identity.json')
        assert source['publishedHead'] == PINS['nativeSha'] and source['effectiveTree'] == PINS['nativeTree']
        assert source['forwardPatchMatchesCandidateTree'] is source['reversePatchRestoresExactBaseTree'] is True
        phases = verifier.COMPILE_PHASES + ['source-after-pure', 'pure-summary']
        for phase in phases:
            assert (evidence / f'{phase}.exit').read_text().strip() == '0', f'Failed or skipped phase: {phase}'
            result = load(evidence / f'{phase}.result.json')
            assert result['exit'] == 0 and result['timed_out'] is False and not result.get('interrupted')
            assert result['command'] == load(evidence / f'{phase}.command.json')
        expected_source = {'publishedHead':PINS['nativeSha'], 'baseHead':verifier.PINS['baseNativeSha'], 'baseTree':verifier.PINS['baseNativeTree'],
            'effectiveTree':PINS['nativeTree'], 'onlyTestOverlay':False, 'productionSourceChanged':True, 'lockSha256':PINS['nativeLockSha256']}
        for phase, tail in [('source-before',['pristine']),('source-after-pure',[])]:
            assert load(evidence / f'{phase}.stdout.log') == expected_source
            command = load(evidence / f'{phase}.result.json')['command']
            assert command == ['python3','-B','/home/runner/work/e2e/e2e/recipe/scripts/response-entry/validate.py',
                               'source','/home/runner/work/e2e/e2e/source',*tail]
        strict = {
            'format':['cargo','fmt','--all','--','--check'],
            'clippy':['cargo','clippy','--locked','--profile','dev','--no-default-features','--all-targets','--','-D','warnings'],
            'acceptance-tests-check':['cargo','check','--locked','--profile','dev','--no-default-features','--features','acceptance-faults','--tests'],
            'proxy-feature-check':['cargo','check','--locked','--profile','dev','--no-default-features','--features','acceptance-faults','--test','client-proxy-fixture'],
        }
        for phase, command in strict.items(): assert load(evidence / f'{phase}.result.json')['command'] == command
        cases = [verifier.verify_saved_case(case) for case in verifier.PINS['cases']]
        assert len(cases) == PROOF['expectedCaseCount'] and all(row['actual'] == 'passed' and row['testPassed'] is True and row['expectedObservationConfirmed'] is True for row in cases)
        summary = load(evidence / 'response-entry-verified.json')
        assert summary['nativeSha'] == PINS['nativeSha'] and summary['nativeTree'] == PINS['nativeTree']
        assert summary['runId'] == PROOF['runId'] and summary['runAttempt'] == PROOF['runAttempt'] and summary['recipeSha'] == PROOF['recipeSha']
        assert summary['selectedCaseCount'] == summary['passedTestCount'] == PROOF['expectedCaseCount'] == 9
        assert summary['failedTestCount'] == summary['unknownTestCount'] == 0
        assert summary['verifiedSuccess'] is summary['allTestsPassed'] is True and summary['cases'] == cases
        assert summary['phases'] == {phase:'0' for phase in verifier.COMPILE_PHASES + ['source-after-pure']}
        assert summary['fullNativeSuitePassed'] is summary['productionImageBuilt'] is summary['originalE2eRetired'] is False
        aggregate = load(evidence / 'aggregate.json')
        assert aggregate['phases'] == {phase:'0' for phase in phases}
        assert aggregate['verifiedSuccess'] is aggregate['allTestsPassed'] is True
        assert aggregate['productionImageBuilt'] is aggregate['releaseEligible'] is False
        receipt = {'verifiedSuccess':True,'runId':PROOF['runId'],'runAttempt':PROOF['runAttempt'],'nativeSha':PINS['nativeSha'],'nativeTree':PINS['nativeTree'],
            'selectedCaseCount':len(cases),'passedTestCount':len(cases),'failedTestCount':0,'notRunTestCount':0,'unknownTestCount':0,
            'artifactId':PROOF['artifactId'],'archiveSha256':PROOF['archiveSha256'],'recipeSha':PROOF['recipeSha'],'recipeTree':PROOF['recipeTree'],
            'reusedRawLedgerParserSha256':digest(helper),'scope':'Response ingress actual nine default-dev cases and four strict gates only; not full native or optimized tests',
            'fullNativeSuitePassed':False,'optimizedNativeTestsExecuted':False,'nativeTestsExecutedThisProducer':False}
        (EVIDENCE / 'native-focused-verified.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps(receipt,indent=2))

if __name__ == '__main__': main()
