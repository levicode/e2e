# Local UAT verification loop

A private harness for the ad-manager UAT environment: sign in once, then run one
of two paths on this machine and get a redacted report that says which e2e and
agent-browser builds ran, which step failed with which code, which native
operation settled how, how long each observation phase took, and — on the model
path — how many model rounds it spent and what those rounds decided.

| Path | Command | What decides | Used for |
| --- | --- | --- | --- |
| `scripted` | `pnpm --filter @e2e-dev/uat-verification verify` | `src/scenario.ts`, no model | Deterministic regression baseline |
| `model` | `pnpm --filter @e2e-dev/uat-verification verify:model` | A real AI SDK model from the private config | Real agent decisions, including the writable label loop |

The default commands use the engine launch; `verify:cdp` and `verify:model:cdp`
run the optional CDP launch, and `verify:engine`/`verify:model:engine` name the
default explicitly.

Both verification paths can run on two browser launches. The engine launch is
the main path and the default, because it is how the user starts the browser;
the CDP launch is optional, for an environment that needs external SPKI/proxy
launch arguments. Add `--paths scripted` or `--paths model` to the fixed runner
to run one path; pass `--browser cdp` to `verify`/`verify:model` for the
optional launch. The fixed runner runs each selected path on the engine launch
by default; `--browsers engine,cdp` runs both.

| Launch | Chromium started by | Window | Viewport | Private proxy/TLS |
| --- | --- | --- | --- | --- |
| `engine` (default) | the target's `web()`, as the user's project does | headless | 1440×1000 | `AGENT_BROWSER_CA_CERT`, `AGENT_BROWSER_PROXY`, `AGENT_BROWSER_PROXY_BYPASS` forwarded (see below) |
| `cdp` (optional) | `src/trusted-browser.ts`; the target attaches over CDP | headless | 1440×900 | external launch arguments |

See [Browser launch paths](#browser-launch-paths) for what each one proves and
why both exist. A config run directly reads `UAT_BROWSER_PATH` (`engine` or
`cdp`); the scripts set it.

Nothing private is committed. The entry URL, the queried account ID, the label,
and the model credential live in files outside the checkout; the login state
lives beside them; raw run output stays in the gitignored output directories.
Only the redacted report is written to the user's state directory.

The normal way to run the loop is the fixed checkout at `~/src/e2e-uat`, with
one command that updates it, installs and builds when needed, builds the
pinned agent-browser, and runs each selected path on the selected launch (the
engine launch by default) with the saved session. See
[FIXED-CHECKOUT.md](FIXED-CHECKOUT.md) for that flow, its dependencies, and its
failure modes. The commands in this README also work from a normal development
checkout when the packages are already built.

## One-time setup

The fixed-checkout runner installs and builds the packages and the pinned
agent-browser source by itself. A development checkout still needs the
prerequisites below.

Prerequisites:

- Node.js 22.22.3+, or 24.8+ (this app runs the repository's built packages).
- `pnpm build` at the repository root, so `packages/e2e/dist` and
  `packages/web/dist` exist.
- Chromium for the web engine:
  `pnpm --filter @e2e-dev/web exec playwright-core install chromium`.
- Rust and `cargo` on `PATH` for the fixed runner's agent-browser build. A
  development checkout instead needs a native agent-browser build: a verified
  runtime bundle installed as `.e2e/native-runtime.json`, or
  `E2E_AGENT_BROWSER_EXECUTABLE` pointing at a trusted absolute binary. The
  report records the version and binary sha256, plus the commit only when the
  native build record proves that commit built this binary (see
  [Native build identity](#native-build-identity)).

Write the private settings once (mode 0600, never in the repository):

```bash
mkdir -p ~/.config/e2e-uat && chmod 700 ~/.config/e2e-uat
cat > ~/.config/e2e-uat/config.json <<'JSON'
{
  "entryUrl": "http://<uat-host>/<app>/",
  "loginUrl": "http://<sso-host>/login.html",
  "accountId": "<account id to query>",
  "labelId": "<label id to add and remove>",
  "labelName": "<label name as the page renders it>"
}
JSON
chmod 600 ~/.config/e2e-uat/config.json
```

`UAT_ENTRY_URL`, `UAT_LOGIN_URL`, `UAT_ACCOUNT_ID`, `UAT_LABEL_ID`, and
`UAT_LABEL_NAME` override the file, and
`UAT_CONFIG_FILE`/`UAT_SESSION_FILE`/`UAT_REPORTS_DIR` move the fixed locations.

An environment whose app needs a proxy or an internal CA may also put `env`
(environment variables for the browser, such as `AGENT_BROWSER_PROXY` and
`AGENT_BROWSER_PROXY_BYPASS`), `chromiumArgs` (for example the exact SPKI
hashes: `["--ignore-certificate-errors-spki-list=<hash>"]`), and
`chromeExecutable` in that file. These values are machine-local and private.

The engine launch is the default and the main path: the target's `web()` starts
Chromium, verification runs headless, and the private `env` reaches it as
`AGENT_BROWSER_*` variables, the way the user's project loads `.env.local`. The
private CA at `~/.config/e2e-uat/internal-ca.pem`, or the file named by
`UAT_CA_CERT`, is passed as `AGENT_BROWSER_CA_CERT`; the web engine forwards it
to the native launcher, which trusts only that file (Linux imports it into the
launch's NSS store, macOS pins its public key in Chromium's SPKI allow list).
`chromiumArgs` and `chromeExecutable` have no channel on this launch. The
optional `--browser cdp` launch starts Chromium with those arguments instead and
attaches the engine over CDP.

The `cdp` launch honors a `UAT_CDP_ENDPOINT` exported in the shell when the
private settings name no Chromium, args, or env, so an operator-started browser
still works. Otherwise the loop starts its own Chromium and replaces a leftover
endpoint. Verification is headless on both launches; only the login step asks
for a window.

For the model path only, write the private model settings beside it:

```bash
cat > ~/.config/e2e-uat/llm.json <<'JSON'
{
  "provider": "openai",
  "api": "responses",
  "model": "<model id>",
  "baseUrl": "http://<internal-gateway>/v1",
  "apiKey": "<key>"
}
JSON
chmod 600 ~/.config/e2e-uat/llm.json
```

`api` is `responses` (the default) or `chat`; it selects
`openai.responses(model)` or `openai.chat(model)` and the provider label the
report records (`openai.responses/<id>` or `openai.chat/<id>`). `baseUrl` is for
an internal gateway; omit it for the public API. `UAT_LLM_FILE` moves the file,
and `UAT_LLM_PROVIDER`/`UAT_LLM_API`/`UAT_LLM_MODEL`/`UAT_LLM_BASE_URL`/
`UAT_LLM_API_KEY` override it for one run. A missing file, a mode other than
0600, a missing key, an unimplemented provider, or an unknown protocol fails
with a `UAT_LLM_*` code before any browser opens; there is no silent fallback to
the scripted path.

## Native build identity

The report may only name an agent-browser commit when something ties it to the
binary that actually ran, by sha256. That thing is a native build record at
`~/.local/state/e2e-uat/native-build.json` (`UAT_NATIVE_BUILD_STATE` moves it).
The fixed-checkout runner writes it with the build; `verify` writes it on the
first run after a build when the provenance checks pass, and `native:record`
writes it explicitly:

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification native:record
```

The recorder refuses a checkout with uncommitted changes, a HEAD other than
the commit `.github/native-candidate.json` pins, a checkout with no remote for
the pinned repository, and a binary older than the checkout's last HEAD move;
those states cannot prove what built the binary. `verify` prints the refusal
reason otherwise, so the scripted and model paths agree without an extra step.
Run the command yourself after checking out the pin and building:
`cargo build --locked --profile ci --no-default-features` in the checkout's
`cli/` directory. A no-op `cargo build` that leaves the old binary in place
keeps its old mtime; touch it or force a rebuild before recording.

The report never falls back to the HEAD of the git checkout that contains the
binary. A checkout can move after the build — that is what once labelled the
same `354fe006` binary with the previous `75bb6ed3` pin — so without a matching
record the version line shows the sha256 and `构建提交未验证` (commit
unverified) instead of a commit. If a record exists and its sha256 does not
match the binary, the run stops before opening a browser with
`UAT_NATIVE_IDENTITY_MISMATCH` and names both digests.

## Sign in once

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification login
```

When the private settings name a Chromium, launch arguments, or browser env,
login starts that trusted Chromium and attaches over CDP, because the sign-in
page needs the same TLS/proxy handling; verification still defaults to the
engine launch. Otherwise login uses the engine launch. Either way a headed
browser opens the UAT login page; only the login step needs a window. Scan the QR code with WeCom once; the
page redirects back to the app, the test verifies the home route, and the login
state is saved to `~/.config/e2e-uat/session.json` (directory 0700, file 0600).
The file holds live cookies and the app origin's `localStorage`; it is never
printed, committed, attached to a report, or sent to GitHub.

An expired session is a first-class failure: a missing, unreadable, foreign
origin, or fully expired file fails the run with `UAT_SESSION_EXPIRED` and the
login command above, instead of a silent redirect to the login page.

## Run the scripted baseline

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification verify
```

One command restores the session, walks the fixed read-only scenario — home →
账号管理 → 账号标签管理 → the account ID field → 查询 — and writes the report. It
never creates, edits, deletes, or submits business data; the only request it
waits for is the page's own account query. This is the regression baseline: the
same path, the same engine events, and the same observation phases on every run,
with no model variance or cost.

Run it on one browser launch with `... verify -- --browser engine` or
`... verify -- --browser cdp`; without the flag the engine launch runs.

## Run the model path

```bash
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
  pnpm --filter @e2e-dev/uat-verification verify:model
```

The same session and read path, then a real model decides how to add the
configured label to the configured account, a deterministic assertion checks the
result, the model removes it, and a final assertion checks the account is back
to its initial state. Writes are limited to the account and label named in
`config.json`; no other account or label is touched.

`... verify:model -- --browser engine` runs the same model path on the user's
launch.

The path is built to show what the model actually did:

- `retries: 0` and no harness repair. A wrong node, a misread result, or a
  failed action stays in the report with its code and native
  `effects`/`scopeState`; the runner never retries it behind the model's back.
- The report's `model` section sums the model rounds, the model-turn wall time,
  and provider-reported input/output tokens (plus cache and estimated cost when
  the provider reports them), per step and for the run.
- The `# 模型决策与动作` section lists each round's tool calls and what came
  back, so a wrong decision can be read without the full raw transcript.

If the model path fails part-way, the report says what remains changed and the
next step; do not read a failed run as "the account is clean". The raw trace and
screenshots (which the model saw) stay in `.e2e-model/`, gitignored and private.

## Output conventions

- Raw run output: `apps/uat-verification/.e2e/` (scripted) or
  `apps/uat-verification/.e2e-model/` (model) in the checkout that executed the
  run, both gitignored. The fixed runner leaves them in `~/src/e2e-uat`. They
  hold the report, trace pages, and a failure screenshot; treat them as private.
- Native ledger: `native-results.jsonl` in the same output directory, enabled by
  `E2E_NATIVE_RESULT_LEDGER` for this run only. One line per native operation
  with the command, sequence, transmitted timeout, `ok`, `effects`,
  `scopeState`, error code, and retention counters — never arguments, payloads,
  page text, or URLs.
- Redacted report: `~/.local/state/e2e-uat/reports/<timestamp>/report.md` and
  `report.json`. Both paths share the structure: `path`, the `browser` launch
  (`engine` or `cdp`, headed or headless, viewport, how the private settings
  reached the browser, and whether CA trust came from the engine, external
  launch args, or nowhere), status, the exact e2e and agent-browser builds (the
  native commit only when a build record proves it), per-step codes, observation
  `phases`, the native `code`/`effects`/`scopeState` table, and — on the model
  path — `model` with rounds, latency, and tokens. The host, login host, account
  ID, and label are replaced with placeholders.

Exit codes: `0` passed, `2` the saved session, the private model settings, or
the native build identity are unusable (fix the named file or build record,
scan again if the session expired), anything else the run itself failed.

## Why two paths

The scripted path answers “did the product regress on this fixed route?” without
depending on a model, a key, or a network. The model path answers the question a
script cannot: “can a real agent still complete this flow, including the write
path that previously failed with unknown outcomes?” A model failure is a result,
not a reason to silently rerun the scripted path; the two reports share a
structure so they can be compared side by side, and only the model report has
model rounds, latency, and token usage.

A model-path failure first says which layer failed: connection (gateway
unreachable or proxy), authentication (key rejected), protocol (responses/chat
mismatch or the gateway rejecting the request shape), or the product itself. The
report keeps the code and message so that distinction is not lost.

## Browser launch paths

The engine launch is the main path and runs by default: it answers “does the
flow work when Chromium is started the way the user's project starts it?”. The
target's `web()` launches, verification runs headless, the page is 1440×1000,
and the private `env` is handed to the engine as `AGENT_BROWSER_*` variables,
the way a project that loads `.env.local` does. The CDP launch is optional: it answers
“does the external-launch + SPKI scheme still work?”, with
`src/trusted-browser.ts` starting Chromium with the private `chromiumArgs` and
proxy arguments and the target attaching over CDP. Use it when the private CA or
proxy must be applied by launch arguments, or when a headless baseline is
wanted. Run the fixed runner with the default `--browsers engine`, or
`--browsers cdp`, or both.

The native library's isolated `session connect` transport is what separates the
two. The e2e engine starts the native worker through that transport, and the
worker removes **every** `AGENT_BROWSER_*` variable from its environment before
it starts the browser daemon (`cli/src/connection.rs`, `run_isolated_client_session`;
only a small allowlist of socket, namespace, and diagnostic variables survives).
The engine's own environment is not the limitation: the variables reach the
worker and are removed one layer later.

The private CA and proxy are the launch options the engine carries across that
boundary in the launch command itself (`caCert`, `proxy`, `proxyBypass` in the
interop envelope), so they work even though the environment is stripped.
agent-browser implements the CA on Linux with an isolated NSS store and on macOS
with Chromium's SPKI allow list derived from the named file; no certificate
errors are ignored globally. Arbitrary Chromium arguments (`AGENT_BROWSER_ARGS`)
still cannot reach this launch, so `.env.local` settings other than the CA and
proxy do not affect it; use the optional CDP launch for those.

That has two consequences:

- The engine launch trusts the private CA through `AGENT_BROWSER_CA_CERT` and
  uses the private proxy through `AGENT_BROWSER_PROXY`/`AGENT_BROWSER_PROXY_BYPASS`,
  forwarded in the launch command even though the isolated transport strips the
  environment. Arbitrary Chromium arguments (`AGENT_BROWSER_ARGS`) still cannot
  reach it; use the optional CDP launch for those.
- The external CDP launch stays as the optional path for arbitrary launch
  arguments and the SPKI-based launch. It is no longer the only way to trust the
  private CA or set the browser proxy.

A machine that also trusts the CA in its OS store needs none of this; the loop
does not depend on that, so a macOS machine with no keychain trust in the CA is
covered too. This is the same launch shape as the user's run: on the pre-fix
agent-browser pin (`d6e0e5f2` plus only the CA forwarding) the model path
reproduced agent-browser#61, the observation right after 账号标签管理 failing
with `browser-failure` and a quarantined scope before the context was
destroyed; with the current pin that scenario passes. Before the native pin carried `caCert` across the interop boundary
and implemented macOS trust, the engine launch failed at the first navigation
with `ACTION_FAILED` / `browser-failure`; the report keeps that failure shape
whenever the CA file is missing or rejected.
