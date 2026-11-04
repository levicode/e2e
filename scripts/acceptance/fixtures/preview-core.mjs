/** Synthetic only. Public API fixture, not a native protocol implementation. */
export const TOKEN = 'Tok-9f3aC0DeB1e7';
export const NOTE = 'first line 4417\nsecond line Qx';
export const FORMS = [TOKEN, TOKEN.toUpperCase(), TOKEN.toLowerCase(), NOTE, NOTE.replaceAll('\n', ' '), JSON.stringify(NOTE).slice(1, -1)];
export const CORE_HTML = `<!doctype html><html><head><title>Preview core</title><style>
html,body{margin:0;background:rgb(0,255,0)}
#object{position:absolute;left:16px;top:16px;width:160px;height:80px;border:0;border-radius:0;padding:0;background:linear-gradient(to right,rgb(255,0,0) 50%,rgb(0,0,255) 50%)}
#form{position:absolute;top:120px;left:16px}
</style></head><body><button id="object" aria-label="Screenshot target"></button>
<div id="form"><label>Preview input <input id="draft"></label><button id="apply" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);document.querySelector('output').textContent=document.querySelector('input').value+':'+this.dataset.count">Apply preview</button><output role="status" aria-label="Result">unchanged</output></div></body></html>`;
// Exact /echo HTML from actual7bb forms.ts (blob cad1ef39d3a9c55d3c56fc279a634ed6992634b4),
// with only the surrounding constant() TypeScript wrapper removed.
export const ECHO_HTML = `<!doctype html>
<html>
<head><title>Echo</title></head>
<body>
  <label>Token <input id="token" type="text" oninput="render()" /></label>
  <label>Note <textarea id="note" oninput="render()"></textarea></label>
  <p data-testid="plain">nothing yet</p>
  <p data-testid="upper" style="text-transform: uppercase">nothing yet</p>
  <p data-testid="lower" style="text-transform: lowercase">nothing yet</p>
  <pre data-testid="note-echo">nothing yet</pre>
  <script>
    function render() {
      const token = document.getElementById('token').value;
      for (const id of ['plain', 'upper', 'lower']) {
        document.querySelector('[data-testid="' + id + '"]').textContent = token;
      }
      document.querySelector('[data-testid="note-echo"]').textContent = document.getElementById('note').value;
    }
  </script>
</body>
</html>`;
export const CONFIG = `import { web } from '@e2e-dev/web';
import { writeFileSync } from 'node:fs';
const forms = ${JSON.stringify(FORMS)};
function requireFact(ok, code) { if (!ok) throw new Error(code); }
export default {
 tests: 'tests/**/*.e2e.ts', workers: 1, retries: 0,
 secrets: { token: ${JSON.stringify(TOKEN)}, note: ${JSON.stringify(NOTE)} },
 targets: [{ name: 'preview', engine: web({ viewport: { width: 640, height: 480 } }), app: { url: process.env.PREVIEW_CORE_URL } }],
 agents: { default: { executor: { name: 'preview-public-api', version: '1', cache: 'off', async runStep(ctx) {
   if (ctx.step.instruction === 'preview refs action') {
     const observed = await ctx.observe({ tree: true });
     requireFact(!observed.treeUnavailable && !observed.truncated && !!observed.tree, 'COMPACT_TREE_UNAVAILABLE');
     const pending = [observed.tree]; const matches = [];
     while (pending.length) { const node = pending.pop(); if (node.role === 'button' && node.name === 'Apply preview') matches.push(node); pending.push(...(node.children || [])); }
     requireFact(matches.length === 1, 'COMPACT_UNIQUE_BUTTON_REQUIRED');
     const line = observed.text.split('\\n').filter(line => line.includes('"Apply preview"'));
     requireFact(line.length === 1, 'COMPACT_LINE_REQUIRED');
     const displayReference = line[0].trim().split(/\\s+/)[0];
     requireFact(displayReference === '#' + matches[0].id, 'EXACT_NATIVE_REFERENCE_DISPLAY_REQUIRED');
     const reference = displayReference.slice(1);
     await ctx.actions.tap({ id: displayReference });
     const middle = await ctx.observe({ tree: true });
     requireFact(middle.text.includes('preview-filled-731:1'), 'DISPLAY_REF_ACTION_EFFECT_MISSING');
     requireFact(!middle.treeUnavailable && !middle.truncated && !!middle.tree, 'SECOND_TREE_UNAVAILABLE');
     const nextPending=[middle.tree], nextMatches=[];
     while(nextPending.length){const node=nextPending.pop();if(node.role==='button' && node.name==='Apply preview')nextMatches.push(node);nextPending.push(...(node.children||[]));}
     requireFact(nextMatches.length===1, 'SECOND_BUTTON_REQUIRED');
     const secondId=nextMatches[0].id; await ctx.actions.tap({ id: secondId });
     const after = await ctx.observe();
     requireFact(after.text.includes('preview-filled-731:2'), 'RAW_REF_ACTION_EFFECT_MISSING');
     writeFileSync(process.env.PREVIEW_CORE_WITNESS, JSON.stringify({ schemaVersion: 1, nativeReference: reference, observedTreeId: matches[0].id, dispatchId: displayReference, displayReference, compactText: observed.text, middleText: middle.text, secondObservedTreeId: secondId, secondDispatchId: secondId, afterText: after.text, refAction: true }));
     return { status: 'passed', summary: 'Native compact reference action verified' };
   }
   if (ctx.step.instruction === 'read the echoes') {
     const observed = await ctx.observe();
     requireFact(!forms.some(form => observed.text.includes(form)), 'SECRET_OBSERVATION_LEAK');
     requireFact(observed.text.includes('<secret:token>') && observed.text.includes('<secret:note>'), 'SECRET_MARKERS_MISSING');
     writeFileSync(process.env.PREVIEW_SECRET_WITNESS, JSON.stringify({ schemaVersion: 1, observation: observed.text, allSixFormsAbsent: true }));
     return { status: 'passed', summary: 'read' };
   }
   return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'Unknown preview instruction' };
 } } } }
};
`;
export const CORE_TEST = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { writeFileSync } from 'node:fs';
test('preview core public flow', async ({ app, browser, screen, agent }) => {
 await app.open('/');
 await expect(browser).toHaveTitle('Preview core');
 await screen.getByLabel('Preview input').fill('preview-filled-731');
 await expect(screen.getByLabel('Preview input')).toHaveValue('preview-filled-731');
 const compact = await screen.tree();
 if (!compact.includes('Apply preview')) throw new Error('SCREEN_COMPACT_TEXT_MISSING');
 await agent.act('preview refs action');
 await expect(screen.getByRole('status', { name: 'Result' })).toHaveText('preview-filled-731:2');
 await expect(screen.getByRole('button', { name: 'Screenshot target' })).toHaveScreenshot('preview-object');
 const screenshot = await app.screenshot('preview-viewport');
 writeFileSync(process.env.PREVIEW_SCREENSHOT_WITNESS, JSON.stringify({ screenshot, fillPassed: true, refEffectPassed: true, objectMatcherPassed: true, compact }));
});
`;
// Original transformed-secrets six cases/values/assertions, moved to installed CLI.
export const SECRET_TEST = `import { test, expect, secrets } from 'e2e';
async function fillBoth(app, screen) {
 await app.open('/echo');
 await screen.getByLabel('Token').fill(secrets.get('token'));
 await screen.getByLabel('Note').fill(secrets.get('note'));
}
for (const id of ['plain', 'upper', 'lower', 'note-echo']) {
 test('fails on the ' + id + ' echo', async ({ app, screen }) => {
  await fillBoth(app, screen);
  await expect(screen.getByTestId(id)).toHaveText('something else', { timeout: 500 });
 });
}
test('observes the echoes', async ({ app, screen, agent }) => {
 await fillBoth(app, screen); await agent.act('read the echoes');
});
test('matches the transformed text', async ({ app, screen }) => {
 await fillBoth(app, screen);
 await expect(screen.getByTestId('upper')).toHaveText(${JSON.stringify(TOKEN.toUpperCase())});
 await expect(screen.getByTestId('lower')).toHaveText(${JSON.stringify(TOKEN.toLowerCase())});
 await expect(screen.getByTestId('note-echo')).toHaveText(${JSON.stringify(NOTE.replaceAll('\n', ' '))});
});
`;
