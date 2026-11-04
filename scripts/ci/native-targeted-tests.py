"""Exact native-only regression collection. No browser, production binary or retry."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def identity(root):
    require(git(root, 'status', '--porcelain') == '', 'Dirty checkout')
    return {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}')}


def plan(value):
    require(value['native'] is not None, 'Unbound native')
    require(set(value['native']) == {'commit', 'tree', 'lockSHA256'}, 'Native identity fields')
    for key, size in [('commit', 40), ('tree', 40), ('lockSHA256', 64)]:
        require(re.fullmatch('[a-f0-9]{'+str(size)+'}', value['native'][key]) is not None, 'Native identity')
    names = value['required']
    require(isinstance(names, list) and len(names) > 0 and len(names) == len(set(names)), 'Required names')
    require(all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_:]*', n) for n in names), 'Closed test name')
    require(value['features'] in [[], ['acceptance-faults']], 'Explicit default or fault harness only')
    return value


def resolve_list(text, names):
    rows = [line[:-6] for line in text.splitlines() if line.endswith(': test')]
    require(all(rows.count(n) == 1 for n in names), 'Missing or duplicate exact test')
    return names


AFFECTED_PREFIXES = [
    'native::client_debt::', 'native::cdp::client::',
    'native::client_actions::', 'native::client_geometry::',
    'native::client_observation::',
    'native::client_page::navigation_retirement::tests::',
]


def expanded_selection(text, ignored_text, cfg):
    """Actual libtest inventory is authority; source mismatches fail closed."""
    def rows(value):
        found = [line[:-6] for line in value.splitlines() if line.endswith(': test')]
        require(len(found) == len(set(found)), 'Duplicate listed test')
        require(all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_:]*', n) for n in found), 'Invalid listed name')
        return found
    all_names = rows(text); ignored = rows(ignored_text)
    require(set(ignored) <= set(all_names), 'Ignored names not in full list')
    resolve_list(text, cfg['required'])
    require(not set(cfg['required']) & set(ignored), 'Mandatory control ignored')
    expansion = cfg['expansion']
    require(expansion['prefixes'] == AFFECTED_PREFIXES, 'Affected prefix contract')
    inventory = expansion['inventory']
    require(len({row['name'] for row in inventory}) == len(inventory), 'Duplicate source inventory')
    missing = [row['name'] for row in inventory if row['name'] not in all_names]
    require(not missing, 'Source inventory missing from actual list: '+','.join(missing))
    require(all((row['name'] in ignored) == row['ignored'] for row in inventory), 'Source ignore classification differs')
    affected = sorted(n for n in all_names if any(n.startswith(prefix) for prefix in AFFECTED_PREFIXES))
    selected = cfg['required'] + [n for n in affected if n not in ignored and n not in cfg['required']]
    return {'selected':selected, 'ignored':[n for n in affected if n in ignored],
            'actualAffected':affected, 'knownDiagnosticGaps':[n for n in expansion['knownDiagnosticGaps'] if n in selected],
            'inventoryCount':len(inventory), 'listSHA256':hashlib.sha256(text.encode()).hexdigest(),
            'ignoredListSHA256':hashlib.sha256(ignored_text.encode()).hexdigest()}


def verify_inventory_sources(root, cfg):
    expansion = cfg['expansion']
    require(expansion['prefixes'] == AFFECTED_PREFIXES, 'Affected prefix contract')
    for row in expansion['inventory']:
        source = Path(row['path'])
        require(not source.is_absolute() and '..' not in source.parts and source.parts[:3] == ('cli','src','native'), 'Inventory source path')
        require(isinstance(row['ignored'], bool), 'Inventory ignore type')
        require(digest(root/source) == row['sha256'], 'Inventory source changed')


def exact_pass(text, name):
    lines = text.splitlines()
    return (lines.count('test '+name+' ... ok') == 1 and
            sum(line.startswith('test result: ') for line in lines) == 1 and
            any(re.fullmatch(r'test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in [0-9.]+s', line) for line in lines))


def select_harness(text, root, target, features=None):
    if features is None: features=[]
    rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    require(sum(r.get('reason') == 'build-finished' and r.get('success') is True for r in rows) == 1, 'Build terminal')
    choices = [r for r in rows if r.get('reason') == 'compiler-artifact' and r.get('executable') and r.get('target', {}).get('name') == 'agent-browser' and r.get('profile', {}).get('test') is True]
    require(len(choices) == 1, 'Unique test harness')
    row = choices[0]
    require(row.get('features') == features and row.get('fresh') is False, 'Fresh default harness')
    require(Path(row['manifest_path']).resolve() == root/'cli/Cargo.toml', 'Compiler source')
    exe = Path(row['executable'])
    require(exe.is_file() and not exe.is_symlink() and exe.resolve() == exe and exe.is_relative_to(target), 'Harness target')
    return exe


def run(root, work, cfg):
    # The caller creates the private root; this runner never reuses a target/evidence directory.
    root = Path(root).resolve(strict=True)
    work = Path(work)
    require(work.is_absolute() and work.parent.resolve() == work.parent and not work.exists(), 'Fresh canonical work')
    require(not work.is_relative_to(root) and not root.is_relative_to(work), 'Separate work')
    work.mkdir(mode=0o700)
    evidence = work/'evidence'; evidence.mkdir(mode=0o700)
    target = work/'target'; target.mkdir(mode=0o700)
    names = cfg.get('required', [])
    result = {'purpose':'targeted-native-regression', 'fullAcceptance':False, 'status':'incomplete', 'native':cfg.get('native'), 'tooling':None, 'commands':[], 'tests':[{'name':n,'status':'not-run'} for n in names]}
    def save():
        tmp = evidence/'result.tmp'
        tmp.write_text(json.dumps(result, indent=2)+'\n'); tmp.replace(evidence/'result.json')
    save()
    env = {k:v for k,v in os.environ.items() if k not in {'RUST_MIN_STACK', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER'} and not k.startswith(('CARGO_', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUST_TEST_', 'AGENT_BROWSER_', 'E2E_'))}
    env.update(CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS='1', RUST_TEST_NOCAPTURE='0')
    def command(label, args):
        row = {'label':label, 'argv':list(map(str,args)), 'exit':None}
        result['commands'].append(row); save()
        with (evidence/(label+'.stdout.log')).open('xb') as stdout, (evidence/(label+'.stderr.log')).open('xb') as stderr:
            done = subprocess.run(args, cwd=root/'cli', env=env, stdout=stdout, stderr=stderr, check=False)
        row['exit'] = done.returncode
        row['stdoutSHA256'] = digest(evidence/(label+'.stdout.log')); row['stderrSHA256'] = digest(evidence/(label+'.stderr.log')); save()
        require(done.returncode >= 0, 'Process signal')
        return done.returncode, (evidence/(label+'.stdout.log')).read_text()
    primary = None
    try:
        plan(cfg)
        tooling = Path(__file__).resolve().parents[2]
        result['tooling'] = identity(tooling)
        require(result['tooling']['commit'] == os.environ.get('GITHUB_SHA'), 'Actual tooling SHA')
        require(identity(root) == {k:cfg['native'][k] for k in ['commit','tree']}, 'Native identity mismatch')
        require(digest(root/'cli/Cargo.lock') == cfg['native']['lockSHA256'], 'Native lock mismatch')
        if 'expansion' in cfg: verify_inventory_sources(root, cfg)
        for label,args in [('rustc',['rustc','-Vv']),('cargo',['cargo','--version'])]:
            require(command(label,args)[0] == 0, 'Toolchain unavailable')
        code,text = command('compiler',['cargo','test','--locked','--profile','ci','--no-default-features','--no-run','--message-format=json'] + (['--features','acceptance-faults'] if cfg['features'] else []))
        require(code == 0, 'Compiler failure')
        exe = select_harness(text,root,target,cfg['features']); original = digest(exe); result['harnessSHA256'] = original
        code,text = command('list',[exe,'--list','--format','terse']); require(code == 0, 'List failure'); resolve_list(text,names)
        if 'expansion' in cfg:
            code,ignored_text = command('list-ignored',[exe,'--ignored','--list','--format','terse']); require(code == 0, 'Ignored list failure')
            selection = expanded_selection(text, ignored_text, cfg)
            result['selection'] = selection
            names = selection['selected']
            result['tests'] = [{'name':n,'status':'not-run','knownDiagnosticGap':n in selection['knownDiagnosticGaps']} for n in names]
            result['ignoredTests'] = [{'name':n,'status':'not-run','reason':'original ignored declaration; requires separate hosted/diagnostic execution'} for n in selection['ignored']]
            save()
        for index,name in enumerate(names):
            result['tests'][index]['status'] = 'incomplete'; save()
            code,text = command('test-'+str(index+1).zfill(3),[exe,name,'--exact','--test-threads=1','--show-output'])
            result['tests'][index]['status'] = 'passed' if code == 0 and exact_pass(text,name) else 'failed'
            save()
        require(digest(exe) == original, 'Harness changed')
        require(identity(root) == {k:cfg['native'][k] for k in ['commit','tree']}, 'Post native identity')
        require(digest(root/'cli/Cargo.lock') == cfg['native']['lockSHA256'], 'Post lock')
        require(identity(tooling) == result['tooling'], 'Post tooling identity')
        result['status'] = 'passed' if all(r['status'] == 'passed' for r in result['tests']) else 'failed'
    except Exception as exc:
        primary = exc
        result['status'] = 'incomplete'
        result['errorClass'] = type(exc).__name__
    try:
        save()
    except Exception:
        if primary is None:
            raise
    if primary is not None:
        raise primary
    require(result['status'] == 'passed', 'Targeted tests failed')
    return result


if __name__ == '__main__':
    require(len(sys.argv) in [3,4], 'Expected native checkout, fresh work, optional reviewed plan')
    selected=Path(__file__).with_name('native-targeted-plan.json' if len(sys.argv)==3 else sys.argv[3])
    require(selected.name in ['native-targeted-plan.json','popup-joint-fault-controls.json'], 'Unknown plan')
    run(sys.argv[1],sys.argv[2],json.loads(selected.read_text()))
