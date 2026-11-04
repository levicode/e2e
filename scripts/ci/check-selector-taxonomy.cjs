const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const root = { nodeType: 9 }, hit = { nodeType: 1 };
let fault;
const limit = {};
const document = { evaluate() { if (fault) throw fault; let first = true; return { iterateNext() { if (first) { first = false; return hit; } return null; } }; } };
const make = new Function('elements','document','DOMException','matcherLimit','matcherStep','compileRawInternalParts','prepareRawCssPrograms','rawInternalEngines','rawCssProgram','XPathResult', source + '\nreturn { selectChain, invalidSelector, rawXPathSelectorError };');
const runtime = make([hit], document, DOMException, limit, () => {}, x => x, () => {}, new Set(), () => null, { ORDERED_NODE_ITERATOR_TYPE: 5 });
const query = () => runtime.selectChain([{ engine:'xpath', body:'//*[' }],[0],root);
for (const [name, cause, expected] of [
 ['native-syntax',new DOMException('synthetic','SyntaxError'),runtime.rawXPathSelectorError],
 ['name-spoof',{name:'SyntaxError'},runtime.invalidSelector],
 ['prototype-spoof',Object.create(DOMException.prototype,{name:{value:'SyntaxError'}}),runtime.invalidSelector],
 ['native-name-spoof',Object.defineProperty(new DOMException('synthetic','SecurityError'),'name',{value:'SyntaxError'}),runtime.invalidSelector],
 ['foreign-prototype-native',Object.setPrototypeOf(new DOMException('synthetic','SyntaxError'),{}),runtime.rawXPathSelectorError],
 ['type-error',new TypeError('synthetic'),runtime.invalidSelector],
 ['security-dom',new DOMException('synthetic','SecurityError'),runtime.invalidSelector],
 ['resource-budget',limit,limit],
]) { fault=cause; assert.throws(query,e=>e===expected,name); }
fault=null; assert.deepEqual(query(),[0]);
console.log('PASS exact selector_query.js fake-DOM: native syntax only; spoof/type/security unchanged; budget preserved; valid query unchanged. No browser/native runtime.');
