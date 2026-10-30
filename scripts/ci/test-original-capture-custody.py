"""Pure synthetic custody controls: no native binary, browser, or sockets."""
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('check-original-capture-invocations.py')
spec = importlib.util.spec_from_file_location('custody', SCRIPT)
custody = importlib.util.module_from_spec(spec)
spec.loader.exec_module(custody)


def put(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def dump(path, value):
    put(path, json.dumps(value) + '\n')


def mutate(path, **updates):
    value = json.loads(path.read_text()); value.update(updates); dump(path, value)


class SpawnCustodyTests(unittest.TestCase):
    def capture(self, change=lambda root: None):
        with tempfile.TemporaryDirectory(prefix='s5-pure-custody-') as tmp:
            previous = os.getcwd()
            env = {k: os.environ.get(k) for k in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']}
            os.chdir(tmp)
            try:
                root = pathlib.Path(tmp) / 'archive'
                put(root / 'test-e2e.log', 'original workload output\n')
                os.environ.update(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1')
                put(pathlib.Path('evidence/source.commit'), 'a' * 40)
                put(pathlib.Path('evidence/source.tree'), 'b' * 40)
                put(pathlib.Path('evidence/tools/popup-trace.sh'), 'wrapper')
                dump(pathlib.Path('scripts/ci/full-standard-runtime-pins.json'),
                     {'configured': True, 'ordinary': {'binarySha256': 'c' * 64}})
                for i, name in enumerate(['popup-init-order', 'popup-init-order-borrowed', 'replaced-nodes'], 1):
                    trace = root / name / ('run-a/native-trace' if name == 'replaced-nodes' else 'runner/native-trace')
                    if name != 'replaced-nodes': dump(root / name / 'report.json', {})
                    for proxy in [i * 100 + 1, i * 100 + 2]:
                        daemon = proxy * 9 + 13  # Deliberately nonconstant offsets.
                        receipt = dict(schemaVersion=2, pid=proxy, nonce=f'{proxy:064x}',
                                       traceDirectory=f'/tmp/p-{i:012x}/.e2e/native-trace',
                                       nativeExecutable='/verified/agent-browser', nativeSHA256='c' * 64,
                                       wrapperSHA256=hashlib.sha256(b'wrapper').hexdigest(), run='123',
                                       attempt='1', sourceCommit='a' * 40, sourceTree='b' * 40)
                        path = root / 'invocations' / f'invocation-{proxy}.json'
                        dump(path, receipt)
                        dump(root / 'invocations' / f'daemon-{proxy}.json',
                             dict(schemaVersion=1, kind='spawn-owned-daemon', proxyPID=proxy,
                                  daemonPID=daemon, nonce=receipt['nonce'], invocationSHA256=custody.digest(path)))
                        for kind in ['native', 'query']:
                            dump(trace / f'{kind}-{proxy}.jsonl', dict(pid=daemon, record=0, phase='CaptureStarted'))
                change(root)
                try:
                    return True, custody.verify(root)
                except (AssertionError, ValueError, OSError, KeyError, TypeError) as error:
                    return False, type(error).__name__
            finally:
                os.chdir(previous)
                for key, value in env.items():
                    if value is None: os.environ.pop(key, None)
                    else: os.environ[key] = value

    def rejects(self, change):
        self.assertFalse(self.capture(change)[0])

    def test_distinct_spawned_pids_accept_without_fixed_offsets(self):
        ok, plan = self.capture()
        self.assertTrue(ok)
        self.assertEqual(plan[0]['pids'], [101, 102])
        self.assertEqual(plan[0]['daemonPIDs'], [922, 931])

    def test_preexec_failure_cannot_reuse_prior_same_run_receipt(self):
        self.rejects(lambda r: put(r / 'test-e2e.log', 'NATIVE_INVOCATION_CUSTODY_FAILED\n'))

    def test_missing_mapping_including_reused_daemon_is_not_accepted(self):
        self.rejects(lambda r: (r / 'invocations/daemon-101.json').unlink())

    def test_mapping_closed_identity_mutations(self):
        for change in [dict(proxyPID=102), dict(proxyPID=True), dict(daemonPID=101), dict(daemonPID=0),
                       dict(daemonPID=True), dict(daemonPID=931), dict(nonce='f' * 64),
                       dict(invocationSHA256='f' * 64), dict(schemaVersion=True),
                       dict(kind='reused-daemon'), dict(extra='private')]:
            with self.subTest(change=change):
                self.rejects(lambda r: mutate(r / 'invocations/daemon-101.json', **change))

    def test_receipt_cross_run_source_binary_and_nonce_are_rejected(self):
        for change in [dict(run='122'), dict(attempt='2'), dict(sourceTree='d' * 40),
                       dict(sourceCommit='d' * 40), dict(nativeSHA256='d' * 64),
                       dict(wrapperSHA256='d' * 64), dict(nonce='f' * 64), dict(schemaVersion=True)]:
            with self.subTest(change=change):
                self.rejects(lambda r: mutate(r / 'invocations/invocation-101.json', **change))

    def test_extra_mapping_duplicate_keys_and_symlink_rejected(self):
        self.rejects(lambda r: dump(r / 'invocations/daemon-999.json', {}))
        self.rejects(lambda r: put(r / 'invocations/daemon-101.json', '{"schemaVersion":1,"schemaVersion":1}\n'))
        def symlink(r):
            path = r / 'invocations/daemon-101.json'; path.unlink(); path.symlink_to('daemon-102.json')
        self.rejects(symlink)

    def test_missing_extra_empty_or_wrong_native_and_query_rows_rejected(self):
        for kind in ['native', 'query']:
            for action in ['unlink', 'empty', 'wrongpid', 'boolpid', 'extra', 'no-newline']:
                def change(r):
                    p = r / 'popup-init-order/runner/native-trace' / f'{kind}-101.jsonl'
                    if action == 'unlink': p.unlink()
                    elif action == 'empty': put(p, '')
                    elif action == 'wrongpid': dump(p, dict(pid=923, record=0, phase='CaptureStarted'))
                    elif action == 'boolpid': dump(p, dict(pid=True, record=0, phase='CaptureStarted'))
                    elif action == 'extra': dump(p.with_name(f'{kind}-999.jsonl'), dict(pid=922))
                    else: put(p, p.read_text().rstrip('\n'))
                with self.subTest(kind=kind, action=action): self.rejects(change)

    def test_missing_all_traces_for_owned_invocation_remains_failure(self):
        self.rejects(lambda r: [(r / 'popup-init-order/runner/native-trace' / f'{k}-101.jsonl').unlink()
                               for k in ['native', 'query']])

    def test_trace_identity_cannot_self_attest_new_daemon(self):
        self.rejects(lambda r: [mutate(r / 'popup-init-order/runner/native-trace' / f'{k}-101.jsonl', pid=777)
                               for k in ['native', 'query']])



class NoFailureGateTests(unittest.TestCase):
    def gate(self, validation, code=0, business='1'):
        from unittest.mock import patch
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(prefix='no-failure-gate-') as tmp:
            old = os.getcwd(); os.chdir(tmp)
            try:
                root=pathlib.Path(tmp)/'archive'
                dump(root/'replaced-nodes/query-capture-validation.json',validation)
                put(pathlib.Path('evidence/test-e2e.exit'),business)
                put(pathlib.Path('evidence/source.commit'),'a' * 40)
                with patch.object(custody,'verify',return_value=[dict(fixture='replaced-nodes',expected=1)]), \
                     patch.object(custody.subprocess,'run',return_value=SimpleNamespace(returncode=code)), \
                     patch.object(custody.sys,'argv',['collector',str(root)]):
                    with self.assertRaises(SystemExit) as raised: custody.main()
                return raised.exception.code,json.loads(pathlib.Path('evidence/original-capture-status.json').read_text())
            finally: os.chdir(old)

    def test_complete_no_failure_is_distinct_and_does_not_rewrite_business_failure(self):
        validation=dict(completeEvidence=True,errors=[],fieldOnly=dict(targetedFailures=0,joinedFailures=0,
                        failureWitnessOutcome='not-applicable-target-passed'))
        code,summary=self.gate(validation)
        self.assertEqual(code,0)
        self.assertEqual(summary['originalPackageTestOutcome'],'failed')
        self.assertEqual(summary['fixtures'][0]['diagnosticOutcome'],'complete/no-target-failure')
        self.assertIs(summary['fixtures'][0]['targetedFailureWitnessObserved'],False)
        for report,exit_code in [(dict(validation,completeEvidence=False),0),
                                 (dict(validation,errors=['missing capture']),0),(validation,1)]:
            code,summary=self.gate(report,exit_code)
            self.assertNotEqual(code,0)
            self.assertFalse(summary['fixtures'][0]['completeEvidence'])

    def test_failed_scenario_still_requires_observed_strict_join(self):
        validation=dict(completeEvidence=True,errors=[],fieldOnly=dict(targetedFailures=1,joinedFailures=1,
                        failureWitnessOutcome='observed'))
        code,summary=self.gate(validation)
        self.assertEqual(code,0)
        self.assertIs(summary['fixtures'][0]['targetedFailureWitnessObserved'],True)
        self.assertEqual(summary['fixtures'][0]['diagnosticOutcome'],'complete')

if __name__ == '__main__': unittest.main()
