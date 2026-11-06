/**
 * The model-driven UAT verification run: a real AI SDK model decides the path.
 *
 * The read-only baseline (`e2e.config.ts`) stays scripted and deterministic;
 * this config replaces the executor with a model constructed from the private
 * `~/.config/e2e-uat/llm.json`. It runs the same fixed read path and the
 * writable label loop, so a run records real model rounds, latency, tokens, and
 * the decisions it made — including wrong ones, since `retries` is 0 and the
 * runner never repairs a decision behind the model's back.
 */
import type { E2EConfig } from 'e2e';
import { uatEngine } from './src/engine.ts';
import { createUatModel, loadUatModelSettings } from './src/model.ts';
import { loadUatSettings } from './src/settings.ts';

const settings = loadUatSettings({ requireAccountId: true, requireLabel: true });
const { model } = createUatModel(loadUatModelSettings());

export default {
  projectId: 'dev.e2e.uat-verification.model',
  targets: [
    {
      name: 'uat',
      engine: uatEngine(),
      app: { url: settings.entryUrl },
    },
  ],
  tests: ['tests/**/*.e2e.ts', '!tests/login.e2e.ts'],
  agents: {
    default: {
      model,
      // A label edit is several model turns on a slow internal page.
      maxSteps: 40,
      maxModelCalls: 60,
      judgmentTimeout: 90_000,
      // Every action result used to carry a screenshot once the model had
      // seen one: 13 images for 2 explicit looks in one run. Pay for pixels
      // only when the model asks for them.
      pixels: 'on-request',
      system: [
        'Hands-on tester. Act on what the screen shows, verify each save, and never guess a different account or label.',
        'When a needed control is an unlabeled icon, take a screenshot and use tap_at on the icon; prefer a listed node id otherwise.',
      ].join(' '),
      context: [
        'This is the ad-manager UAT app: a Chinese admin console.',
        'The home route is 首页; 账号管理 opens the account menu and 账号标签管理 its submenu.',
        'On 账号标签管理, type the account ID into 请输入账号ID and press 查询; the result row has 编辑.',
        '编辑 opens a dialog titled 编辑 > <account> with 自动打标 and 手动打标 sections and 确定/取消 buttons.',
        'The plus icon at the right of 手动打标 opens 标签列表; it is an unlabeled icon node, so tap the unlabeled node id that follows the last 手动打标 tag, or use a screenshot and tap_at its center at the card\'s right edge.',
        'In 标签列表, type the label ID into 请输入..., press 查询, tick the matching row, and press 确定.',
        'A 手动打标 tag has a small × that removes it; 确定 then opens a confirmation dialog whose 确定 saves.',
        'Only the queried account and the label the step names may be changed; never another account or label.',
      ].join(' '),
    },
  },
  timeout: 300_000,
  retries: 0,
  cache: 'off',
  trace: 'retain-on-failure',
  output: '.e2e-model',
} satisfies E2EConfig;
