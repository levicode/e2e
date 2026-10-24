#!/usr/bin/env python3
"""Synthetic, pure refusal tests. No original raw evidence, process or browser execution."""
import copy
import importlib.util
import json
import os
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest
import zipfile
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('reuse', HERE / 'reuse.py')
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
P, U = R.PINS, R.REUSE


def metadata(prior=False):
    return dict(id=U['priorEvidenceArtifactId' if prior else 'artifactId'], expired=False,
                digest='sha256:' + U['priorEvidenceArtifactSha256' if prior else 'artifactSha256'],
                name=(f"sw-causal-runtime-evidence-{U['runId']}-{U['runAttempt']}" if prior else
                      f"temporary-sw-causal-native-linux-x64-{P['nativeSha']}-{U['runId']}-{U['runAttempt']}"),
                size_in_bytes=U['artifactBytes'],
                workflow_run=dict(id=U['runId'], head_sha=U['recipeSha'], head_branch='implement/sw-causal-diagnostic-ci'))


def jobs():
    return dict(jobs=[dict(id=U[key], name='temporary-sw-causal-' + kind, run_id=U['runId'], run_attempt=U['runAttempt'],
                          head_sha=U['recipeSha'], status='completed', conclusion=conclusion)
                      for key, kind, conclusion in [('compileJobId', 'compile', 'success'), ('runtimeJobId', 'runtime', 'failure')]])


def fixture():
    source = {kind: dict(commit=P[kind + 'Sha'], tree=P[kind + 'Tree'], status='') for kind in ('e2e', 'native')}
    source.update(recipe=dict(commit=U['recipeSha'], tree=U['recipeTree'], status=''), pnpmLockSha256=P['e2eLockSha256'])
    product = {key: U[key] for key in ('binarySha256', 'binaryBytes', 'artifactId', 'recipeSha')}
    product.update(nativeSha=P['nativeSha'], nativeTree=P['nativeTree'], artifactDigest='sha256:' + U['artifactSha256'],
                   runId=str(U['runId']), runAttempt=str(U['runAttempt']), sameRunArtifactVerified=True,
                   diagnosticOnly=True, formalCandidate=False, releaseEligible=False, profile='ci', features=[])
    binding = dict(sourceRevision=P['e2eSha'], nativeSourceRevision=P['nativeSha'], testSourceDigest=U['relocatedFixtureSha256'],
                   binarySha256=U['binarySha256'], collectorSha256=U['collectorSha256'])
    chrome = dict(sha256=P['chromeSha256'], playwrightVersion=P['playwrightVersion'], chromiumRevision=P['chromiumRevision'],
                  version='Google Chrome for Testing ' + P['chromeVersion'])
    processes = [dict(pid=i + 100, startTicks=str(i + 1), role=role, borrowed=False, current=dict(status='absent'), absentChecks=3,
                      executableSha256=P['chromeSha256'] if role == 'chrome' else U['binarySha256'])
                 for i, role in enumerate(('native', 'proxy', 'chrome'))]
    processes[0]['terminalFileOwnerObservation'] = dict(writable=True, dev=1, ino=2, startTicks='1')
    case = dict(id='FIRST_EVENTS', testPassed=True, selectedEvidencePresent=True, runtimeImagesUnchanged=True,
                actualBrowserImageConfirmed=True, knownCleanupConfirmed=True, firstRunnerError=None, observerFirstError=None,
                report=dict(selectionExact=True, status='passed', success=True), status='failed-or-incomplete')
    result = dict(launcherExit=dict(code=0, signal=None), knownCleanupConfirmed=True, finallyEntered=True,
                  observationStopped=True, stdioClosed=True, spawnError=None, firstError=None, errors=[],
                  launcher=dict(spawnedByThisRunner=True, argv=['synthetic-pure-fixture']),
                  currentKnownProcesses=[dict(pid=p['pid'], startTicks=p['startTicks'], status='absent', absentChecks=3) for p in processes])
    docs = {'source-identity-before.json': source, 'source-identity.json': copy.deepcopy(source), 'production-identity.json': product,
            'browser-identity.json': chrome, 'FIRST_EVENTS/case-summary.json': case,
            'FIRST_EVENTS/capture-binding.json': dict(binding=binding, device=1, inode=2, rawSha256=U['priorRawSha256'], bytes=U['priorRawBytes']),
            'FIRST_EVENTS/plan.json': dict(binding=copy.deepcopy(binding), id='FIRST_EVENTS', title=R.TITLE, outerMaxMs=45000,
                                         syntheticBatch=False, temporaryNoSandbox='only this owned CI loopback fixture', selectedChrome=chrome,
                                         argv=['synthetic-pure-fixture']),
            'FIRST_EVENTS/vitest.json': dict(success=True, testResults=[dict(assertionResults=[dict(title=R.TITLE, status='passed', failureMessages=[])])]),
            'FIRST_EVENTS/result.json': result, 'FIRST_EVENTS/inventory.json': dict(processes=processes),
            'summary.json': dict(focusedCases=[dict(id='FIRST_EVENTS'), dict(id='HTTP500', status='not-run')]),
            'FIRST_EVENTS/startup-events.json': dict(count=1, violations=[], error=None, cleanup=dict(end='passed', dispose='passed', server='passed'))}
    decoder = dict(scopeDecoderVersion='sw-causal-scope-closure-v1', status='unknown',
                   traceVerdicts=[dict(source='native', status='closed', scopeClosed=True, successfulControl=True, missingFacts=[],
                                       decisionEvidence=dict(status='closed', kind='ready-initialized', finalOutcome=1),
                                       traceOwnedRecordsBeforeEnd=14, traceAttemptPrefix=14)],
                   positiveControlVisible=True, globalLosslessCapture=False, rawSha256=U['priorRawSha256'], diagnosticOnly=True,
                   formalCleanupPass=False, formalAcceptance=False)
    return docs, decoder


def verify(docs, decoder):
    return R.verify_prior_documents(docs, U['priorRawSha256'], U['priorRawBytes'], decoder)


class MetadataChecks(unittest.TestCase):
    def test_exact_producer_and_historical_runtime_are_distinct(self):
        for prior in (False, True):
            R.verify_origin_metadata(metadata(prior), jobs(), U['priorEvidenceArtifactSha256' if prior else 'artifactSha256'], prior=prior)
        self.assertEqual(R.producer_environment()['GITHUB_RUN_ID'], str(U['runId']))

    def test_wrong_artifact_digest_source_run_job_status_and_attempt_refuse(self):
        for prior in (False, True):
            sha = U['priorEvidenceArtifactSha256' if prior else 'artifactSha256']
            for key, value in [('id', 123), ('expired', True), ('digest', 'sha256:' + '0' * 64), ('name', 'formal-candidate')]:
                meta = metadata(prior); meta[key] = value
                with self.assertRaises(AssertionError): R.verify_origin_metadata(meta, jobs(), sha, prior=prior)
            for key, value in [('id', 123), ('head_sha', '0' * 40), ('head_branch', 'main')]:
                meta = metadata(prior); meta['workflow_run'][key] = value
                with self.assertRaises(AssertionError): R.verify_origin_metadata(meta, jobs(), sha, prior=prior)
            for key, value in [('id', 123), ('run_id', 123), ('run_attempt', 2), ('head_sha', '0' * 40), ('status', 'in_progress'), ('conclusion', 'skipped')]:
                value_jobs = jobs(); value_jobs['jobs'][int(prior)][key] = value
                with self.assertRaises(AssertionError): R.verify_origin_metadata(metadata(prior), value_jobs, sha, prior=prior)
            with self.assertRaises(AssertionError): R.verify_origin_metadata(metadata(prior), jobs(), '0' * 64, prior=prior)


class HistoricalChecks(unittest.TestCase):
    def test_reuses_positive_without_claiming_new_execution(self):
        result = verify(*fixture())
        self.assertFalse(result['executedThisRun']); self.assertFalse(result['nativeCompilationExecutedThisRun'])
        self.assertFalse(result['globalLosslessCapture']); self.assertFalse(result['formalAcceptance'])
        self.assertEqual(result['historicalCaseStatus'], 'failed-or-incomplete')

    def test_wrong_source_binding_and_product_refuse(self):
        for document, field in [('production-identity.json', 'binarySha256'), ('production-identity.json', 'artifactId'),
                                ('production-identity.json', 'recipeSha')]:
            docs, decoder = fixture(); docs[document][field] = 'wrong'
            with self.assertRaises(AssertionError): verify(docs, decoder)
        for kind in ('native', 'e2e', 'recipe'):
            for field in ('commit', 'tree', 'status'):
                docs, decoder = fixture(); docs['source-identity-before.json'][kind][field] = 'wrong'
                with self.assertRaises(AssertionError): verify(docs, decoder)
        for field in ('sourceRevision', 'nativeSourceRevision', 'testSourceDigest', 'binarySha256', 'collectorSha256'):
            docs, decoder = fixture(); docs['FIRST_EVENTS/capture-binding.json']['binding'][field] = 'wrong'
            with self.assertRaises(AssertionError): verify(docs, decoder)
        docs, decoder = fixture()
        with self.assertRaises(AssertionError): R.verify_prior_documents(docs, '0' * 64, U['priorRawBytes'], decoder)

    def test_missing_positive_or_historical_http500_execution_refuses(self):
        for field, value in [('positiveControlVisible', False), ('globalLosslessCapture', True), ('formalAcceptance', True), ('formalCleanupPass', True)]:
            docs, decoder = fixture(); decoder[field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)
        for field in ('testPassed', 'selectedEvidencePresent', 'runtimeImagesUnchanged', 'actualBrowserImageConfirmed', 'knownCleanupConfirmed'):
            docs, decoder = fixture(); docs['FIRST_EVENTS/case-summary.json'][field] = False
            with self.assertRaises(AssertionError): verify(docs, decoder)
        docs, decoder = fixture(); docs['summary.json']['focusedCases'][1]['status'] = 'failed-or-incomplete'
        with self.assertRaises(AssertionError): verify(docs, decoder)
        docs, decoder = fixture(); docs['FIRST_EVENTS/vitest.json']['testResults'][0]['assertionResults'].append(dict(title='HTTP500', status='passed'))
        with self.assertRaises(AssertionError): verify(docs, decoder)

    def test_old_decoder_and_nonclosed_or_cross_trace_positive_refuse(self):
        for field, value in [('scopeDecoderVersion', 'old'), ('status', 'closed'), ('traceVerdicts', [])]:
            docs, decoder = fixture(); decoder[field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)
        for field, value in [('source', 'proxy'), ('status', 'unknown'), ('scopeClosed', False), ('successfulControl', False),
                             ('missingFacts', ['missing-begin']), ('traceOwnedRecordsBeforeEnd', 13), ('traceAttemptPrefix', 15)]:
            docs, decoder = fixture(); decoder['traceVerdicts'][0][field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)
        for field, value in [('status', 'unknown'), ('kind', 'other'), ('finalOutcome', 0)]:
            docs, decoder = fixture(); decoder['traceVerdicts'][0]['decisionEvidence'][field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)
        docs, decoder = fixture()
        decoder['traceVerdicts'].append(copy.deepcopy(decoder['traceVerdicts'][0]))
        decoder['traceVerdicts'][0]['scopeClosed'] = False
        decoder['traceVerdicts'][1]['decisionEvidence']['kind'] = 'other'
        with self.assertRaises(AssertionError): verify(docs, decoder)

    def test_unsafe_or_unconfirmed_process_refuses(self):
        for index in range(3):
            for field, value in [('borrowed', True), ('absentChecks', 0), ('executableSha256', '0' * 64)]:
                docs, decoder = fixture(); docs['FIRST_EVENTS/inventory.json']['processes'][index][field] = value
                with self.assertRaises(AssertionError): verify(docs, decoder)
            docs, decoder = fixture(); docs['FIRST_EVENTS/inventory.json']['processes'][index]['current']['status'] = 'live'
            with self.assertRaises(AssertionError): verify(docs, decoder)
            docs, decoder = fixture(); docs['FIRST_EVENTS/result.json']['currentKnownProcesses'][index]['startTicks'] = 'wrong'
            with self.assertRaises(KeyError): verify(docs, decoder)
        for field, value in [('writable', False), ('dev', 8), ('ino', 9), ('startTicks', 'wrong')]:
            docs, decoder = fixture(); docs['FIRST_EVENTS/inventory.json']['processes'][0]['terminalFileOwnerObservation'][field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)
        for field, value in [('knownCleanupConfirmed', False), ('firstError', 'unsafe'), ('errors', ['unsafe']), ('spawnError', 'unsafe')]:
            docs, decoder = fixture(); docs['FIRST_EVENTS/result.json'][field] = value
            with self.assertRaises(AssertionError): verify(docs, decoder)

    def test_missing_document_refuses(self):
        for name in R.DOCUMENTS:
            docs, decoder = fixture(); del docs[name]
            with self.assertRaises(KeyError): verify(docs, decoder)

    def test_safe_extract_refuses_traversal_missing_positive_and_unexpected_http500(self):
        for bad in ('../escape', '/absolute', 'HTTP500/native.jsonl'):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); archive = root / 'prior.zip'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    for name in R.EXTRACT: bundle.writestr(name, b'{}')
                    bundle.writestr(bad, b'{}')
                with self.assertRaises(AssertionError): R.safe_extract(archive, root / 'out')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); archive = root / 'prior.zip'
            with zipfile.ZipFile(archive, 'w') as bundle: bundle.writestr('FIRST_EVENTS/native.jsonl', b'{}')
            with self.assertRaises(AssertionError): R.safe_extract(archive, root / 'out')

class ComparisonChecks(unittest.TestCase):
    def synthetic_metadata(self, arm):
        cell = R.comparison_cell(arm + '-1'); p = cell['product']
        meta = dict(id=p['artifactId'], expired=False, digest='sha256:' + p['artifactSha256'], size_in_bytes=p['artifactBytes'],
                    name=p['artifactName'], workflow_run=dict(id=p['runId'], head_sha=p['recipeSha'], head_branch=p['branch']))
        job_rows = [dict(j, head_sha=p['recipeSha'], run_id=p['runId'], run_attempt=p['runAttempt'], status='completed', conclusion='success') for j in p['requiredJobs']]
        jobs = dict(jobs=job_rows, total_count=len(job_rows))
        run = dict(id=p['runId'], run_attempt=p['runAttempt'], head_sha=p['recipeSha'], status='completed', conclusion='success' if arm == 'formal' else 'failure')
        commit = dict(sha=p['recipeSha'], tree=dict(sha=p['recipeTree']))
        return [meta, jobs, run, commit, p['artifactSha256'], cell]

    def test_fixed_four_cells_and_no_retry_or_extra_case(self):
        self.assertEqual([c['id'] for c in U['comparison']['cells']], ['formal-1', 'formal-2', 'diag-1', 'diag-2'])
        for key, value in [('maxAttemptsPerCell', 2), ('outerMaxMs', 50000), ('conditionalRetries', True),
                           ('additionalCasesAllowed', True), ('failFast', True), ('caseIds', ['HTTP500', 'HTTP500'])]:
            plan = copy.deepcopy(U['comparison']); plan[key] = value
            with self.assertRaises(AssertionError): R.comparison_cell('formal-1', plan)
        for cell in ('formal-0', 'formal-3', 'diag-3', '', 'HTTP500'):
            with self.assertRaises(AssertionError): R.comparison_cell(cell)

    def test_arm_environment_and_run_attempt_fail_closed(self):
        for arm in ('formal', 'diag'):
            cell = R.comparison_cell(arm + '-1'); p = cell['product']
            env = dict(COMPARISON_CELL=cell['id'], COMPARISON_ARM=arm, NATIVE_SHA=p['nativeSha'], NATIVE_TREE=p['nativeTree'], GITHUB_RUN_ATTEMPT='1')
            with patch.dict(os.environ, env): self.assertEqual(R.comparison_environment(), cell)
            for key in env:
                with patch.dict(os.environ, dict(env, **{key: 'wrong'})), self.assertRaises(AssertionError): R.comparison_environment()

    def test_correct_formal_and_diag_metadata_keep_original_overall_results(self):
        for arm in ('formal', 'diag'): R.verify_comparison_metadata(*self.synthetic_metadata(arm))
        diag = U['comparison']['products']['diag']
        for key in ('artifactId','artifactSha256','artifactBytes','binarySha256','binaryBytes','runId','runAttempt','recipeSha','recipeTree'):
            self.assertEqual(diag[key], U[key])
        self.assertEqual(U['comparison']['products']['formal']['artifactId'], 12574131092)
        self.assertFalse(U['comparison']['products']['formal']['causalHooksExpected'])
        self.assertTrue(diag['causalHooksExpected'])

    def test_wrong_artifact_producer_tree_job_or_cross_arm_refused(self):
        for arm in ('formal', 'diag'):
            for key, value in [('id', 1), ('digest', 'sha256:' + '0' * 64), ('size_in_bytes', 1), ('name', 'wrong'), ('expired', True)]:
                args = self.synthetic_metadata(arm); args[0][key] = value
                with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            for key in ('id', 'head_sha', 'head_branch'):
                args = self.synthetic_metadata(arm); args[0]['workflow_run'][key] = 'wrong'
                with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            for key in ('id', 'run_attempt', 'head_sha', 'status', 'conclusion'):
                args = self.synthetic_metadata(arm); args[2][key] = 'wrong'
                with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            for key in ('id', 'run_id', 'run_attempt', 'head_sha', 'status', 'conclusion'):
                args = self.synthetic_metadata(arm); args[1]['jobs'][0][key] = 'wrong'
                with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            args = self.synthetic_metadata(arm); args[3]['tree']['sha'] = '0' * 40
            with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            args = self.synthetic_metadata(arm); args[5] = R.comparison_cell('diag-1' if arm == 'formal' else 'formal-1')
            with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)
            args = self.synthetic_metadata(arm); args[1]['jobs'].append(copy.deepcopy(args[1]['jobs'][0]))
            with self.assertRaises(AssertionError): R.verify_comparison_metadata(*args)

    def test_formal_archive_has_exact_different_envelope(self):
        for names, accepted in [(('agent-browser', 'provenance.json'), True),
                                (('agent-browser', 'provenance.json', 'native-gates.json'), False),
                                (('agent-browser',), False), (('../agent-browser', 'provenance.json'), False)]:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); archive = root / 'formal.zip'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    for name in names: bundle.writestr(name, b'synthetic bytes only')
                if accepted: R.extract_formal(archive, root / 'out')
                else:
                    with self.assertRaises(AssertionError): R.extract_formal(archive, root / 'out')

if __name__ == '__main__': unittest.main()
