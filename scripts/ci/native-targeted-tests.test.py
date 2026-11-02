"""Safe parser/identity controls only; no cargo, browser, install or network."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('targeted',Path(__file__).with_name('native-targeted-tests.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def test_plan(self):
        value={'native':{'commit':'a'*40,'tree':'b'*40,'lockSHA256':'c'*64},'features':[],'required':['a::b']}
        self.assertEqual(m.plan(value),value)
        for changed in [dict(value,native=None),dict(value,features=['unknown']),dict(value,required=['a::b','a::b']),dict(value,required=['a\nb'])]:
            with self.assertRaises(ValueError): m.plan(changed)
    def test_exact_list(self):
        self.assertEqual(m.resolve_list('a::b: test\n',['a::b']),['a::b'])
        for s in ['', 'a::c: test\n','a::b: test\na::b: test\n']:
            with self.assertRaises(ValueError):m.resolve_list(s,['a::b'])
    def test_strict_pass(self):
        text='test a::b ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.01s\n'
        self.assertTrue(m.exact_pass(text,'a::b'))
        for s in [text.replace('... ok','... READ_RECEIPT_CONTROL {}\nok'),text.replace('1 passed','0 passed'),text.replace('0 ignored','1 ignored'),text.replace('a::b','a::c'),text+text,text.split('\n\n')[1]]:
            self.assertFalse(m.exact_pass(s,'a::b'))
    def test_harness(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);target=root/'target';target.mkdir();exe=target/'bin';exe.write_text('not executable')
            row={'reason':'compiler-artifact','executable':str(exe),'target':{'name':'agent-browser'},'profile':{'test':True},'features':[],'fresh':False,'manifest_path':str(root/'cli/Cargo.toml')}
            end={'reason':'build-finished','success':True}
            render=lambda rows:'\n'.join(json.dumps(r) for r in rows)
            self.assertEqual(m.select_harness(render([row,end]),root,target),exe)
            self.assertEqual(m.select_harness(render([dict(row,features=['acceptance-faults']),end]),root,target,['acceptance-faults']),exe)
            for rows in [[row,row,end],[row], [dict(row,features=['acceptance-faults']),end],[dict(row,fresh=True),end],[dict(row,manifest_path=str(root/'other/Cargo.toml')),end],[row,dict(end,success=False)]]:
                with self.assertRaises(ValueError):m.select_harness(render(rows),root,target)
    def test_all_outcomes_and_early_failures(self):
        for mode in ['ordinary-fail','signal','compiler-fail','identity-fail']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d:
                root=Path(d);native=root/'native';(native/'cli').mkdir(parents=True);(native/'cli/Cargo.lock').write_text('locked')
                ident={'commit':'a'*40,'tree':'b'*40};cfg={'native':dict(ident,lockSHA256=m.digest(native/'cli/Cargo.lock')),'required':['a::one','a::two'],'features':[]}
                work=root/'work';calls=[]
                def execute(args,**kw):
                    args=list(map(str,args));calls.append(args);code=0;text=''
                    for key in ['RUST_MIN_STACK','RUSTC','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER']:self.assertNotIn(key,kw['env'])
                    self.assertEqual(kw['env']['RUSTUP_TOOLCHAIN'],'stable')
                    if '--no-run' in args:
                        code=1 if mode=='compiler-fail' else 0
                    elif '--list' in args:text='a::one: test\na::two: test\n'
                    elif '--exact' in args:
                        name=args[1];code=(-9 if mode=='signal' else 101) if name=='a::one' else 0
                        text=f'test {name} ... '+('ok' if code==0 else 'FAILED')+'\n'+f'test result: '+('ok. 1 passed; 0 failed' if code==0 else 'FAILED. 0 passed; 1 failed')+'; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s\n'
                    kw['stdout'].write(text.encode());return SimpleNamespace(returncode=code)
                def harness(*args):
                    exe=work/'target/bin';exe.write_text('synthetic, never executed');return exe
                def checked_identity(where):
                    if mode=='identity-fail' and where==native:return dict(ident,tree='c'*40)
                    return ident
                with patch.object(m,'identity',checked_identity),patch.object(m,'select_harness',harness),patch.object(m.subprocess,'run',execute),patch.dict(m.os.environ,{'GITHUB_SHA':ident['commit'],'RUSTUP_TOOLCHAIN':'stable','RUST_MIN_STACK':'33554432','RUSTC':'untrusted-rustc','RUSTC_WRAPPER':'untrusted-wrapper','RUSTC_WORKSPACE_WRAPPER':'untrusted-workspace-wrapper'}):
                    with self.assertRaises(ValueError):m.run(native,work,cfg)
                result=json.loads((work/'evidence/result.json').read_text());statuses=[x['status'] for x in result['tests']]
                if mode=='ordinary-fail':
                    self.assertEqual(statuses,['failed','passed']);self.assertEqual(result['status'],'failed');self.assertEqual(sum('--exact' in a for a in calls),2)
                elif mode=='signal':self.assertEqual(statuses,['incomplete','not-run']);self.assertEqual(result['commands'][-1]['exit'],-9)
                else:self.assertEqual(statuses,['not-run','not-run']);self.assertFalse(any('--exact' in a for a in calls))
                if mode!='ordinary-fail':self.assertEqual(result['status'],'incomplete')
    def test_unbound_preserves_not_run(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);native=root/'native';native.mkdir();work=root/'work'
            with self.assertRaises(ValueError):m.run(native,work,{'native':None,'required':['a::b'],'features':[]})
            result=json.loads((work/'evidence/result.json').read_text())
            self.assertEqual(result['status'],'incomplete');self.assertEqual(result['tests'],[{'name':'a::b','status':'not-run'}]);self.assertEqual(result['commands'],[])

if __name__=='__main__':unittest.main()
