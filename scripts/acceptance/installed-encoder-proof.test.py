"""Pure synthetic controls. Never scans processes or runs browser/native/ffmpeg."""
import copy
import importlib.util
import json
import os
import time
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('proof', HERE / 'installed-encoder-proof.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
OUT = '/tmp/agent-browser-action-12345678-abcd-1234-abcd-123456789abc/video.webm'
ARGV = ['/usr/bin/ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '25', '-i', 'pipe:0', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-fps_mode', 'vfr', '-c:v', 'libvpx', '-crf', '18', '-b:v', '8000k', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-threads', '1', OUT]


def process(pid, parent, exe='/native'):
    return dict(pid=pid, ppid=parent, uid=1000, start=str(pid), group=pid, session=pid, exe=exe)


class Grammar(unittest.TestCase):
    def test_original_encoding(self): self.assertEqual(p.encoding(ARGV), OUT)
    def test_version_is_excluded(self): self.assertIsNone(p.encoding(['/usr/bin/ffmpeg', '-version']))
    def test_high_fps_and_size(self):
        a = ARGV.copy(); a[16] = '60'; a[20] = 'scale=640:480:force_original_aspect_ratio=decrease,pad=ceil(640/2)*2:ceil(480/2)*2:0:0'; a[-2]='4'
        self.assertEqual(p.encoding(a), OUT)
    def test_output_limit(self): self.assertEqual(p.encoding(ARGV[:33]+['-fs','1000000']+ARGV[33:]), OUT)
    def test_bad_arguments(self):
        for index, value in [(12,'lavfi'),(14,'rawvideo'),(16,'0'),(18,'file:secret'),(20,'movie=/secret'),(24,'libx264'),(28,'1000k'),(30,'best'),(-2,'128'),(-1, '/tmp/not-owned/video.webm')]:
            with self.subTest(index=index):
                a=ARGV.copy();a[index]=value
                with self.assertRaises(ValueError):p.encoding(a)
    def test_extra_input(self):
        with self.assertRaises(ValueError):p.encoding(ARGV[:-1]+['-i','secret',ARGV[-1]])
    def test_cmdline(self): self.assertEqual(p.parse_argv(b'ffmpeg\0-version\0'), ['ffmpeg','-version'])
    def test_bad_cmdline(self):
        for data in [b'',b'ffmpeg',b'ffmpeg\0\0',b'x\0'*65,b'x'*4097+b'\0',b'\xff\0']:
            with self.subTest(data=data[:10]):
                with self.assertRaises((ValueError,UnicodeDecodeError)):p.parse_argv(data)


class Ownership(unittest.TestCase):
    def test_detached_chain(self):p.validate_chain(process(1,0,'/node'),process(2,1),process(3,2),'/native')
    def test_wrong_native_owner(self):
        for layer in (1,2):
            for key,value in [('ppid',99),('uid',99),('exe','/spoof')]:
                with self.subTest(layer=layer,key=key):
                    chain=[process(1,0,'/node'),process(2,1),process(3,2)];chain[layer][key]=value
                    with self.assertRaises(ValueError):p.validate_chain(*chain,'/native')
    def test_ambiguity(self):
        for children in [[],[process(2,1),process(3,1)]]:
            with self.assertRaises(ValueError):p.select_native(children,'/native')
    def test_pid_reuse_and_identity(self):
        for key in p.IDENTITY:
            a=process(2,1);b=copy.deepcopy(a);b[key]='different'
            with self.assertRaises(ValueError):p.same(a,b)
    def test_multithread_discovery(self):
        # Real function with synthetic filesystem and snapshots; no /proc access.
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);(base/'2/task/2').mkdir(parents=True);(base/'2/task/3').mkdir();(base/'2/task/2/children').write_text('4');(base/'2/task/3/children').write_text('5 4')
            original=Path
            with patch.object(p,'Path',side_effect=lambda x:base if str(x)=='/proc' else original(x)),patch.object(p,'linux_snapshot',side_effect=lambda pid:process(pid,1 if pid==2 else 2)):
                self.assertEqual([c['pid'] for c in p.linux_children(process(2,1))],[4,5])
    def test_unowned_child_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);(base/'2/task/2').mkdir(parents=True);(base/'2/task/2/children').write_text('4');original=Path
            with patch.object(p,'Path',side_effect=lambda x:base if str(x)=='/proc' else original(x)),patch.object(p,'linux_snapshot',side_effect=lambda pid:process(pid,1)):
                with self.assertRaises(ValueError):p.linux_children(process(2,1))


class CParser(unittest.TestCase):
    def test_actual_extracted_pure_c_parser_and_zeroization(self):
        source=(HERE/'installed-encoder-proc.c').read_text()
        def function(name):
            start=source.index('static ', source.index(name)-40) if False else source.rfind('static ',0,source.index(name))
            brace=source.index('{',start);depth=1;i=brace+1
            while depth:
                if source[i]=='{':depth+=1
                elif source[i]=='}':depth-=1
                i+=1
            return source[start:i]
        names=['wipe(', 'release(', 'next_string(', 'parse_arguments(', 'number(', 'safe_output(', 'allowed(']
        functions='\n'.join(function(n) for n in names)
        prefix='''#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n#include <assert.h>\n#include <ctype.h>\n#include <regex.h>\n#define MAX_ARGS 64\nstruct arguments { int argc; char *argv[MAX_ARGS]; char *raw; size_t capacity; };\nstatic int freed=0;\nstatic void zero_free(void *ptr){ unsigned char *p=ptr; for(int i=0;i<128;i++) assert(p[i]==0); freed++; free(ptr); }\n#define free zero_free\n'''
        main=r'''
int main(void) {
 struct arguments a={0}; a.capacity=128; a.raw=calloc(1,128);
 int count=2;memcpy(a.raw,&count,4);size_t at=4;
 const char bytes[]="/usr/bin/ffmpeg\0\0ffmpeg\0-version\0DO_NOT_EMIT_ENV=private\0";
 memcpy(a.raw+at,bytes,sizeof(bytes));
 assert(parse_arguments(&a,at+sizeof(bytes)));assert(a.argc==2);assert(!strcmp(a.argv[1],"-version"));assert(allowed(&a));
 assert(strstr(a.argv[1],"private")==NULL);
 release(&a);assert(freed==1);assert(a.raw==NULL);
 for(int bad=-1;bad<=65;bad+=66){a.capacity=128;a.raw=calloc(1,128);memcpy(a.raw,&bad,4);assert(!parse_arguments(&a,128));release(&a);}
 a.capacity=128;a.raw=calloc(1,128);count=2;memcpy(a.raw,&count,4);memset(a.raw+4,'x',124);assert(!parse_arguments(&a,128));release(&a);
 assert(!safe_output("/tmp/not-owned/video.webm"));
 assert(safe_output("/tmp/agent-browser-action-12345678-abcd-1234-abcd-123456789abc/video.webm"));
 puts("actual extracted C parser synthetic controls passed; no Mac APIs invoked"); return 0;
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);encoding_control = 'struct arguments valid={0}; valid.argc=38; char *values[]={' + ','.join(json.dumps(v) for v in ARGV) + '}; for(int i=0;i<38;i++)valid.argv[i]=values[i]; assert(allowed(&valid)); valid.argv[18]=\"file:secret\"; assert(!allowed(&valid));'
            main=main.replace(' puts(\"actual extracted', encoding_control+'\n puts(\"actual extracted')
            (path/'test.c').write_text(prefix+functions+main)
            build=subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',str(path/'test.c'),'-o',str(path/'test')],capture_output=True,text=True)
            self.assertEqual(build.returncode,0,build.stderr)
            run=subprocess.run([str(path/'test')],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr);self.assertNotIn('private',run.stdout)


class Window(unittest.TestCase):
    def exercise(self, mutate=None):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);window=root/'window';window.mkdir();native=root/'native';native.write_bytes(b'native');encoder=root/'ffmpeg';encoder.write_bytes(b'encoder')
            output=root/'agent-browser-action-12345678-abcd-1234-abcd-123456789abc'/'video.webm';output.parent.mkdir()
            media=root/'public.webm';media.write_bytes(b'webm')
            binding=dict(nonce='nonce',nativeExecutable=str(native),nativeSha256=p.digest(native),observerSources={n:p.digest(HERE/n) for n in ['installed-encoder-proof.py','installed-encoder-proc.c']},platform=p.sys.platform,arch={'x86_64':'x64','arm64':'arm64','aarch64':'arm64'}[os.uname().machine],helperSha256=None)
            arm=dict(nonce='nonce',fixturePid=os.getppid(),runId='run',attemptId='attempt',segmentPath='video/video.webm',armed=int(time.time()*1000),deadlineUnixMs=int(time.time()*1000)+15000)
            finished=dict(nonce='nonce',runId='run',attemptId='attempt',segmentPath='video/video.webm',startedAt='2026-10-31T00:00:00Z',publicPath=str(media),webmSha256=p.digest(media),nativeStopReturnedSuccessfully=True,decodedMediaPassed=True,finished=int(time.time()*1000))
            config=dict(versionOnly=False,secondEncoder=False,tracked='gone')
            if mutate:mutate(binding,arm,finished,config)
            p.atomic_json(root/'binding.json',binding);p.atomic_json(window/'arm.json',arm)
            fixture=process(os.getppid(),0,'/node');proxy=process(7001,fixture['pid'],str(native));daemon=process(7002,7001,str(native));child=process(7003,7002,str(encoder))
            for entry in [fixture,proxy,daemon,child]:entry['uid']=os.getuid()
            argv=ARGV.copy();argv[0]=str(encoder);argv[-1]=str(output);child['argv']=argv
            class FakeObserver:
                def __init__(self,*args):self.calls=0;self.native=str(native);self.encoder=str(encoder);self.encoder_hash=p.digest(encoder)
                def frame(self,tracked=None):
                    self.calls+=1;entries=[]
                    if self.calls==2:
                        entry=copy.deepcopy(child)
                        if config['versionOnly']:entry['argv']=[str(encoder),'-version']
                        entries=[entry]
                        if config['secondEncoder']:
                            other=copy.deepcopy(entry);other['pid']+=1;other['start']='other';entries.append(other)
                        finished['finished']=int(time.time()*1000);p.atomic_json(window/'finished.json',finished)
                    return dict(fixture=fixture,proxy=proxy,daemon=daemon,encoders=entries,tracked=config['tracked'])
            with patch.object(p,'Observer',FakeObserver),patch.object(p,'version_of',return_value=dict(executable=str(encoder),argv=['-version'],firstLine='ffmpeg version synthetic',sha256=p.digest(encoder))):
                p.run(root/'binding.json',window)
            return p.read_json(window/'receipt.json')
    def test_complete_synthetic_window(self):
        receipt=self.exercise();self.assertTrue(receipt['encoderGone']);self.assertEqual(receipt['limits'],'not-fd-byte-stream-proof')
    def test_window_negatives(self):
        mutations={
            'arm nonce':lambda b,a,f,c:a.update(nonce='wrong'),
            'finished nonce':lambda b,a,f,c:f.update(nonce='wrong'),
            'wrong run':lambda b,a,f,c:f.update(runId='wrong'),
            'missing stop':lambda b,a,f,c:f.update(nativeStopReturnedSuccessfully=False),
            'missing decode':lambda b,a,f,c:f.update(decodedMediaPassed=False),
            'foreign media':lambda b,a,f,c:f.update(webmSha256='f'*64),
            'only version':lambda b,a,f,c:c.update(versionOnly=True),
            'two encoders':lambda b,a,f,c:c.update(secondEncoder=True),
            'still live':lambda b,a,f,c:c.update(tracked='live'),
            'expired arm':lambda b,a,f,c:a.update(deadlineUnixMs=1),
            'observer changed':lambda b,a,f,c:b['observerSources'].update({'installed-encoder-proof.py':'f'*64}),
            'wrong platform':lambda b,a,f,c:b.update(platform='wrong'),
        }
        for name,mutate in mutations.items():
            with self.subTest(name=name):
                with self.assertRaises(ValueError):self.exercise(mutate)


class MacCountContract(unittest.TestCase):
    def test_actual_children_function_with_api_contract_stubs(self):
        source=(HERE/'installed-encoder-proc.c').read_text()
        start=source.index('static int children(');brace=source.index('{',start);depth=1;end=brace+1
        while depth:
            if source[end]=='{':depth+=1
            elif source[end]=='}':depth-=1
            end+=1
        actual=source[start:end]
        harness=r"""
#include <assert.h>
#include <errno.h>
#include <sys/types.h>
#define MAX_CHILDREN 1024
struct snapshot { pid_t pid; };
static int answer=0, failure=0, calls=0;
static int snapshot(pid_t pid, struct snapshot *s){s->pid=pid;return 1;}
static int same(const struct snapshot *a,const struct snapshot *b){return a->pid==b->pid;}
static int proc_listchildpids(pid_t parent,void *out,int bytes){
 assert(parent==42);assert(bytes==(int)(sizeof(pid_t)*(MAX_CHILDREN+1)));calls++;
 pid_t *p=out;for(int i=0;i<answer && i<MAX_CHILDREN+1;i++)p[i]=100+i;
 errno=failure;return answer;
}
"""
        main=r"""
int main(void){struct snapshot parent={42};pid_t out[MAX_CHILDREN+2];
 for(int n=1;n<=4;n++){answer=n;failure=0;assert(children(&parent,out)==n);for(int i=0;i<n;i++)assert(out[i]==100+i);}
 answer=MAX_CHILDREN;assert(children(&parent,out)==MAX_CHILDREN);
 answer=MAX_CHILDREN+1;assert(children(&parent,out)==-1);
 answer=MAX_CHILDREN+2;assert(children(&parent,out)==-1);
 answer=0;failure=0;assert(children(&parent,out)==0);
 answer=0;failure=EACCES;assert(children(&parent,out)==-1);
 answer=-1;failure=0;assert(children(&parent,out)==-1);
 answer=2;failure=EIO;assert(children(&parent,out)==-1);
 assert(calls==11);return 0;}
"""
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'count.c').write_text(harness+actual+main)
            result=subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',str(root/'count.c'),'-o',str(root/'count')],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(root/'count')],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)


class OwnedStop(unittest.TestCase):
    def setUp(self):p.STOP_REQUESTED=False;p.OWNED_CHILDREN.clear();p.WINDOW_NONCE='stop-nonce'
    def tearDown(self):p.STOP_REQUESTED=False;p.OWNED_CHILDREN.clear();p.WINDOW_NONCE=None
    class Stream:
        def __init__(self):self.closed=False
        def close(self):self.closed=True
        def fileno(self):return 123
    class Child:
        def __init__(self,*args,**kwargs):self.stdout=OwnedStop.Stream();self.returncode=None;self.killed=False;self.waited=False
        def poll(self):return self.returncode
        def kill(self):self.killed=True;self.returncode=-9
        def wait(self,timeout):self.waited=True;return self.returncode
        def communicate(self,timeout):
            p.request_stop(None,None)
            raise subprocess.TimeoutExpired('synthetic owned helper',timeout)
    def test_stop_while_mac_helper_active_reaps_exact_handle(self):
        child=self.Child();observer=object.__new__(p.Observer);observer.fixture_pid=42;observer.native='/native';observer.encoder='/ffmpeg';observer.binding={'helperSha256':'hash'}
        with patch.object(p,'digest',return_value='hash'),patch.object(p.subprocess,'Popen',return_value=child) as spawn:
            with self.assertRaisesRegex(ValueError,'observer-stopped'):observer.mac_frame()
            self.assertEqual(spawn.call_count,1)
        self.assertTrue(child.killed and child.waited and child.stdout.closed);self.assertEqual(p.OWNED_CHILDREN,set())
    def test_stop_while_version_probe_active_reaps_exact_handle(self):
        import selectors
        child=self.Child()
        class Selector:
            def register(self,*args):pass
            def select(self,*args):p.request_stop(None,None);return []
            def close(self):pass
        with patch.object(p,'digest',return_value='hash'),patch.object(p.subprocess,'Popen',return_value=child),patch.object(selectors,'DefaultSelector',return_value=Selector()):
            with self.assertRaisesRegex(ValueError,'observer-stopped'):p.version_of('/ffmpeg','hash')
        self.assertTrue(child.killed and child.waited and child.stdout.closed);self.assertEqual(p.OWNED_CHILDREN,set())
    def test_stop_after_eof_during_wait_reaps_actual_harmless_child(self):
        import threading
        entered_wait = threading.Event()
        real_popen = subprocess.Popen
        children = []
        waits = []
        original_waits = []
        stopped_at = []
        def spawn(*args, **kwargs):
            # This is a controlled Python sleep child, never ffmpeg/native/browser.
            child = real_popen([p.sys.executable, '-c', "import os,time; os.write(1,b'ffmpeg version synthetic\\n'); os.close(1); time.sleep(60)"], **kwargs)
            real_wait = child.wait
            original_waits.append(real_wait)
            def wait(timeout=None):
                waits.append(timeout)
                entered_wait.set()
                return real_wait(timeout=timeout)
            child.wait = wait
            children.append(child)
            return child
        def stop_when_waiting():
            if entered_wait.wait(timeout=2):
                stopped_at.append(time.monotonic())
                p.request_stop(None, None)
        stopper = threading.Thread(target=stop_when_waiting)
        stopper.start()
        try:
            with patch.object(p, 'digest', return_value='hash'), patch.object(p.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaisesRegex(ValueError, 'observer-stopped'):
                    p.version_of('/synthetic/ffmpeg', 'hash')
            self.assertEqual(len(stopped_at), 1)
            self.assertLess(time.monotonic() - stopped_at[0], 1.0)
            self.assertTrue(waits and 0 < waits[0] <= .1)
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdout.closed)
            self.assertEqual(p.OWNED_CHILDREN, set())
        finally:
            stopper.join(timeout=2)
            for child, wait in zip(children, original_waits):
                if child.poll() is None:
                    child.kill()
                wait(timeout=2)

    def test_stop_during_spawn_registration_still_reaps(self):
        child=self.Child()
        def spawn(*args,**kwargs):p.request_stop(None,None);return child
        with patch.object(p,'digest',return_value='hash'),patch.object(p.subprocess,'Popen',side_effect=spawn):
            with self.assertRaisesRegex(ValueError,'observer-stopped'):p.version_of('/ffmpeg','hash')
        self.assertTrue(child.killed and child.waited);self.assertEqual(p.OWNED_CHILDREN,set())
    def test_stop_before_spawn_does_not_create_child(self):
        p.request_stop(None,None)
        with patch.object(p.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(ValueError,'observer-stopped'):p.spawn_probe(['/ffmpeg','-version'])
            spawn.assert_not_called()
    def test_exit_ack_refuses_unreaped_child(self):
        child=self.Child();p.OWNED_CHILDREN.add(child)
        child.kill=lambda:None
        child.wait=lambda **kwargs:(_ for _ in ()).throw(subprocess.TimeoutExpired('owned child',.5))
        with self.assertRaises(subprocess.TimeoutExpired):p.retire_probe(child)
        self.assertIn(child,p.OWNED_CHILDREN)
        with tempfile.TemporaryDirectory() as tmp:
            p.write_exit(Path(tmp));self.assertFalse(p.read_json(Path(tmp)/'exit.json')['ownedChildrenReaped'])
        p.OWNED_CHILDREN.clear()
        with tempfile.TemporaryDirectory() as tmp:
            p.write_exit(Path(tmp));ack=p.read_json(Path(tmp)/'exit.json');self.assertTrue(ack['ownedChildrenReaped']);self.assertEqual(ack['nonce'],'stop-nonce')

if __name__=='__main__': unittest.main(verbosity=2)
