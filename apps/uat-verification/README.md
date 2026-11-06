# Local UAT verification loop

A private, read-only harness for the ad-manager UAT environment: reuse the
local SSO session, run one fixed scenario on this machine, and get a redacted
report that says which e2e and agent-browser builds ran, which step failed with
which code, which native operation settled how, and how long each observation
phase took.

Nothing private is committed. The entry URL, the queried account ID, the
machine-local Chromium args, and the login state live in files outside the
checkout, and the raw run output stays in the gitignored `.e2e/` directory. Only
the redacted report is written to the user's state directory.

## One-time setup

Prerequisites:

- Node.js 22.22.3+, or 24.8+ (this app runs the repository's built packages).
- `pnpm build` at the repository root, so `packages/e2e/dist` and
  `packages/web/dist` exist.
- Chromium for the web engine:
  `pnpm --filter @e2e-dev/web exec playwright-core install chromium`.
- A native agent-browser build: either a verified runtime bundle installed as
  `.e2e/native-runtime.json`, or `E2E_AGENT_BROWSER_EXECUTABLE` pointing at a
  trusted absolute binary. The report records the version, binary sha256, and
  the checkout commit when one can be found.
- The local SSO client (`~/code/script/bili-auth`) with a usable cached session.
  `bili-auth status` reports readiness; `bili-auth setup --store file` is the
  one-time local setup and never happens in this loop.

Write the private settings once (mode 0600, never in the repository):

```bash
mkdir -p ~/.config/e2e-uat && chmod 700 ~/.config/e2e-uat
cat > ~/.config/e2e-uat/config.json <<'JSON'
{
  "entryUrl": "http://<uat-host>/<app>/",
  "loginUrl": "http://<sso-host>/login.html",
  "accountId": "<account id to query>"
}
JSON
chmod 600 ~/.config/e2e-uat/config.json
```

`UAT_ENTRY_URL`, `UAT_LOGIN_URL`, and `UAT_ACCOUNT_ID` override the file, and
`UAT_CONFIG_FILE`/`UAT_SESSION_FILE`/`UAT_REPORTS_DIR` move the three fixed
locations.

A private environment may need machine-local browser settings: an internal CA the
bundled Chromium does not trust, or a local proxy that must bypass the internal
hosts. Add them to the same private file:

```json
"chromiumArgs": [
  "--ignore-certificate-errors-spki-list=<sha256 of the leaf's SPKI>"
],
"env": {
  "AGENT_BROWSER_PROXY": "http://127.0.0.1:7890",
  "AGENT_BROWSER_PROXY_BYPASS": "*.hdslb.com,*.bilibili.co,localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
}
```

`chromiumArgs` go only to the Chromium this loop launches. The SPKI list trusts
exactly the named certificate, not every HTTPS origin: prefer it over a global
certificate-error bypass. `AGENT_BROWSER_PROXY_BYPASS` is comma-separated here
and becomes Chromium's semicolon-separated bypass list; internal hosts must be
listed or the local proxy will swallow them.

The e2e engine's own launch path isolates the browser transport and strips every
`AGENT_BROWSER_*` variable, so it cannot carry those values. The loop therefore
launches its Chromium itself and the target attaches over CDP through
`connect: { cdpEndpoint }` (`UAT_CDP_ENDPOINT`), which is a public engine
option. `chromeExecutable` may name a different Chromium; by default the
engine's installed browser is used.

## Sign in from the local SSO session

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification login
```

No QR code and no human step: a small Python helper asks the local `bili-auth`
client for the current SSO session and writes the `_AJSESSIONID` and `username`
cookies to a 0600 file (never to an argument, stdout, or a log). The loop sets
them in the Chromium it launched, opens the app, verifies the home route, and
saves the browser's cookies and `localStorage` to
`~/.config/e2e-uat/session.json` (directory 0700, file 0600). The session file
holds live credentials; it is never printed, committed, attached to a report, or
sent to GitHub. If the app redirects to the login page, the SSO session or the
TLS trust is the problem, and the run says so instead of reporting a product
defect.

An expired session is a first-class failure: a missing, unreadable, foreign
origin, or fully expired file fails the run with `UAT_SESSION_EXPIRED` and the
login command above, instead of a silent redirect to the login page.

## Run the fixed scenario

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification verify
```

This one command restores the session, runs the read-only scenario — home →
账号管理 → 账号标签管理 → the account ID field → 查询 — and writes the report.
It never creates, edits, deletes, or submits business data; the only request it
waits for is the page's own account query.

Exit codes: `0` passed, `2` the saved session expired (scan again), anything
else the run itself failed.

## Output conventions

- Raw run output: `apps/uat-verification/.e2e/` (gitignored). It holds the
  report, trace pages, and a failure screenshot; treat it as private.
- Native ledger: `apps/uat-verification/.e2e/native-results.jsonl`, enabled by
  `E2E_NATIVE_RESULT_LEDGER` for this run only. One line per native operation
  with the command, sequence, transmitted timeout, `ok`, `effects`,
  `scopeState`, error code, and retention counters — never arguments, payloads,
  page text, or URLs.
- Redacted report: `~/.local/state/e2e-uat/reports/<timestamp>/report.md` and
  `report.json`. The markdown carries the status, the exact e2e and
  agent-browser builds, per-step codes, observation `phases`, and the native
  `code`/`effects`/`scopeState` table; the host, login host, and account ID are
  replaced with placeholders.

## Why a scripted executor

The scenario drives the agent step path with a scripted executor
(`src/scenario.ts`) instead of a model: a fixed scenario must take the same path
on every run, and the observation events (and their phases) come from that path.
The executor finds controls by their visible name or placeholder and acts by
node id, exactly as an agent step would, so the report records the same engine
events and phases a real agent run produces — without model variance or cost.
