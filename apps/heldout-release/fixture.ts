import { createServer } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const cases = ['missing', 'already-selected', 'preserve-defaults', 'reordered', 'long-list', 'frame'] as const;
type Case = typeof cases[number];
interface Catalog { kind: Case; seed: string; choices: string[]; initial: string[]; wanted: string; expected: string[] }
interface Event { kind: 'read' | 'commit'; selection: string[] }

/** Generates only invented labels; seeds change ordering and the requested target. */
export function catalog(kind: Case, seed: string): Catalog {
  const hash = (value: string) => createHash('sha256').update(`${seed}/${value}`).digest('hex');
  const choices = Array.from({ length: kind === 'long-list' ? 80 : 8 }, (_, n) => `Paper ${hash(String(n)).slice(0, 9)}`).toSorted();
  const wanted = kind === 'missing' ? 'Paper absent-from-catalog' : choices[kind === 'long-list' ? 77 : parseInt(hash('position').slice(0, 2), 16) % 8]!;
  const initial = kind === 'already-selected' ? [wanted] : kind === 'preserve-defaults' ? [choices.find(value => value !== wanted)!] : [];
  const expected = [...new Set([...initial, ...(kind === 'missing' ? [] : [wanted])])].toSorted();
  return { kind, seed, choices: choices.toSorted((a, b) => kind === 'reordered' ? hash(a).localeCompare(hash(b)) : a.localeCompare(b)), initial, wanted, expected };
}

/** Local fixture keeps draft state in the page and committed state in a server journal. */
export async function serve(spec: Catalog, journal: string) {
  let selection = [...spec.initial];
  await writeFile(journal, '');
  const log = (event: Event) => appendFile(journal, JSON.stringify(event) + '\n');
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/collection' && request.method === 'GET') {
        await log({ kind: 'read', selection: [...selection] });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(selection)); return;
      }
      if (request.url === '/collection' && request.method === 'POST') {
        let body = ''; for await (const part of request) { body += part; if (body.length > 10000) throw new Error('limit'); }
        const value: unknown = JSON.parse(body);
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && spec.choices.includes(item)) || new Set(value).size !== value.length) throw new Error('invalid');
        selection = [...value].toSorted(); await log({ kind: 'commit', selection }); response.end('Committed'); return;
      }
      if (request.method !== 'GET' || !['/', '/inside'].includes(request.url ?? '')) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (spec.kind === 'frame' && request.url === '/') { response.end('<h1>Reading room</h1><iframe title="Shelf manager" src="/inside" width="950" height="750"></iframe>'); return; }
      response.end(`<!doctype html><title>Paper shelf</title><h1>Paper shelf</h1><p>Choose papers, apply them to the draft, then publish changes. Refresh loads the saved shelf.</p><button id="choose">Choose papers</button><button id="publish">Publish shelf</button><button id="refresh">Refresh saved shelf</button><ul id="summary"></ul><p role="status" id="notice"></p><dialog id="dialog"><h2>Paper catalog</h2><section id="list" style="max-height:280px;overflow:auto"></section><button id="apply">Apply draft</button><button id="cancel">Cancel</button></dialog><script>
      const options=${JSON.stringify(spec.choices)};const byId=id=>document.getElementById(id);let draft=[],staged=[];
      function render(){byId('summary').replaceChildren(...draft.map(label=>{const node=document.createElement('li');node.textContent=label;return node}))}
      async function refresh(){draft=await(await fetch('/collection')).json();render();byId('notice').textContent='Saved shelf loaded'}refresh();
      byId('choose').onclick=()=>{staged=[...draft];byId('list').replaceChildren(...options.map(label=>{const row=document.createElement('label');row.style.display='block';const box=document.createElement('input');box.type='checkbox';box.checked=staged.includes(label);box.onchange=()=>{staged=box.checked?[...staged,label]:staged.filter(x=>x!==label)};row.append(box,document.createTextNode(label));return row}));byId('dialog').showModal()};
      byId('apply').onclick=()=>{draft=[...staged];render();byId('dialog').close();byId('notice').textContent='Draft only; not published'};
      byId('cancel').onclick=()=>byId('dialog').close();byId('refresh').onclick=refresh;
      byId('publish').onclick=async()=>{const reply=await fetch('/collection',{method:'POST',body:JSON.stringify(draft)});byId('notice').textContent=reply.ok?'Published':'Publish rejected'};
      </script>`);
    } catch { response.writeHead(400).end('Rejected'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

/** Reconstructs success solely from persisted server events, never model or DOM verdicts. */
export async function verify(spec: Catalog, journal: string) {
  const content = await readFile(journal, 'utf8');
  const events = content.trim() ? content.trim().split('\n').map(line => JSON.parse(line) as Event) : [];
  const writes = events.filter(event => event.kind === 'commit');
  const lastWrite = events.findLastIndex(event => event.kind === 'commit');
  const reads = events.filter((event, index) => event.kind === 'read' && index > lastWrite);
  const unchanged = spec.kind === 'missing' || spec.kind === 'already-selected';
  const actual = writes.at(-1)?.selection ?? spec.initial;
  const equals = (value: string[]) => JSON.stringify([...value].toSorted()) === JSON.stringify(spec.expected);
  return { passed: writes.length === (unchanged ? 0 : 1) && equals(actual) && reads.length >= (unchanged ? 2 : 1) && reads.every(event => equals(event.selection)), writes: writes.length, readbacks: reads.length, actual, expected: spec.expected };
}
