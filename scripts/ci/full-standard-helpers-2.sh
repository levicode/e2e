set -euo pipefail
cat > evidence/tools/validate-vitest.py <<'HELPER_3'
# Core platform applicability is a source-locked classification, never an allowed-skip list.
import collections
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

COLLECT = 'packages/e2e/tests/unit/collect.test.ts'
OBSERVER = 'packages/e2e/tests/helpers/collect-fs-applicability.ts'
LOADER = 'packages/e2e/tests/integration/typescript-loader.test.ts'
LOADER_SOURCE_SHA256 = 'de83bc53e06c18c586ab507465e99af5de16cdd7f1211a24d1643832174fae5b'
LOADER_TITLE = ('the TypeScript loader', 'compiles a .cts a loader earlier in the chain hands on without source, as Yarn PnP does')
LOADER_PREDICATE = r'/^24\.(?:[89]|10)\.|^24\.11\.0$/.test(process.versions.node)'
CONTAINER = 'scripts/ci/full-standard-helpers-2.sh'
GENERATED = 'evidence/tools/validate-vitest.py'
CORE_COLLECTOR = 'evidence/tools/collect-core.mjs'
BASE_COLLECT_SHA256 = '7276a4dafbe8394330baf2edb3020981439b9b6d203bc15e237c392331ba63b5'
OBSERVER_IMPORT = "import { recordCollectFsCapability } from '../helpers/collect-fs-applicability.ts';\n"
OBSERVER_CALL = '  recordCollectFsCapability(root, caseInsensitiveFs, import.meta.url);\n'
CASES = [
    (('selectPositionals', 'follows on-disk casing for existing files and directories on a case-insensitive filesystem'), True, '!caseInsensitiveFs'),
    (('selectPositionals', 'treats a differently cased path as unmatched on a case-sensitive filesystem'), False, 'caseInsensitiveFs'),
    (('excludingEntry', 'compares an existing file in its on-disk casing on a case-insensitive filesystem'), True, '!caseInsensitiveFs'),
]
CONTEXT_KEYS = {'schemaVersion', 'kind', 'nonce', 'sourceCommit', 'sourceTree', 'sourceInventorySHA256',
                'collectSourceSHA256', 'observerSourceSHA256', 'validatorSourceSHA256', 'consumerRun',
                'consumerAttempt', 'job', 'nodeSelector', 'nodeVersion', 'invocationKind', 'collectionSHA256', 'tempRootRealpath'}
CONTEXT_CONSTANTS = {'schemaVersion': 1, 'kind': 'collect-fs-context/v1', 'invocationKind': 'core-full-suite'}
EXPECTED_KEYS = CONTEXT_KEYS - set(CONTEXT_CONSTANTS) - {'nonce'}
RECEIPT_KEYS = {'schemaVersion', 'kind', 'contextSHA256', 'nonce', 'workerPid', 'moduleSourceSHA256',
                'observerSourceSHA256', 'rootRealpath', 'originalCaseInsensitiveFs', 'validatedCaseInsensitiveFs',
                'observation', 'recheckedObservation'}
OBSERVATION_KEYS = {'root', 'tests', 'canonical', 'alternate', 'alternateLookupOutcome'}
IDENTITY_KEYS = {'realpath', 'dev', 'ino', 'type', 'symlink'}
EXCLUDED_INVENTORY = {'.github/workflows/full-standard-node-matrix.yml', '.github/workflows/s5-focused-original-core.yml', 'scripts/ci/full-standard-runtime-pins.json'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, 'duplicate JSON key: ' + key
        result[key] = value
    return result

def parsed(data):
    return json.loads(data, object_pairs_hook=unique_object)

def closed(value, keys, label):
    assert type(value) is dict and set(value) == keys, label + ': unknown or missing fields'

def regular_bytes(path, maximum):
    path = pathlib.Path(path)
    assert path.is_absolute() and path == path.resolve(), 'noncanonical or symlink evidence path'
    before = path.lstat()
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'nonregular, empty, linked or oversized evidence'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        assert stat.S_ISREG(opened.st_mode) and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'evidence changed during open'
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(fd)
        assert 0 < len(data) == opened.st_size <= maximum and after.st_nlink == 1
        assert (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'evidence changed during read'
        return data
    finally:
        os.close(fd)

def absolute_canonical(value):
    assert type(value) is str and value and '\x00' not in value
    p = pathlib.Path(value)
    assert p.is_absolute() and str(p) == value and '..' not in p.parts, 'noncanonical absolute path'
    return p

def file_identity(value, root):
    p = absolute_canonical(value)
    assert p == p.resolve() and p.is_relative_to(root) and p != root, 'test file outside checkout or noncanonical'
    return str(p)

def census(collection, result, root):
    assert type(collection) is list and collection, 'missing complete collection'
    expected = collections.Counter()
    for row in collection:
        assert type(row) is dict and type(row.get('name')) is str and row['name'], 'invalid collection row'
        expected[(file_identity(row['file'], root), row['name'])] += 1
    assert type(result) is dict and type(result.get('testResults')) is list and result['testResults'], 'missing complete results'
    actual, structural, rows = collections.Counter(), collections.Counter(), []
    joined_paths = collections.defaultdict(set)
    for suite in result['testResults']:
        filename = file_identity(suite['name'], root)
        assert type(suite['assertionResults']) is list, 'invalid assertion list'
        assert suite.get('testExecError') is None and suite.get('status', 'passed') == 'passed' and suite.get('message', '') == '', 'suite execution error'
        for assertion in suite['assertionResults']:
            ancestors, title = assertion['ancestorTitles'], assertion['title']
            assert type(ancestors) is list and all(type(x) is str and x for x in ancestors)
            assert type(title) is str and title, 'invalid title path'
            title_path = tuple(ancestors + [title])
            assert assertion['fullName'] == ' '.join(title_path), 'fullName contradicts structural titlePath'
            identity = (filename, title_path)
            joined = (filename, ' > '.join(title_path))
            actual[joined] += 1; structural[identity] += 1; joined_paths[joined].add(title_path)
            rows.append({'file': filename, 'titlePath': title_path, 'fullName': assertion['fullName'], 'status': assertion['status']})
    # Existing parameterized declarations may repeat a file/title identity. Preserve
    # their complete Counter multiplicity; never deduplicate or claim unique task IDs.
    assert all(len(paths) == 1 for paths in joined_paths.values()), 'ambiguous joined result titlePath'
    assert expected == actual, 'complete collection/result identity multiplicity mismatch'
    for title_path, _, _ in CASES:
        assert expected[(str(root / COLLECT), ' > '.join(title_path))] == 1, 'conditional collection identity must occur exactly once'
        assert structural[(str(root / COLLECT), title_path)] == 1, 'conditional result titlePath must occur exactly once'
    loader_identity = (str(root / LOADER), LOADER_TITLE)
    assert expected[(loader_identity[0], ' > '.join(LOADER_TITLE))] == 1, 'original loader collection identity must occur exactly once'
    assert structural[loader_identity] == 1, 'original loader result titlePath must occur exactly once'
    return rows

def verify_collect_source(data):
    text = data.decode('utf-8')
    assert text.count(OBSERVER_IMPORT) == text.count(OBSERVER_CALL) == 1, 'observer instrumentation missing/duplicated'
    assert "import { afterAll, beforeAll, describe, expect, it } from 'vitest';\n" + OBSERVER_IMPORT in text
    assert "  caseInsensitiveFs = existsSync(path.join(root, 'tests', 'Agent'));\n" + OBSERVER_CALL in text
    original = text.replace(OBSERVER_IMPORT, '', 1).replace(OBSERVER_CALL, '', 1).encode('utf-8')
    assert sha(original) == BASE_COLLECT_SHA256, 'original collect tests/probe/predicates changed'

def extract_validator(data):
    start = b"cat > evidence/tools/validate-vitest.py <<'HELPER_3'\n"
    end = b'\nHELPER_3\n'
    assert data.count(start) == 1, 'ambiguous validator helper'
    rest = data.split(start, 1)[1]
    assert end in rest, 'missing helper terminator'
    return rest.split(end, 1)[0] + b'\n'

def extract_core_collector(data):
    start = b"cat > evidence/tools/collect-core.mjs <<'CORE_COLLECTION'\n"
    end = b'\nCORE_COLLECTION\n'
    assert data.count(start) == 1 and data.count(end) == 1, 'missing or ambiguous core collector heredoc'
    rest = data.split(start, 1)[1]
    assert end in rest, 'missing core collector terminator'
    return rest.split(end, 1)[0] + b'\n'

def verify_core_collector(root, container_bytes):
    actual = regular_bytes(root / CORE_COLLECTOR, 1024 * 1024)
    assert actual == extract_core_collector(container_bytes), 'generated core collector differs from current source helper'
    return sha(actual)

def collect_node_identity(requested, actual_version):
    selector = re.fullmatch(r'(22|24|26)(?:\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2}))?', requested) if type(requested) is str else None
    actual = re.fullmatch(r'v(22|24|26)\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})', actual_version) if type(actual_version) is str else None
    assert selector is not None and actual is not None, 'canonical requested and actual Node versions'
    assert selector[1] == actual[1] if selector[2] is None else actual_version == 'v' + requested, 'actual Node differs from requested selector'
    return actual_version[1:]

def current_expected(root, p):
    # These values come from the current checkout/environment, never from the context or receipt.
    assert root == pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()
    assert p == root / 'evidence/e2e' and p == p.resolve()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], env={**os.environ, 'GIT_NO_LAZY_FETCH': '1'})
    commit = git('rev-parse', 'HEAD').decode().strip()
    tree = git('rev-parse', 'HEAD^{tree}').decode().strip()
    assert os.environ['GITHUB_SHA'] == commit, 'GitHub/source commit mismatch'
    assert git('status', '--porcelain', '--untracked-files=no') == b'', 'tracked source changed'
    assert (root / 'evidence/source.commit').read_text().strip() == commit
    assert (root / 'evidence/source.tree').read_text().strip() == tree
    inventory = b''.join(line for line in git('ls-tree', '-r', 'HEAD').splitlines(keepends=True)
                         if line.rstrip(b'\n').split(b'\t', 1)[1].decode() not in EXCLUDED_INVENTORY)
    assert (root / 'evidence/source-inventory.txt').read_bytes() == inventory, 'current source inventory differs'
    source = {}
    for path in [COLLECT, OBSERVER, CONTAINER, LOADER]:
        actual = regular_bytes(root / path, 4 * 1024 * 1024)
        assert actual == git('show', 'HEAD:' + path), 'current source bytes differ from Git: ' + path
        source[path] = actual
    verify_collect_source(source[COLLECT])
    verify_loader_source(source[LOADER])
    generated = regular_bytes(root / GENERATED, 4 * 1024 * 1024)
    assert pathlib.Path(__file__).resolve() == root / GENERATED, 'unexpected validator execution path'
    assert extract_validator(source[CONTAINER]) == generated, 'generated validator differs from current source helper'
    verify_core_collector(root, source[CONTAINER])
    node_version = subprocess.check_output(['node', '--version'], text=True).strip()
    assert (root / 'evidence/node.version').read_text().strip() == node_version, 'current Node version differs'
    temp_root = subprocess.check_output(['node', '-p', "require('node:fs').realpathSync(require('node:os').tmpdir())"], text=True).strip()
    node_selector = collect_node_identity(os.environ.get('NODE_SELECTOR'), node_version)
    assert os.environ['LANE'] == 'core', 'wrong CI lane'
    return {'sourceCommit': commit, 'sourceTree': tree, 'sourceInventorySHA256': sha(inventory),
            'collectSourceSHA256': sha(source[COLLECT]), 'observerSourceSHA256': sha(source[OBSERVER]),
            'validatorSourceSHA256': sha(generated), 'consumerRun': os.environ['GITHUB_RUN_ID'],
            'consumerAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'job': os.environ['GITHUB_JOB'],
            'nodeSelector': node_selector, 'nodeVersion': node_version,
            'collectionSHA256': sha((p / 'collection.json').read_bytes()), 'tempRootRealpath': temp_root}

def validate_context(context, expected):
    closed(context, CONTEXT_KEYS, 'context')
    closed(expected, EXPECTED_KEYS, 'trusted current identity')
    for key, value in CONTEXT_CONSTANTS.items():
        assert type(context[key]) is type(value) and context[key] == value, 'context schema/kind/invocation mismatch'
    assert type(context['nonce']) is str and re.fullmatch('[0-9a-f]{64}', context['nonce']), 'invalid context nonce'
    for key in ['sourceCommit', 'sourceTree']:
        assert type(expected[key]) is str and re.fullmatch('[0-9a-f]{40}', expected[key]) and expected[key] != '0' * 40
    for key in ['sourceInventorySHA256', 'collectSourceSHA256', 'observerSourceSHA256', 'validatorSourceSHA256', 'collectionSHA256']:
        assert type(expected[key]) is str and re.fullmatch('[0-9a-f]{64}', expected[key])
    for key in ['consumerRun', 'consumerAttempt']:
        assert type(expected[key]) is str and re.fullmatch('[1-9][0-9]*', expected[key])
    assert type(expected['job']) is str and re.fullmatch('[A-Za-z_][A-Za-z_0-9-]*', expected['job'])
    assert type(expected['nodeSelector']) is str and re.fullmatch(r'[1-9][0-9]*\.[0-9]+\.[0-9]+', expected['nodeSelector'])
    assert expected['nodeVersion'] == 'v' + expected['nodeSelector']
    absolute_canonical(expected['tempRootRealpath'])
    for key in EXPECTED_KEYS:
        assert type(context[key]) is type(expected[key]) and context[key] == expected[key], 'context differs from independently current ' + key

def directory_identity(value):
    closed(value, IDENTITY_KEYS, 'directory identity')
    assert value['type'] == 'directory' and value['symlink'] is False, 'non-directory/symlink observation'
    absolute_canonical(value['realpath'])
    assert type(value['dev']) is str and re.fullmatch('0|[1-9][0-9]*', value['dev'])
    assert type(value['ino']) is str and re.fullmatch('[1-9][0-9]*', value['ino'])

def validate_receipt(receipt, context, context_bytes, expected):
    closed(receipt, RECEIPT_KEYS, 'receipt')
    assert type(receipt['schemaVersion']) is int and receipt['schemaVersion'] == 1 and receipt['kind'] == 'collect-fixture-case-capability/v1'
    assert receipt['contextSHA256'] == sha(context_bytes) and receipt['nonce'] == context['nonce'], 'stale/foreign context or nonce'
    assert type(receipt['workerPid']) is int and receipt['workerPid'] > 0
    assert receipt['moduleSourceSHA256'] == expected['collectSourceSHA256'] and receipt['observerSourceSHA256'] == expected['observerSourceSHA256'], 'foreign observer/module source'
    original, validated = receipt['originalCaseInsensitiveFs'], receipt['validatedCaseInsensitiveFs']
    assert type(original) is bool and type(validated) is bool and original == validated, 'unknown or contradictory capability'
    observation = receipt['observation']
    for observed in [observation, receipt['recheckedObservation']]:
        closed(observed, OBSERVATION_KEYS, 'observation')
        for key in ['root', 'tests', 'canonical']:
            directory_identity(observed[key])
        if original:
            directory_identity(observed['alternate'])
        else:
            assert observed['alternate'] is None
    assert observation == receipt['recheckedObservation'], 'observation race/disagreement'
    fixture = absolute_canonical(receipt['rootRealpath'])
    assert fixture.parent == pathlib.Path(expected['tempRootRealpath']) and re.fullmatch('e2e-collect-[A-Za-z0-9]+', fixture.name), 'wrong fixture temporary root'
    assert observation['root']['realpath'] == str(fixture)
    assert observation['tests']['realpath'] == str(fixture / 'tests')
    assert observation['canonical']['realpath'] == str(fixture / 'tests/agent')
    if original:
        directory_identity(observation['alternate'])
        assert observation['alternateLookupOutcome'] == 'same-directory' and observation['alternate'] == observation['canonical'], 'alternate is not the same accessible canonical directory'
    else:
        assert observation['alternate'] is None and observation['alternateLookupOutcome'] == 'absent-ENOENT', 'false capability requires explicit ENOENT, not access/IO/error'
    return original

def verify_loader_source(source):
    assert sha(source) == LOADER_SOURCE_SHA256, 'original loader source/predicate/declaration changed'

def loader_not_applicable(node_version):
    # Mirror only the immutable original predicate, against the current full Node version.
    assert type(node_version) is str and re.fullmatch(r'v(?:22|24|26)\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})', node_version), 'canonical actual Node version required'
    return re.search(r'^24\.(?:[89]|10)\.|^24\.11\.0$', node_version[1:]) is not None

def classify_core(root, collection, result, command_exit, context_bytes, receipt_bytes, expected):
    # Complete identity census is deliberately first, before any applicability classification.
    rows = census(collection, result, root)
    context, receipt = parsed(context_bytes), parsed(receipt_bytes)
    validate_context(context, expected)
    capability = validate_receipt(receipt, context, context_bytes, expected)
    conditional = {(str(root / COLLECT), title_path): (applicable, predicate) for title_path, applicable, predicate in CASES}
    multiplicities = collections.Counter((row['file'], row['titlePath']) for row in rows)
    assert all(multiplicities[identity] == 1 for identity in conditional), 'original conditional declaration missing, repeated or renamed'
    inapplicable = {identity for identity, (applicable, _) in conditional.items() if applicable != capability}
    assert len(inapplicable) == (1 if capability else 2)
    verify_loader_source(regular_bytes(root / LOADER, 4 * 1024 * 1024))
    loader_identity = (str(root / LOADER), LOADER_TITLE)
    loader_skipped = loader_not_applicable(expected['nodeVersion'])
    if loader_skipped:
        inapplicable.add(loader_identity)
    not_applicable = []
    for row in rows:
        identity = (row['file'], row['titlePath'])
        if identity in inapplicable:
            assert row['status'] in ['pending', 'skipped'], 'inapplicable branch must retain its original raw skip, never synthetic PASS'
            if identity == loader_identity:
                not_applicable.append({'file': row['file'], 'titlePath': list(row['titlePath']), 'fullName': row['fullName'],
                                       'rawStatus': row['status'], 'originalSkipPredicate': LOADER_PREDICATE,
                                       'nodeVersion': expected['nodeVersion'], 'sourceSHA256': LOADER_SOURCE_SHA256,
                                       'classification': 'notApplicable'})
                continue
            not_applicable.append({'file': row['file'], 'titlePath': list(row['titlePath']), 'fullName': row['fullName'],
                                   'rawStatus': row['status'], 'originalSkipPredicate': conditional[identity][1],
                                   'caseInsensitiveFs': capability, 'classification': 'notApplicable'})
        else:
            assert row['status'] == 'passed', 'applicable assertion not PASS (failed/pending/todo/cancelled/unknown)'
    passed = sum(row['status'] == 'passed' for row in rows)
    raw_counts = {'numTotalTests': len(rows), 'numPassedTests': passed, 'numFailedTests': 0,
                  'numPendingTests': len(inapplicable), 'numTodoTests': 0}
    for key, value in raw_counts.items():
        assert type(result.get(key)) is int and result[key] == value, 'raw JSON counter differs from actual rows: ' + key
    assert type(command_exit) is int and command_exit == 0 and result.get('success') is True, 'command/runtime failure'
    assert result.get('numFailedTestSuites', 0) == 0 and result.get('numRuntimeErrorTestSuites', 0) == 0 and result.get('unhandledErrors', []) == []
    assert passed == len(rows) - len(inapplicable)
    return {'coverageComplete': True, 'coverageCompleteMeaning': 'All tests applicable on the measured temporary fixture filesystem and actual Node version executed and passed; original inapplicable branches were not executed here.',
            'declaredRequired': len(collection), 'reportedRequired': len(rows), 'applicableRequired': len(rows) - len(inapplicable),
            'censusMeaning': 'Complete file/titlePath Counter multiplicity; only the four source-locked conditional identities are unique, not a unique-task-ID claim.',
            'requiredPassed': passed, 'notApplicable': not_applicable, 'optionalNotExecuted': [], 'missing': [], 'extra': [],
            'counts': raw_counts, 'commandExit': command_exit, 'sourceCommit': expected['sourceCommit'], 'sourceTree': expected['sourceTree'],
            'applicability': {'caseInsensitiveFs': capability, 'contextSHA256': sha(context_bytes), 'receiptSHA256': sha(receipt_bytes),
                              'nonce': context['nonce'], 'collectSourceSHA256': expected['collectSourceSHA256'],
                              'observerSourceSHA256': expected['observerSourceSHA256'], 'validatorSourceSHA256': expected['validatorSourceSHA256'],
                              'sourceInventorySHA256': expected['sourceInventorySHA256'], 'consumerRun': expected['consumerRun'],
                              'consumerAttempt': expected['consumerAttempt'], 'job': expected['job'], 'nodeSelector': expected['nodeSelector'],
                              'nodeVersion': expected['nodeVersion'], 'fixtureRoot': receipt['rootRealpath'],
                              'trustBoundary': 'Reviewed current-job source and artifact integrity, not cryptographic host attestation'}}

def load_receipts(directory):
    assert directory == directory.resolve() and stat.S_ISDIR(directory.lstat().st_mode), 'invalid applicability directory'
    assert {entry.name for entry in directory.iterdir()} == {'context.json', 'receipt.json'}, 'missing/duplicate/unexpected applicability file'
    return regular_bytes(directory / 'context.json', 8192), regular_bytes(directory / 'receipt.json', 16384)

def core_main(root, p):
    report = {'coverageComplete': False, 'requiredPassed': None, 'notApplicable': [], 'error': None}
    try:
        collection_bytes = (p / 'collection.json').read_bytes(); result_bytes = (p / 'results.json').read_bytes()
        command_bytes = (p / 'command.exit').read_bytes()
        collection, result = parsed(collection_bytes), parsed(result_bytes)
        census(collection, result, root)  # No context/receipt can exempt a missing declaration.
        expected = current_expected(root, p)
        context_bytes, receipt_bytes = load_receipts(p / 'platform-applicability')
        assert re.fullmatch(b'0\n?', command_bytes), 'nonzero or malformed test command exit'
        report = classify_core(root, collection, result, 0, context_bytes, receipt_bytes, expected)
        collector_sha = verify_core_collector(root, regular_bytes(root / CONTAINER, 4 * 1024 * 1024))
        report['captures'] = {'collectorSHA256': collector_sha, 'collectionSHA256': sha(collection_bytes), 'resultsSHA256': sha(result_bytes), 'commandExitSHA256': sha(command_bytes),
                              'contextSHA256': sha(context_bytes), 'receiptSHA256': sha(receipt_bytes)}
    except Exception as error:
        report['coverageComplete'] = False
        report['error'] = {'type': type(error).__name__, 'message': str(error)}
        (p / 'coverage.json').write_text(json.dumps(report, indent=2) + '\n')
        raise
    (p / 'coverage.json').write_text(json.dumps(report, indent=2) + '\n')


def legacy_validate():
    import json,pathlib,collections,sys
    p=pathlib.Path(sys.argv[1]);c=json.loads((p/'collection.json').read_text());r=json.loads((p/'results.json').read_text());assert isinstance(c,list) and c
    expected=collections.Counter((x['file'],x['name']) for x in c);actual=collections.Counter();optional=[];allrows=[]
    optional_file=(pathlib.Path.cwd()/'packages/web/tests/integration/crosscheck.test.ts').as_posix();optional_name='cross-check web-benchmark scenarios every scenario'
    for f in r['testResults']:
     for a in f['assertionResults']:
      identity=(f['name'],' > '.join(a['ancestorTitles']+[a['title']]));allrows.append(a)
      if f['name']==optional_file and a['fullName']==optional_name and a['status'] in ['pending','skipped']:
       optional.append({'file':f['name'],'fullName':a['fullName'],'status':'optional-not-executed','reason':'existing formal external benchmark contract'})
       if expected[identity]:expected[identity]-=1
      else:actual[identity]+=1
    expected=+expected
    # Full ordinary Web must retain the optional declaration in its actual run report even though Vitest list omits static skips.
    if p.name=='ordinary' and p.parent.name=='web':assert len(optional)==1
    else:assert not optional
    out={'listedRequired':sum(expected.values()),'totalReported':len(allrows),'requiredExecutedReports':sum(actual.values()),'requiredPassed':sum(a['status']=='passed' for a in allrows),'optionalNotExecuted':optional,'missing':list((expected-actual).elements()),'extra':list((actual-expected).elements()),'counts':{k:r.get(k) for k in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests']},'commandExit':int((p/'command.exit').read_text())};(p/'coverage.json').write_text(json.dumps(out,indent=2)+'\n')
    assert expected==actual,'required collection/result identity mismatch'
    assert r['numTotalTests']==len(allrows) and r['numFailedTests']==0 and r['numPendingTests']==len(optional) and r.get('numTodoTests',0)==0
    assert out['requiredPassed']==sum(actual.values()) and out['commandExit']==0 and r.get('success') is True


if __name__ == '__main__':
    root = pathlib.Path.cwd().resolve()
    p = pathlib.Path(sys.argv[1]).absolute()
    if p == root / 'evidence/e2e' or p.resolve() == (root / 'evidence/e2e').resolve():
        core_main(root, p)
    else:
        legacy_validate()
HELPER_3
cat > evidence/tools/validate-scripts.py <<'HELPER_4'
import json,pathlib

def coverage(selected,rows,command_exit,root):
 root=pathlib.Path(root).resolve()
 expected={str((root/x).resolve()):x for x in selected}
 assert len(expected)==len(selected) and expected
 assert all(not pathlib.Path(x).is_absolute() and str((root/x).resolve()).startswith(str(root)+'/scripts/') and x.endswith('.test.ts') for x in selected)
 terminal={str(pathlib.Path(x['file']).resolve()) for x in rows if x.get('file') and x['type']=='test:pass' and x.get('nesting')==0 and not x.get('skip') and not x.get('todo')}
 fallback=[]
 for file,relative in expected.items():
  if file in terminal:continue
  completed=[x for x in rows if x['type']=='test:complete' and x.get('file')==file and x.get('name')==relative and x.get('nesting')==0]
  summaries=[x for x in rows if x['type']=='test:summary' and x.get('file')==file]
  if len(completed)!=1 or len(summaries)!=1:continue
  done=completed[0];summary=summaries[0]['summary'];counts=summary.get('counts',{})
  if done.get('skip') or done.get('todo') or done.get('details',{}).get('error') or done.get('details',{}).get('type')!='test':continue
  if summary.get('file')!=file or summary.get('success') is not True or not isinstance(counts.get('tests'),int) or counts['tests']<=0 or counts.get('passed')!=counts['tests']:continue
  if any(counts.get(k)!=0 for k in ['failed','cancelled','skipped','todo']):continue
  terminal.add(file);fallback.append({'file':file,'evidence':'exact wrapper and file summary','tests':counts['tests'],'passed':counts['passed']})
 missing=sorted(set(expected)-terminal);bad=[x for x in rows if x['type'] in ['test:fail','test:interrupted'] or x.get('skip') or x.get('todo')];summaries=[x['summary'] for x in rows if x['type']=='test:summary'];global_summaries=[x for x in summaries if not x.get('file')]
 out={'selectedFiles':len(expected),'terminalSuccessfulFiles':len(set(expected)&terminal),'fileSummaryTerminals':fallback,'missing':missing,'badEvents':bad,'summaries':summaries,'commandExit':command_exit}
 valid=not missing and not bad and bool(global_summaries) and command_exit==0
 for summary in global_summaries:
  counts=summary.get('counts',{})
  valid=valid and summary.get('success') is True and counts.get('tests',0)>0 and counts.get('passed')==counts['tests'] and all(counts.get(k)==0 for k in ['cancelled','skipped','todo']) and counts.get('failed',0)==0
 return out,bool(valid)

if __name__=='__main__':
 p=pathlib.Path('evidence/scripts');selected=(p/'selected-files.txt').read_text().splitlines();rows=[json.loads(x) for x in (p/'events.jsonl').read_text().splitlines()]
 out,valid=coverage(selected,rows,int((p/'command.exit').read_text()),pathlib.Path.cwd());(p/'coverage.json').write_text(json.dumps(out,indent=2)+'\n')
 assert valid,'Script terminal coverage failed'

HELPER_4
cat > evidence/tools/validate-testbed.py <<'HELPER_5'
import json,pathlib
p=pathlib.Path('evidence/testbed');c=json.loads((p/'collection.json').read_text());r=json.loads((p/'report.json').read_text());pairs=c['pairs'];run=r['run'];results=run['results'];expected={x['id']:x for x in pairs};actual={x['id']:x for x in results};assert len(expected)==len(pairs) and len(actual)==len(results)
allowed_file='tests/smoke.e2e.ts';allowed_title=['skips itself when the playground has no marketplace'];allowed_skip={'cause':'explicit','reason':'the playground has no marketplace'}
skips=[]
for x in results:
 if x['status']!='skipped':continue
 # Exact existing skip API contract; never a prefix, environment inability, or hidden replacement pass.
 assert x['file']==allowed_file and x['titlePath']==allowed_title and x['selected'] is True and x['repeat']==0 and not x.get('serialGroupId')
 assert x['skip']==allowed_skip and len(x['attempts'])==1
 a=x['attempts'][0];assert a['status']=='skipped' and a['skip']==allowed_skip and a['cleanup']=='complete' and not a.get('error') and not a['secondaryErrors']
 assert a['steps'] and all(s['status']=='passed' and not s.get('error') for s in a['steps'])
 assert any(s['api']=='app.open' for s in a['steps'])
 # count() is an unrecorded read in locator/screen.ts; source-bound control flow reaches explicit skip only after awaited Marketplace count===0.
 skips.append({'id':x['id'],'kind':'expected-runtime-skip','reason':allowed_skip['reason'],'attemptExecuted':True,'appOpenRecorded':True,'countEvidence':'unchanged source control-flow plus exact runtime branch; not a fabricated count step'})
out={'collectionCount':len(pairs),'historicalExpectedCount':80,'historicalCountDifference':len(pairs)-80,'resultCount':len(results),'missing':sorted(set(expected)-set(actual)),'extra':sorted(set(actual)-set(expected)),'summary':run['summary'],'outerExit':int((p/'command.exit').read_text()),'runExit':run['exitCode'],'runStatus':run['status'],'expectedRuntimeSkips':skips,'passedCases':sum(x['status']=='passed' for x in results),'serialGroups':run.get('serialGroups',[])}
(p/'coverage.json').write_text(json.dumps(out,indent=2)+'\n');assert set(expected)==set(actual)
for k,x in expected.items():
 y=actual[k];assert y['repeat']==0 and x['target']==y['targetId'] and x.get('agent')==y.get('agent') and x['file']==y['file'] and x['titlePath']==y['titlePath']
assert out['outerExit']==run['exitCode']==0 and not run['errors']
assert all(x['disposition']=='run' for x in pairs) and len(skips)==1
assert all(x['status']=='passed' or any(s['id']==x['id'] for s in skips) for x in results)
assert run['summary']['selected']==run['summary']['executed']==len(pairs)
assert run['summary']['passed']==len(pairs)-1 and run['summary']['skipped']==1

HELPER_5
cat > evidence/tools/web-partition.ts <<'HELPER_6'
// CI capability partition, not a replacement test config or performance shard.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {REQUIRED_CAPABILITIES} from '../../packages/web/src/native/capabilities.ts';
import {CANDIDATE_FAULT_FILE} from '../../scripts/acceptance/candidate-manifest.ts';
import {verifyCandidateRuntime,verifyInstallerFixtureRuntime,candidateInstallerEnvironment,verifyInstallerFixturePostRun,verifySemanticFaults} from '../../scripts/acceptance/candidate-web.ts';
const out=resolve('evidence/web');mkdirSync(out,{recursive:true});
const ordinary=process.env.E2E_AGENT_BROWSER_EXECUTABLE!,fault=process.env.FULL_NODE_FAULT_EXECUTABLE!;
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(name:string,argv:string[],env=process.env){const r=spawnSync(argv[0]!,argv.slice(1),{stdio:'inherit',env});writeFileSync(resolve(out,name+'.exit'),String(r.status??128)+'\n');return r.status===0;}
writeFileSync(resolve(out,'ordinary-caps.json'),JSON.stringify(REQUIRED_CAPABILITIES));writeFileSync(resolve(out,'fault-caps.json'),JSON.stringify([...REQUIRED_CAPABILITIES,'acceptance.faults/1']));
const ordinaryProof=resolve(out,'ordinary-proof.json'),faultProof=resolve(out,'fault-proof.json');
const o=run('ordinary-probe',['node','scripts/acceptance/probe-native.ts',ordinary,resolve(out,'ordinary-caps.json'),ordinaryProof]);
const f=run('fault-probe',['node','scripts/acceptance/probe-native.ts',fault,resolve(out,'fault-caps.json'),faultProof]);
assert.ok(o&&f,'both real negotiated capabilities/scope cleanup required');
verifyCandidateRuntime(JSON.parse(readFileSync(ordinaryProof,'utf8')),hash(ordinary),false);verifyCandidateRuntime(JSON.parse(readFileSync(faultProof,'utf8')),hash(fault),true);
const installer=verifyInstallerFixtureRuntime('web-browser',fault,faultProof,ordinary,hash(ordinary))!;
const env=candidateInstallerEnvironment(process.env,installer);
const common=['pnpm','--filter','@e2e-dev/web','exec','vitest'];
let completed=false;
try {
 assert.ok(run('collection',[...common,'list','--no-staticParse',`--json=${out}/collection.json`],env),'full collection failed');
 const all=JSON.parse(readFileSync(out+'/collection.json','utf8')) as {name:string,file:string,projectName?:string}[];assert.ok(all.length);
 const faultFile=resolve('packages/web/tests/integration',CANDIDATE_FAULT_FILE);const faultRows=all.filter(x=>x.file===faultFile);const ordinaryRows=all.filter(x=>x.file!==faultFile);assert.equal(faultRows.length,5);assert.ok(ordinaryRows.length);
 for(const [name,rows] of [['ordinary',ordinaryRows],['fault',faultRows]] as const){mkdirSync(out+'/'+name);writeFileSync(out+'/'+name+'/collection.json',JSON.stringify(rows,null,2));}
 // Both commands run even when ordinary fails; no reporter/receipt failure can erase fault results.
 const ordinaryOK=run('ordinary-command',[...common,'run','--exclude',`tests/integration/${CANDIDATE_FAULT_FILE}`,'--reporter=verbose','--reporter=json',`--outputFile.json=${out}/ordinary/results.json`],env);
 const faultEnv={...env,E2E_AGENT_BROWSER_EXECUTABLE:fault,E2E_INTEROP_EVIDENCE_DIR:resolve(env.E2E_INTEROP_EVIDENCE_DIR!,'..','fault')};
 const faultOK=run('fault-command',[...common,'run',`tests/integration/${CANDIDATE_FAULT_FILE}`,'--reporter=verbose','--reporter=json',`--outputFile.json=${out}/fault/results.json`],faultEnv);
 for(const name of ['ordinary','fault'])writeFileSync(out+'/'+name+'/command.exit',readFileSync(out+'/'+name+'-command.exit'));
 const v1=run('ordinary-coverage',['python3','evidence/tools/validate-vitest.py',out+'/ordinary']);const v2=run('fault-coverage',['python3','evidence/tools/validate-vitest.py',out+'/fault']);
 verifySemanticFaults(JSON.parse(readFileSync(out+'/fault/results.json','utf8')),[faultFile]);
 writeFileSync(out+'/partition.json',JSON.stringify({completeDiscovery:all,ordinary:ordinaryRows,fault:faultRows,ordinaryBinarySha256:hash(ordinary),faultBinarySha256:hash(fault),ordinaryOK,faultOK,coverageOK:v1&&v2},null,2));
 completed=ordinaryOK&&faultOK&&v1&&v2;
} finally {
 const receipt=verifyInstallerFixturePostRun(installer);writeFileSync(out+'/installer-postrun.json',JSON.stringify(receipt,null,2));assert.equal(receipt.postRunIdentityVerified,true);
}
assert.ok(completed,'one or more original Web partitions failed or incomplete');

HELPER_6
cat > evidence/tools/script-reporter.mjs <<'HELPER_7'
// Node built-in test reporter API: observability only; no test selection or scheduling options.
import { appendFileSync } from 'node:fs';
export default async function* report(events) {
  for await (const {type,data} of events) {
    const row={type,file:data?.file,name:data?.name,nesting:data?.nesting,testNumber:data?.testNumber,
      skip:data?.skip,todo:data?.todo,details:data?.details?{type:data.details.type,duration_ms:data.details.duration_ms,error:data.details.error?{message:String(data.details.error.message),code:data.details.error.code}:undefined}:undefined};
    if(type==='test:summary') row.summary=data;
    appendFileSync(process.env.E2E_SCRIPT_EVENT_PATH,JSON.stringify(row)+'\n');
    if(type==='test:fail'||type==='test:pass') yield `${type} ${data.name}\n`;
  }
}

HELPER_7

cat > evidence/tools/collect-core.mjs <<'CORE_COLLECTION'
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function completeRows(testModules) {
  assert.ok(Array.isArray(testModules) && testModules.length, 'missing collected modules');
  const rows = [];
  for (const file of testModules) {
    for (const suite of [file, ...file.children.allSuites()]) {
      assert.equal(suite.errors().length, 0, 'suite collection error');
    }
    for (const test of file.children.allTests()) {
      assert.notEqual(test.result().state, 'failed', 'test collection error');
      assert.equal(typeof test.fullName, 'string');
      assert.ok(test.fullName.length);
      const row = { name: test.fullName, file: test.module.moduleId };
      if (test.project.name) row.projectName = test.project.name;
      if (test.location) row.location = test.location;
      rows.push(row);
    }
  }
  assert.ok(rows.length, 'empty collection');
  return rows;
}

export async function collectRows(createContext) {
  const ctx = await createContext();
  try {
    const { testModules, unhandledErrors } = await ctx.collect([], { staticParse: false });
    assert.equal(unhandledErrors.length, 0, 'unhandled collection error');
    return completeRows(testModules);
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Match vitest list --no-staticParse preparation, without its skipped-row filter.
  // This is collection only: never call start/runTestSpecifications or run test bodies.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const workspace = process.cwd();
  const root = path.resolve(workspace, 'packages/e2e');
  process.chdir(root); // Match pnpm --filter e2e exec working directory as well as root.
  const require = createRequire(path.join(root, 'package.json'));
  const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href);
  const rows = await collectRows(() => createVitest({ root, watch: false, run: true }));
  const out = path.resolve(workspace, 'evidence/e2e/collection.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx' });
}
CORE_COLLECTION
