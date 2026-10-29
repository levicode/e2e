set -euo pipefail
cat > evidence/tools/validate-vitest.py <<'HELPER_3'
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
