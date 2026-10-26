"""Restore only exact public package bytes; apt retains repository authentication."""
import hashlib, json, pathlib, re, subprocess, sys, zipfile
archive, destination, evidence = map(pathlib.Path, sys.argv[1:])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == '5fb71d9a4daec5e01eda74a473c7024b0be529b823e42a0c2192174af66579d4'
assert not destination.exists(), 'Refuse to mix an existing cache'
with zipfile.ZipFile(archive) as z:
    meta = json.loads(z.read('cache-metadata.json'))
    assert meta['runId'] == '40303768944' and meta['runAttempt'] == '1'
    assert meta['architecture'] == subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip() == 'amd64'
    os_release = pathlib.Path('/etc/os-release').read_text()
    assert 'ID=ubuntu' in os_release and 'VERSION_ID="24.04"' in os_release
    lines = z.read('SHA256SUMS').decode().splitlines()
    assert len(lines) == meta['packageCount'] == 103
    names = {line.split('  ', 1)[1] for line in lines}
    assert len(names) == len(lines)
    assert set(z.namelist()) == names | {'SHA256SUMS', 'cache-metadata.json'}
    for line in lines:
        digest, name = line.split('  ', 1)
        assert re.fullmatch(r'[A-Za-z0-9.+%_~:-]+\.deb', name)
        assert hashlib.sha256(z.read(name)).hexdigest() == digest
    destination.mkdir()
    for name in names:
        (destination / name).write_bytes(z.read(name))
receipt = {'kind': 'public-package-cache-seed', 'runId': '40303768944', 'runAttempt': '1', 'artifactId': 12642071476, 'archiveSha256': '5fb71d9a4daec5e01eda74a473c7024b0be529b823e42a0c2192174af66579d4', 'packageCount': 103, 'productTestPass': False, 'note': 'Prior-run public package bytes only; no imported test pass. Apt must select/authenticate exact versions against unchanged official repositories.'}
evidence.mkdir(exist_ok=True)
(destination / 'seed-source.json').write_text(json.dumps(receipt, indent=2) + '\n')
(evidence / 'apt-cache-seed.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('Verified prior-run public package cache; no test pass imported')
