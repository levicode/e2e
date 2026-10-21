/**
 * Deterministic model-boundary integration, not a real-model quality benchmark.
 * A fake AI SDK provider reads only the actual model request and returns native
 * @refs through the built-in agent, openHost, and the real agent-browser engine.
 * All pages, labels, and stored values are synthetic; no private service is used.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { expect, type ModelInstance } from 'e2e';
import { openHost } from 'e2e/runner';
import { agentBrowser, type Browser } from '../dist/index.js';

const ROW_COUNT = 240;
const ITEM = 'Sample item';
const ITEM_ID = 9001;

interface Request { prompt: Array<{ role: string; content: unknown }>; }
interface ToolCall { toolName: string; input: Record<string, unknown>; }
interface Scenario { existing: boolean; refusedScreenshot: boolean; }
type FixtureState = {
  items: Array<{ id: number; name: string }>;
  selected: number[];
  edits: number;
  adds: number;
  innerConfirmations: number;
  outerSaves: number;
  outerOpens: number;
  pickerOpens: number;
  pickerCancels: number;
  editorCancels: number;
  persistedAtInnerConfirm: number[][];
  queries: string[];
  trusted: boolean[];
};

/** Extracts SDK text parts without treating model arguments or image bytes as evidence. */
function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return [];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const part = value as Record<string, unknown>;
  if (typeof part.text === 'string') return [part.text];
  if ((part.type === 'text' || part.type === 'error-text') && typeof part.value === 'string') return [part.value];
  return ['content', 'output', 'value'].flatMap(key => textParts(part[key]));
}

/** Counts image-bearing provider parts, rather than screenshots saved as artifacts. */
function imageParts(value: unknown): number {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return 0;
  const part = value as Record<string, unknown>;
  if (part.type === 'image' || (typeof part.mediaType === 'string' && part.mediaType.startsWith('image/'))) return 1;
  return Object.values(part).reduce<number>((count, child) => count + imageParts(child), 0);
}

/** Holds only model-visible full screens and their added/changed/removed updates. */
class ModelScreen {
  private readonly nodes = new Map<string, string>();
  private unaddressed: string[] = [];
  latest = '';
  largestCheckboxCount = 0;

  /** Reconstructs current evidence even when a later observation reports an unchanged screen. */
  get text(): string { return [...this.unaddressed, ...this.nodes.values()].join('\n'); }

  /** Ingests the newest tool result, or the opening user message on the first turn. */
  read(request: Request): void {
    const message = request.prompt.findLast(part => part.role === 'tool')
      ?? request.prompt.findLast(part => part.role === 'user');
    assert.ok(message, 'The provider request must include actual screen evidence');
    this.latest = textParts(message.content).join('\n');
    const fullScreen = this.latest.search(/Current screen \(revision /);
    const lines = (fullScreen < 0 ? this.latest : this.latest.slice(fullScreen)).split('\n');
    if (fullScreen >= 0) { this.nodes.clear(); this.unaddressed = []; }
    for (const raw of lines) {
      const match = /^(?:(added|changed|removed) )?(@e\d+) (.+)$/.exec(raw.trim());
      if (!match) { if (fullScreen >= 0) this.unaddressed.push(raw); continue; }
      const [, change, ref, description] = match;
      assert.ok(ref && description);
      if (change === 'removed') this.nodes.delete(ref);
      else this.nodes.set(ref, description.split(' (was: ', 1)[0]!);
    }
    this.largestCheckboxCount = Math.max(this.largestCheckboxCount, this.count('checkbox'));
  }

  /** Resolves a unique current semantic control, never a selector or hidden fixture state. */
  ref(role: string, name: string): string {
    const prefix = `${role} ${JSON.stringify(name)}`;
    const matches = [...this.nodes].filter(([, description]) => description === prefix || description.startsWith(`${prefix} `));
    assert.equal(matches.length, 1, `The model must see exactly one ${prefix}`);
    const ref = matches[0]![0];
    assert.match(ref, /^@e\d+$/, 'The provider must return the native reference unchanged');
    return ref;
  }

  /** Reads the states and value associated with a model-visible control. */
  description(role: string, name: string): string { return this.nodes.get(this.ref(role, name))!; }

  /** Counts controls in the screen the model actually received, including below-fold rows. */
  count(role: string): number { return [...this.nodes.values()].filter(description => description.startsWith(`${role} `)).length; }

  /** Distinguishes an unavailable option from a missing seed after an item is staged. */
  has(role: string, name: string): boolean {
    const prefix = `${role} ${JSON.stringify(name)}`;
    return [...this.nodes.values()].some(description => description === prefix || description.startsWith(`${prefix} `));
  }

  /** Verifies the entire dense list arrived before treating a missing item as absent. */
  inventory(existing: boolean): void {
    assert.equal(this.count('checkbox'), ROW_COUNT, 'Default budgets must preserve the full dense list');
    this.ref('button', 'Edit items');
    this.ref('button', 'Confirm choices');
    assert.equal(this.has('checkbox', ITEM), existing);
    if (existing) this.ref('group', `Item ID ${ITEM_ID}: ${ITEM}`);
  }
}

/** Builds nested dialogs: picker confirmation stages chips; only the outer Save commits IDs. */
function fixturePage(scenario: Scenario): string {
  const items = Array.from({ length: ROW_COUNT }, (_, index) => ({ id: 1001 + index, name: `Item ${String(index + 1).padStart(3, '0')}` }));
  if (scenario.existing) items[177] = { id: ITEM_ID, name: ITEM };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Item picker fixture</title>
    <style>
      body{margin:24px;font:16px sans-serif;background:white;color:#17202a}
      dialog{width:620px;border:1px solid #444;padding:20px}dialog::backdrop{background:#ddd8}
      #items{height:340px;overflow:auto;border:1px solid #bbb;padding:8px}
      #items label{display:block;min-height:28px}input[type=checkbox]{margin-right:10px}
      footer{display:flex;gap:12px;margin-top:16px}button{padding:8px 14px}
      #editor{margin:12px 0}#editor label{display:block}object{position:absolute;right:20px;top:20px;width:120px;height:60px}
    </style></head><body>
    <h1>Item selection</h1><p id="summary" role="status">Saved selection: none</p>
    <button id="open">Edit selection</button>
    ${scenario.refusedScreenshot ? '<object type="image/svg+xml" data="/vector" aria-label="Decorative vector"></object>' : ''}
    <dialog id="outer" aria-label="Selection editor"><h2>Edit selection</h2>
      <p id="persisted" role="status"></p><div id="chips" role="group" aria-label="Draft selection"></div>
      <button id="choose">Choose items</button>
      <footer><button id="save">Save selection</button><button id="close">Cancel editing</button></footer>
    </dialog>
    <dialog id="picker" aria-label="Item choices"><h2>Choose items</h2>
      <p>Already chosen items are excluded from this list, not missing from the catalog.</p>
      <p id="chosen" role="status"></p><label for="search">Search items</label><input id="search" type="search">
      <div id="items" role="group" aria-label="Available items"></div>
      <p id="list-end">End of item list</p>
      <div id="editor" hidden><label for="new-id">New item ID</label><input id="new-id" inputmode="numeric">
        <label for="new-name">New item name</label><input id="new-name"><button id="add">Add item</button></div>
      <footer><button id="edit">Edit items</button><button id="confirm">Confirm choices</button><button id="cancel">Cancel choices</button></footer>
    </dialog><script>
      const key='synthetic-modal-fixture';
      const state=JSON.parse(localStorage.getItem(key)||'null')||{
        items:${JSON.stringify(items)},selected:[],edits:0,adds:0,innerConfirmations:0,outerSaves:0,
        outerOpens:0,pickerOpens:0,pickerCancels:0,editorCancels:0,persistedAtInnerConfirm:[],queries:[],trusted:[]
      };
      window.fixtureState=state;
      const outer=document.getElementById('outer');
      const picker=document.getElementById('picker');
      const list=document.getElementById('items');
      const editor=document.getElementById('editor');
      const idField=document.getElementById('new-id');
      const nameField=document.getElementById('new-name');
      const search=document.getElementById('search');
      let draft=new Set(state.selected);let pending=new Set();
      const save=()=>localStorage.setItem(key,JSON.stringify(state));
      const audit=event=>{state.trusted.push(event.isTrusted);save()};
      const names=ids=>ids.map(id=>state.items.find(item=>item.id===id)?.name||'unknown');
      const summary=()=>document.getElementById('summary').textContent='Saved selection: '+(names(state.selected).join(', ')||'none');
      const renderDraft=()=>{
        document.getElementById('persisted').textContent='Saved IDs: '+(state.selected.join(', ')||'none');
        const chips=document.getElementById('chips');chips.replaceChildren();
        for(const id of draft){
          const item=state.items.find(item=>item.id===id);const chip=document.createElement('span');
          chip.textContent=item.name+' (ID '+item.id+')';const remove=document.createElement('button');
          remove.textContent='Remove '+item.name;
          remove.addEventListener('click',event=>{draft.delete(id);renderDraft();audit(event)});
          chip.append(remove);chips.append(chip);
        }
      };
      const render=()=>{
        list.replaceChildren();
        const query=search.value.toLowerCase();
        const available=state.items.filter(item=>!draft.has(item.id)&&(!query||String(item.id).includes(query)||item.name.toLowerCase().includes(query)));
        document.getElementById('chosen').textContent='Already chosen: '+([...draft].map(id=>names([id])[0]+' (ID '+id+')').join(', ')||'none');
        document.getElementById('list-end').textContent=available.length?'End of item list':'No available matches';
        for(const item of available){
          const group=document.createElement('div');group.setAttribute('role','group');
          group.setAttribute('aria-label','Item ID '+item.id+': '+item.name);
          const label=document.createElement('label');
          const input=document.createElement('input');input.type='checkbox';input.checked=pending.has(item.id);
          input.addEventListener('change',event=>{if(input.checked)pending.add(item.id);else pending.delete(item.id);audit(event)});
          label.append(input,document.createTextNode(item.name));group.append(label);list.append(group);
        }
      };
      document.getElementById('open').addEventListener('click',event=>{
        state.outerOpens++;draft=new Set(state.selected);renderDraft();outer.showModal();audit(event);
      });
      document.getElementById('choose').addEventListener('click',event=>{
        state.pickerOpens++;pending=new Set();search.value='';editor.hidden=true;render();picker.showModal();audit(event);
      });
      document.getElementById('edit').addEventListener('click',event=>{state.edits++;editor.hidden=false;audit(event)});
      idField.addEventListener('input',audit);nameField.addEventListener('input',audit);
      search.addEventListener('input',event=>{state.queries.push(search.value);render();audit(event)});
      document.getElementById('add').addEventListener('click',event=>{
        const id=Number(idField.value);const name=nameField.value.trim();if(!id||!name)return;
        state.items.push({id,name});state.adds++;idField.value='';nameField.value='';editor.hidden=true;render();audit(event);
      });
      document.getElementById('confirm').addEventListener('click',event=>{
        for(const id of pending)draft.add(id);state.innerConfirmations++;
        state.persistedAtInnerConfirm.push([...state.selected]);renderDraft();picker.close();audit(event);
      });
      document.getElementById('cancel').addEventListener('click',event=>{state.pickerCancels++;picker.close();audit(event)});
      document.getElementById('save').addEventListener('click',event=>{state.selected=[...draft];state.outerSaves++;summary();outer.close();audit(event)});
      document.getElementById('close').addEventListener('click',event=>{state.editorCancels++;outer.close();audit(event)});
      summary();
    </script></body></html>`;
}

/** Creates scripted SDK decisions; the provider has no browser handle or fixture-state access. */
function deterministicModel(scenario: Scenario) {
  const screen = new ModelScreen();
  let calls = 0;
  let beforeRefusal = '';
  let refusalSeen = false;
  const dispatched: ToolCall[] = [];
  const tap = (name: string): ToolCall => ({ toolName: 'tap', input: { target: screen.ref('button', name) } });
  const decisions: Array<() => ToolCall> = [() => tap('Edit selection'), () => {
    assert.ok(screen.text.includes('Saved IDs: none'));
    assert.equal(screen.has('button', `Remove ${ITEM}`), false);
    return tap('Choose items');
  }];
  if (scenario.refusedScreenshot) {
    decisions.push(() => {
      screen.inventory(scenario.existing);
      beforeRefusal = screen.ref('button', 'Edit items');
      return { toolName: 'screenshot', input: {} };
    });
  }
  if (!scenario.existing) {
    decisions.push(() => {
      screen.inventory(false);
      if (!scenario.refusedScreenshot) return tap('Edit items');
      assert.match(screen.latest, /POLICY_DENIED/);
      assert.match(screen.latest, /Screenshot masking could not be proven/);
      refusalSeen = true;
      assert.equal(screen.ref('button', 'Edit items'), beforeRefusal);
      return { toolName: 'tap', input: { target: beforeRefusal } };
    }, () => ({ toolName: 'type', input: { target: screen.ref('textbox', 'New item ID'), value: String(ITEM_ID) } }), () => {
      assert.ok(screen.description('textbox', 'New item ID').includes(`value="${ITEM_ID}"`));
      return { toolName: 'type', input: { target: screen.ref('textbox', 'New item name'), value: ITEM } };
    }, () => {
      assert.ok(screen.description('textbox', 'New item name').includes(`value=${JSON.stringify(ITEM)}`));
      return tap('Add item');
    });
  }
  decisions.push(() => {
    if (scenario.existing) screen.inventory(true);
    else assert.equal(screen.count('checkbox'), ROW_COUNT + 1);
    screen.ref('group', `Item ID ${ITEM_ID}: ${ITEM}`);
    assert.doesNotMatch(screen.description('checkbox', ITEM), /\[[^\]]*\bchecked\b/);
    return { toolName: 'check', input: { target: screen.ref('checkbox', ITEM), checked: true } };
  }, () => {
    assert.match(screen.description('checkbox', ITEM), /\[[^\]]*\bchecked\b/);
    return tap('Confirm choices');
  }, () => {
    screen.ref('button', `Remove ${ITEM}`);
    assert.ok(screen.text.includes(`${ITEM} (ID ${ITEM_ID})`), 'Inner confirmation must produce a draft chip with its ID/name mapping');
    assert.ok(screen.text.includes('Saved IDs: none'), 'Inner confirmation must not be mistaken for the outer Save');
    return tap('Choose items');
  }, () => {
    assert.equal(screen.count('checkbox'), ROW_COUNT - (scenario.existing ? 1 : 0));
    assert.equal(screen.has('checkbox', ITEM), false, 'The picker excludes an already staged item');
    assert.ok(screen.text.includes(`Already chosen: ${ITEM} (ID ${ITEM_ID})`));
    return { toolName: 'type', input: { target: screen.ref('searchbox', 'Search items'), value: String(ITEM_ID) } };
  }, () => {
    assert.equal(screen.count('checkbox'), 0);
    assert.ok(screen.text.includes('No available matches'));
    assert.equal(screen.has('checkbox', ITEM), false);
    return tap('Cancel choices');
  }, () => {
    screen.ref('button', `Remove ${ITEM}`);
    assert.ok(screen.text.includes('Saved IDs: none'));
    return tap('Save selection');
  }, () => {
    assert.ok(screen.text.includes(`Saved selection: ${ITEM}`), 'Only the outer Save commits the selection');
    return { toolName: 'navigate', input: { url: '/' } };
  }, () => {
    assert.ok(screen.text.includes(`Saved selection: ${ITEM}`), 'Reload must reread the persisted selection');
    return tap('Edit selection');
  }, () => {
    screen.ref('button', `Remove ${ITEM}`);
    assert.ok(screen.text.includes(`Saved IDs: ${ITEM_ID}`), 'Reopened editor must retain the committed numeric ID');
    assert.ok(screen.text.includes(`${ITEM} (ID ${ITEM_ID})`), 'The numeric ID must read back as the display-name chip');
    return tap('Cancel editing');
  }, () => {
    assert.ok(screen.text.includes(`Saved selection: ${ITEM}`));
    return { toolName: 'complete_step', input: { status: 'passed', summary: 'Staged one synthetic item, saved the outer editor and reread its numeric ID/display name without duplicating it' } };
  });
  const model = {
    specificationVersion: 'v4', provider: 'fixture', modelId: 'deterministic-modal-boundary', supportedUrls: {},
    async doGenerate(request: Request) {
      if (calls === 0) {
        const system = request.prompt.filter(message => message.role === 'system').flatMap(message => textParts(message.content)).join('\n');
        assert.ok(system.includes('Distinguish staged selections from persisted results.'), 'The actual model payload must receive the staged/save rule');
        assert.ok(system.includes('An empty filtered choice list does not prove SEED_DATA_MISSING'), 'The actual model payload must receive the seed-data evidence rule');
      }
      const text = request.prompt.flatMap(message => textParts(message.content)).join('\n');
      assert.doesNotMatch(text, /agent-browser:[0-9a-f]{8}-/i, 'Opaque engine identities must not reach the model');
      assert.doesNotMatch(text, /#@e\d+/, 'Native references must not acquire a second prefix');
      assert.equal(imageParts(request.prompt), 0, 'No image bytes may reach this semantic-only or screenshot-refused provider');
      screen.read(request);
      const decide = decisions[calls];
      assert.ok(decide, 'The deterministic fixture must finish within its scripted model calls');
      const call = decide();
      if ('target' in call.input) assert.match(String(call.input.target), /^@e\d+$/);
      dispatched.push(call);
      calls++;
      return {
        content: [{ type: 'tool-call', toolCallId: `modal_${calls}`, toolName: call.toolName, input: JSON.stringify(call.input) }],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
        warnings: [],
      };
    },
    async doStream(): Promise<never> { throw new Error('This deterministic fixture uses non-streaming requests'); },
  } as ModelInstance;
  return { model, dispatched, screen, calls: () => calls, expectedCalls: decisions.length, refusalSeen: () => refusalSeen };
}

/** Runs one isolated public hosted session with default agent budgets and independent UI oracles. */
async function runScenario(scenario: Scenario): Promise<void> {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'A verified native executable is required; this integration must not silently skip');
  const server = createServer((request, response) => {
    if (request.url === '/vector') {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="silver"/></svg>');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fixturePage(scenario));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cwd = await mkdtemp(path.join(tmpdir(), 'e2e-modal-model-boundary-'));
  const brain = deterministicModel(scenario);
  let host: Awaited<ReturnType<typeof openHost<{ browser: Browser }>>> | undefined;
  try {
    host = await openHost<{ browser: Browser }>({ cwd, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
      projectId: 'synthetic-modal-model-boundary',
      targets: [{ name: 'fixture', platform: 'web', app: { url: `http://127.0.0.1:${address.port}` }, engine: agentBrowser({
        executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!,
        executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
        args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
        viewport: { width: 960, height: 720 },
      }) }],
      agents: { default: { model: brain.model } },
      workers: 1, retries: 0, timeout: 180_000, launchTimeout: 60_000, actionTimeout: 30_000,
      cache: 'off', video: 'off', trace: 'on',
    } });
    const session = await host.openSession({ name: 'deterministic dense modal model boundary' });
    try {
      await session.fixtures.app.open('/');
      if (scenario.refusedScreenshot) {
        assert.equal(await session.fixtures.browser.evaluate('new Promise(resolve => {const owner=document.querySelector("object");const ready=()=>owner.contentDocument?.contentType==="image/svg+xml";if(ready())resolve(true);else owner.addEventListener("load",()=>resolve(ready()),{once:true});})'), true);
      }
      await session.fixtures.agent.act(`Edit the selection and choose item ID ${ITEM_ID}, whose display name is ${ITEM}. Add that ID/name only if absent from both the catalog and the draft. Confirm the inner picker and inspect the draft chip. Reopen the picker and search by ID: an already chosen item is excluded, so no match does not mean its catalog seed is missing. Cancel the picker, Save selection in the outer editor, reload and reopen the editor to read back the saved ID/name, then cancel editing.${scenario.refusedScreenshot ? ' First request a screenshot of the initially opened picker; if it is refused, continue using the semantic controls.' : ''}`);
      await expect(session.fixtures.screen.getByRole('button', { name: 'Edit selection', exact: true })).toBeVisible();
      await expect(session.fixtures.screen.getByRole('status')).toHaveText(`Saved selection: ${ITEM}`);
      const state = await session.fixtures.browser.evaluate<FixtureState>('window.fixtureState');
      assert.equal(state.items.length, ROW_COUNT + (scenario.existing ? 0 : 1));
      assert.equal(state.items.filter(item => item.id === ITEM_ID || item.name === ITEM).length, 1, 'Neither path may duplicate an ID or a display name');
      assert.deepEqual(state.items.find(item => item.id === ITEM_ID), { id: ITEM_ID, name: ITEM });
      assert.deepEqual(state.selected, [ITEM_ID]);
      assert.equal(state.edits, scenario.existing ? 0 : 1);
      assert.equal(state.adds, scenario.existing ? 0 : 1);
      assert.equal(state.innerConfirmations, 1);
      assert.equal(state.outerSaves, 1);
      assert.deepEqual(state.persistedAtInnerConfirm, [[]], 'Inner confirmation must stage, not persist the selection');
      assert.equal(state.outerOpens, 2);
      assert.equal(state.pickerOpens, 2);
      assert.equal(state.pickerCancels, 1);
      assert.equal(state.editorCancels, 1);
      assert.equal(state.queries.at(-1), String(ITEM_ID));
      assert.ok(state.trusted.length > 0 && state.trusted.every(Boolean), 'The browser must deliver real native user input, not synthetic DOM events');
      assert.equal(brain.calls(), brain.expectedCalls);
      assert.equal(brain.refusalSeen(), scenario.refusedScreenshot);
      assert.ok(brain.screen.largestCheckboxCount >= ROW_COUNT);
      assert.equal(brain.dispatched.filter(call => call.toolName === 'screenshot').length, scenario.refusedScreenshot ? 1 : 0);
      assert.equal(brain.dispatched.filter(call => call.toolName === 'type').length, scenario.existing ? 1 : 3);
      await session.close();
      const report = session.report(); assert.ok(report); assert.equal(report.run.status, 'passed');
      const steps = report.run.results.flatMap(result => result.attempts.flatMap(attempt => attempt.steps)).filter(step => step.api === 'agent.act');
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.status, 'passed');
      assert.equal(steps[0]!.metrics?.modelCalls, brain.expectedCalls);
      assert.ok((steps[0]!.metrics?.observationBytes ?? 0) > 8_000, 'The fixture must exercise a dense real observation');
      assert.notEqual(steps[0]!.visionInput, true);
      assert.equal(steps[0]!.metrics?.pixelBytes ?? 0, 0);
    } finally { await session.close(); }
  } finally {
    try { await host?.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
  }
}

test('deterministic model boundary: dense missing-item picker adds, stages, saves outer dialog and rereads IDs', { timeout: 240_000 }, () => runScenario({ existing: false, refusedScreenshot: false }));
test('deterministic model boundary: existing and staged items are never duplicated by a picker miss', { timeout: 240_000 }, () => runScenario({ existing: true, refusedScreenshot: false }));
test('deterministic model boundary: screenshot refusal preserves native refs for semantic modal completion', { timeout: 240_000 }, () => runScenario({ existing: false, refusedScreenshot: true }));
