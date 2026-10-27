import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const nativeRoot = process.env.SELECTOR_NATIVE_ROOT;
assert.ok(nativeRoot, 'exact native checkout required');
assert.ok(process.env.SELECTOR_PARSER_BIN, 'compiler-built parser required');
assert.equal(process.env.SELECTOR_BASE, '2b9e0a00ee6466e55c52dacdba1d4f1bece2e2aa');
const filename = path.join(nativeRoot, 'cli/src/native/client_observation.rs');
const source = fs.readFileSync(filename, 'utf8');
const block = source.slice(source.indexOf('const MATCH_QUERY:'), source.indexOf('/// Query matching and publication'));
const candidate = [...block.matchAll(/r#"([\s\S]*?)"#|include_str!\("([^"]+)"\)/g)].map(m => m[1] ?? fs.readFileSync(path.join(path.dirname(filename), m[2]), 'utf8')).join('');
assert.ok(process.env.SELECTOR_BASELINE_FILE, 'exact parent source required');
const baseline = fs.readFileSync(process.env.SELECTOR_BASELINE_FILE, 'utf8').match(/const MATCH_QUERY: &str = r#"([\s\S]*?)"#;/)[1];
class Element {
  constructor(tag, attrs={}, children=[]) { this.nodeType=1;this.nodeName=tag.toUpperCase();this.tag=tag;this.attrs=attrs;this.childNodes=children;this.isConnected=true;for(const child of children)child.parentNode=this; }
  get parentElement() { return this.parentNode?.nodeType===1?this.parentNode:null; }
  get ownerDocument() { return document; }
  getRootNode() { return this.parentNode?.getRootNode() ?? this; }
  matches(css) {
    if(css.includes('>>')||css.startsWith('css=')||css==='[')throw new SyntaxError();
    if(css==='*')return true;
    if(css===':scope')return true;
    if(css.startsWith('input[type='))return false;
    const match = css.match(/^(\w+)?(?:\[([\w-]+)="([^"]*)"\])?$/);
    if(!match)throw new SyntaxError(css);
    return (!match[1]||match[1]===this.tag)&&(!match[2]||this.attrs[match[2]]===match[3]);
  }
  querySelectorAll(css) { const found=[];for(const child of this.childNodes){if(child.matches(css))found.push(child);found.push(...child.querySelectorAll(css));}return found; }
}
class Root extends Element { constructor(children=[],host=null) {super('root',{},children);this.nodeType=host?11:9;this.host=host;} }
const li=(text)=>new Element('li',{'data-v':text});
const first=[li('zero'),li('one')],second=[li('two'),li('three')];
const sections=[new Element('section',{},[new Element('ul',{'data-testid':'items'},first)]),new Element('section',{},[new Element('ul',{},second)])];
const open=new Element('aside'),closed=new Element('aside');
open.shadowRoot=new Root([new Element('button')],open);
const closedRoot=new Root([new Element('button')],closed);
const document=new Root([...sections,open,closed]);
document.evaluate=(xpath,root)=>{assert.ok(['.//li','//li'].includes(xpath));const found=root.querySelectorAll('li');let i=0;return {iterateNext:()=>found[i++]??null};};
Object.assign(globalThis,{document,Element,HTMLInputElement:class{},XPathResult:{ORDERED_NODE_ITERATOR_TYPE:5,ORDERED_NODE_SNAPSHOT_TYPE:7}});
const elements=[...document.querySelectorAll('*'),...open.shadowRoot.querySelectorAll('*'),...closedRoot.querySelectorAll('*')];
const data=elements.map(()=>({states:{}})),labels=elements.map(()=>[]),safeNames=elements.map(()=>null),protectedAncestors=elements.map(()=>false);
function compile(selector) {const result=spawnSync(process.env.SELECTOR_PARSER_BIN,[selector],{encoding:'utf8'});assert.equal(result.status,0);const line=result.stdout.trim();assert.ok(!line.startsWith('!'),line);return {kind:'selector',selector,nativeParts:line.split(';').filter(Boolean).map(part=>{const i=part.lastIndexOf(':');return{engine:part.slice(0,i),body:Buffer.from(part.slice(i+1),'hex').toString()};})};}
function run(source,expression) {return Function('return ('+source+')')()(expression,structuredClone(data),structuredClone(labels),safeNames,'input[type="password" i]',protectedAncestors,...elements);}
function ids(nodes){return nodes.map(n=>elements.indexOf(n));}
const cases=[
 ['css=ul[data-testid="items"] >> *css=li',ids(first)],
 ['section >> nth=1 >> li >> nth=0',ids([second[0]])],
 ['li >> nth=-1',ids([second[1]])],
 ['li >> nth=-2',ids([second[0]])],
 ['li >> nth=-99',[]],
 ['li >> nth=NaN',[]],
 ['li >> nth=Infinity',[]],
 ['li >> nth=-Infinity',[]],
 ['li >> nth=1e309',[]],
 ['li >> nth=9007199254740992',[]],
 ['li >> nth=\u3000-1\u00a0',ids([second[1]])],
 ['li >> nth=\ufeff2\ufeff',ids([second[0]])],
 ['li >> nth=1.5',ids([first[1]])],
 ['li >> nth=0x2',ids([second[0]])],
 ['li >> nth=',ids([first[0]])],
 ['li >> nth=99',[]],
 ['section >> nth=0 >> xpath=//li >> nth=-1',ids([first[1]])],
 ['aside >> button',ids(open.shadowRoot.childNodes)],
 ['css:light=button',[]],
];
let red=0;
for(const [selector,expected] of cases) {
 const expression=compile(selector), actual=run(candidate,expression);
 assert.deepEqual(actual.indices,expected,selector+': '+JSON.stringify(actual));
 const old=run(baseline,{kind:'selector',selector});if(JSON.stringify(old.indices)!==JSON.stringify(expected))red++;
}
assert.equal(red, cases.length, 'all original chained-selector cases must reject or differ on the exact baseline');
const has={kind:'filter',source:compile('section'),has:compile('ul >> li >> nth=1')};
assert.deepEqual(run(candidate,has).indices,ids(sections));
assert.equal(run(candidate,compile('css=[')).error,'invalid-locator');
console.log(`PASS: ${cases.length+2} exact matcher/chain interpreter cases with an explicit DOM test double; ${red}/${cases.length} chains fail on exact baseline. Not a browser/E2E proof.`);
