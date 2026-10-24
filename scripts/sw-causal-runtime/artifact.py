#!/usr/bin/env python3
"""Verify only this run's separately compiled temporary diagnostic artifact."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile
HERE=Path(__file__).resolve().parent
PINS=json.loads((HERE/'pins.json').read_text())
FORMAL_IMAGES={'63e83b69bec322844aebc9572613714b846e57945acf11c8fd9827793fa30da5','7a0723a36b6492d2b2400f97344a7b001c94ba569318fdffd79d777efad46845'}
NAMES={'agent-browser','provenance.json','native-gates.json','native-tests.json'}
def digest(path):return hashlib.file_digest(Path(path).open('rb'),'sha256').hexdigest()
def verify_metadata(meta, jobs, archive_digest):
    expected=os.environ['DIAGNOSTIC_ARTIFACT_DIGEST'].removeprefix('sha256:')
    assert re.fullmatch('[a-f0-9]{64}',expected) and archive_digest==expected
    assert meta['id']==int(os.environ['DIAGNOSTIC_ARTIFACT_ID']) and meta['expired'] is False
    assert meta['digest']=='sha256:'+expected
    assert meta['name']==f"temporary-sw-causal-native-linux-x64-{PINS['nativeSha']}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    assert meta['workflow_run']['id']==int(os.environ['GITHUB_RUN_ID']) and meta['workflow_run']['head_sha']==os.environ['GITHUB_WORKFLOW_SHA']
    selected=[job for job in jobs['jobs'] if job['name']=='temporary-sw-causal-compile']
    assert len(selected)==1 and selected[0]['status']=='completed' and selected[0]['conclusion']=='success'
    assert selected[0]['head_sha']==os.environ['GITHUB_WORKFLOW_SHA']
    assert selected[0]['run_id']==int(os.environ['GITHUB_RUN_ID']) and selected[0]['run_attempt']==int(os.environ['GITHUB_RUN_ATTEMPT'])

def main():
    evidence=Path(os.environ['EVIDENCE_DIR']);workspace=Path(os.environ['GITHUB_WORKSPACE'])
    archive=evidence/'diagnostic-artifact.zip'
    meta=json.loads((evidence/'artifact-metadata.json').read_text());jobs=json.loads((evidence/'compile-jobs.json').read_text())
    verify_metadata(meta,jobs,digest(archive))
    assert archive.stat().st_size==meta['size_in_bytes']
    destination=workspace/'diagnostic-artifact';destination.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as bundle:
        assert len(bundle.infolist())==len(NAMES) and set(bundle.namelist())==NAMES
        for entry in bundle.infolist():
            assert not entry.is_dir() and (entry.external_attr>>16)&0o170000 != 0o120000
            assert entry.file_size<=64*1024*1024
            (destination/entry.filename).write_bytes(bundle.read(entry))
    spec=importlib.util.spec_from_file_location('compile_helper',HERE.parent/'sw-causal-diagnostic/compile-helper.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
    for key,pin in [('NATIVE_SHA','nativeSha'),('NATIVE_TREE','nativeTree'),('NATIVE_LOCK_SHA256','nativeLockSha256'),('E2E_SHA','e2eSha'),('E2E_TREE','e2eTree'),('E2E_LOCK_SHA256','e2eLockSha256')]:assert os.environ[key]==PINS[pin]
    C.verify_diagnostic(destination)
    value=json.loads((destination/'provenance.json').read_text())
    assert value['helper_sha256']==digest(HERE.parent/'sw-causal-diagnostic/compile-helper.py')
    assert value['native_validation']=={'mode':'fresh-diagnostic-native-validation','current_native_execution':True,'required_witnesses':66,'default_harnesses':6}
    gates=json.loads((destination/'native-gates.json').read_text());tests=json.loads((destination/'native-tests.json').read_text())
    assert gates['accepted'] is True and gates['phases']==dict.fromkeys(C.NATIVE_PHASES,'0')
    assert tests['accepted'] is True and tests['required_tests']==C.REQUIRED_TESTS and not tests['required_missing_or_not_passed']
    assert len(tests['targets'])==6 and all(t['accepted'] is True and t['sha256_before']==t['sha256_after'] for t in tests['targets'])
    assert value['binary_sha256']==os.environ['DIAGNOSTIC_BINARY_SHA256'] and value['binary_bytes']==int(os.environ['DIAGNOSTIC_BINARY_BYTES'])
    assert value['binary_sha256'] not in FORMAL_IMAGES
    header=(destination/'agent-browser').read_bytes()[:20]
    assert header[:6]==bytes.fromhex('7f454c460201') and int.from_bytes(header[18:20],'little')==62
    image=workspace/'agent-browser';shutil.copyfile(destination/'agent-browser',image);image.chmod(0o755)
    receipt={'nativeSha':PINS['nativeSha'],'nativeTree':PINS['nativeTree'],'binarySha256':digest(image),'binaryBytes':image.stat().st_size,'profile':'ci','features':[],'diagnosticOnly':True,'sameRunArtifactVerified':True,'artifactId':meta['id'],'artifactDigest':meta['digest'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'recipeSha':os.environ['GITHUB_WORKFLOW_SHA'],'formalCandidate':False,'releaseEligible':False}
    (evidence/'production-identity.json').write_text(json.dumps(receipt,indent=2)+'\n')
    for name in NAMES-{'agent-browser'}:shutil.copyfile(destination/name,evidence/('artifact-'+name))
    # Binary and ZIP are deliberately excluded from the runtime evidence upload.
    print(json.dumps(receipt,indent=2))
if __name__=='__main__':main()
