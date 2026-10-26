"""Pinned prior build bytes only; this never imports or manufactures test passes."""
import base64, hashlib, io, json, os, pathlib, tarfile, urllib.request, zipfile, sys
mode, archive, destination, evidence = sys.argv[1:]
archive, destination, evidence = map(pathlib.Path, (archive, destination, evidence))
NATIVE = 'f4fa3c62d29208b7679fedbf0e3787f2923506a7'
TREE = '5c6d85dfe52b5c1a7cf3dcc0a795116f7fd78c5d'
def api(path):
    request = urllib.request.Request('https://api.github.com/' + path, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response: return json.load(response)
if mode == 'linux':
    artifact, run, head = 12648838514, 40319712630, 'e1777b3a993bf8901f335ae9821669a630036e3c'
    archive_hash = '9693a2d2318dd99079e646484a219db59d6c37bda20e1caa38884996823abab2'
    workflow_hash = '2348d46ebf5907f84e161a82d62cc99277bdf872b7d1cfdb7b52e83a489888ed'
    hashes = {'production': '33cf8e4bb1d623d2e9652ea5beec24297fa24448b5789c6326e939ea8eeb8cf9', 'acceptance-faults': 'a790daadbad89e59ae020bd45c2af0fef539a439cf57daba956266b661fd80bc'}
    producer_job = 'build'
else: raise ValueError('Unknown artifact mode')
assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_hash
meta = api(f'repos/levicode/e2e/actions/artifacts/{artifact}')
assert meta['workflow_run']['id'] == run and meta['workflow_run']['head_sha'] == head
assert meta['digest'] == 'sha256:' + archive_hash and not meta['expired']
jobs = api(f'repos/levicode/e2e/actions/runs/{run}/jobs?per_page=100')['jobs']
assert any(j['name'] == producer_job and j['conclusion'] == 'success' for j in jobs)
workflow = api(f'repos/levicode/e2e/contents/.github/workflows/trace-video-isolated.yml?ref={head}')
workflow_bytes = base64.b64decode(workflow['content'])
assert hashlib.sha256(workflow_bytes).hexdigest() == workflow_hash
assert NATIVE.encode() in workflow_bytes and TREE.encode() in workflow_bytes
commit = api(f'repos/levicode/agent-browser/git/commits/{NATIVE}')
assert commit['sha'] == NATIVE and commit['tree']['sha'] == TREE
assert not destination.exists(), 'Refuse to mix preexisting native images'
destination.mkdir(parents=True)
with zipfile.ZipFile(archive) as z:
    if mode == 'linux':
        assert set(z.namelist()) == {'SHA256SUMS', *hashes}
        for name, digest in hashes.items():
            data = z.read(name); assert hashlib.sha256(data).hexdigest() == digest
            (destination / name).write_bytes(data)
        expected = ''.join(digest + '  ' + name + '\n' for name, digest in hashes.items())
        assert z.read('SHA256SUMS').decode() == expected
        (destination / 'SHA256SUMS').write_text(expected)
for name in hashes: (destination / name).chmod(0o755)
evidence.mkdir(parents=True, exist_ok=True)
receipt = {'kind': 'prior-build-byte-provenance', 'artifactId': artifact, 'runId': run, 'producerRecipe': head, 'producerWorkflowSha256': workflow_hash, 'nativeSource': NATIVE, 'nativeTree': TREE, 'archiveSha256': archive_hash, 'binarySha256': hashes, 'importedTestPass': False, 'releaseEligible': False}
(evidence / 'native-artifact-provenance.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('Verified exact prior build provenance and native bytes; new tests still required')
