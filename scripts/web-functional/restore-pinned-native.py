"""Pinned prior build bytes only; this never imports or manufactures test passes."""
import base64, hashlib, io, json, os, pathlib, tarfile, urllib.request, zipfile, sys
mode, archive, destination, evidence = sys.argv[1:]
archive, destination, evidence = map(pathlib.Path, (archive, destination, evidence))
NATIVE = '70ac7f3fb2a53de79c5fabf43b5009b7e5fefebb'
TREE = 'cfee75313ae66059894d86afd66eb275fef30a9c'
def api(path):
    request = urllib.request.Request('https://api.github.com/' + path, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response: return json.load(response)
if mode == 'linux':
    artifact, run, head = 12642743713, 40307386784, '4d80c03720aa393d46d08ea26dcba3c8ffc84706'
    archive_hash = '733b9bfabe7c485130f26e1d92d1fd605fec6d6423efecd17e1a947b446983f1'
    workflow_hash = '5a0d04bab34a2442310c942a4092fa78d15f90dde8e47bc113677e7dfeae988b'
    hashes = {'production': '2f2aeebfdbf8fd6293d41663b96b58c0f86edc7fdf68c63d6ab7f0a9880bc062', 'acceptance-faults': 'e6364b6a65cb36083f6718f2cabbf57dfcf7c9a8037b2dd2ddf5f929d6d2b498'}
    producer_job = 'build'
elif mode == 'intel':
    artifact, run, head = 12642538790, 40303768944, '06f1faf6c305560b44cd804969c30927b254f886'
    archive_hash = 'e14f82e0d1e7283a1bd22790c735e12fdb45df2351de1c011193f0e6628b3590'
    workflow_hash = '0e460698f1263ff855ca918e6004c3cf98236f8ca94189900af69dcdf1f702cd'
    hashes = {'production': 'e9bed566d4d3f9a51aa7940f71a6bb642649adfd56c3abc9e4966765bb89a38b'}
    producer_job = 'macos-diagnostic (macos-15-intel, x64, x86_64-apple-darwin, x86_64)'
else: raise ValueError('Unknown artifact mode')
assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_hash
meta = api(f'repos/levicode/e2e/actions/artifacts/{artifact}')
assert meta['workflow_run']['id'] == run and meta['workflow_run']['head_sha'] == head
assert meta['digest'] == 'sha256:' + archive_hash and not meta['expired']
jobs = api(f'repos/levicode/e2e/actions/runs/{run}/jobs?per_page=100')['jobs']
assert any(j['name'] == producer_job and j['conclusion'] == 'success' for j in jobs)
workflow = api(f'repos/levicode/e2e/contents/.github/workflows/web-functional-diagnostic.yml?ref={head}')
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
    else:
        assert set(z.namelist()) == {'darwin-x64-diagnostic.tgz', 'darwin-x64-diagnostic.tgz.sha256'}
        bundle = z.read('darwin-x64-diagnostic.tgz')
        assert hashlib.sha256(bundle).hexdigest() == '3e128489666d27f03cfefa236d9fde0deef0c9691a3d621d007cec77455a8ca2'
        with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as t:
            def member(name):
                m = t.getmember('./' + name); assert m.isfile()
                return t.extractfile(m).read()
            manifest = json.loads(member('manifest.json'))
            assert manifest['source']['native'] == {'commit': NATIVE, 'tree': TREE}
            assert manifest['platform'] == 'darwin' and manifest['architecture'] == 'x64'
            data = member('bin/agent-browser'); assert hashlib.sha256(data).hexdigest() == hashes['production']
            (destination / 'production').write_bytes(data)
for name in hashes: (destination / name).chmod(0o755)
evidence.mkdir(parents=True, exist_ok=True)
receipt = {'kind': 'prior-build-byte-provenance', 'artifactId': artifact, 'runId': run, 'producerRecipe': head, 'producerWorkflowSha256': workflow_hash, 'nativeSource': NATIVE, 'nativeTree': TREE, 'archiveSha256': archive_hash, 'binarySha256': hashes, 'importedTestPass': False, 'releaseEligible': False}
(evidence / 'native-artifact-provenance.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('Verified exact prior build provenance and native bytes; new tests still required')
