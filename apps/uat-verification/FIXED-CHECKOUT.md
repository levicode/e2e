# Fixed-checkout UAT verification

The UAT loop normally runs from `~/src/e2e-uat`, a standalone clone outside the
repository and every ticket workspace. The checkout exists only to execute the
verification. Do not edit, commit, or develop there; a dirty checkout is
refused rather than stashed.

Ticket worktrees disappear when a ticket closes. The private config, session,
and reports already live outside the repository, so the fixed checkout
completes the set: it survives ticket cleanup, tracks `main`, and keeps the
same SSO session across updates.

## One command

```bash
node ~/src/e2e-uat/apps/uat-verification/scripts/fixed-checkout.ts
```

That command:

1. Checks that the directory is a standalone, clean clone at the fixed path.
2. Fetches `origin` and checks out the target commit, detached.
3. Runs `pnpm install --frozen-lockfile` only when the lockfile or toolchain
   changed since the last successful install.
4. Runs `pnpm run build` only when this commit has not been built yet.
5. Checks out the agent-browser pin from `.github/native-candidate.json` in the
   runner-owned clone at `~/.local/state/e2e-uat/agent-browser` and builds it
   when the pin or the binary changed. The built binary is handed to the engine
   as `E2E_AGENT_BROWSER_EXECUTABLE`.
6. Runs `verify` and `verify:model` with the saved SSO session on the engine
   launch, the user's main path. `--browsers cdp` adds the optional SPKI
   launch.
7. Prints each run's report path under `~/.local/state/e2e-uat/reports`.

One run at a time. The runner holds
`~/.local/state/e2e-uat/fixed-checkout.lock` for the whole update, install,
build, and verification. A second run exits `2` with `UAT_CHECKOUT_BUSY`
instead of checking out under the first run.

A second run at the same commit still fetches and checks out, but skips install,
the package build, and the native build. The state files that make those
decisions live at `~/.local/state/e2e-uat/checkout-state.json` and
`~/.local/state/e2e-uat/native-build.json`. They hold paths, commit hashes,
toolchain versions, and timestamps, never credentials or session data. The
runner writes an empty fingerprint before install and build and restores it
only after the operation succeeds, so a failed or interrupted build is rebuilt
on the next run.

The same command is available as `pnpm --filter @e2e-dev/uat-verification fixed`
when the current directory is the fixed checkout.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--checkout <dir>` | `$UAT_CHECKOUT_DIR` or `~/src/e2e-uat` | The standalone clone to execute from. |
| `--ref <ref>` | `origin/main` | The fetched ref to check out. A bare branch is read from `origin` first; a tag or local-only ref falls back to the local name. |
| `--commit <sha>` | none | An exact commit to check out; overrides `--ref`. |
| `--paths <list>` | `scripted,model` | Run one or both verification paths, comma-separated, in the order given. |
| `--browsers <list>` | `engine` | Run each selected path on one or both browser launches, comma-separated, in the order given. `cdp` is the optional SPKI launch. |
| `--remote <url>` | `https://github.com/levicode/e2e.git` | Clone URL when the checkout does not exist. |
| `--force-install` | off | Install even when the lockfile and toolchain are unchanged. |
| `--force-build` | off | Build the packages even when this commit was already built. |

`UAT_CHECKOUT_DIR`, `UAT_CHECKOUT_STATE`, and `UAT_CHECKOUT_REMOTE` move the
default checkout, the state file, and the clone URL. `UAT_NATIVE_CLONE` (or the
older `UAT_AGENT_BROWSER_CHECKOUT`) and `UAT_NATIVE_BUILD_STATE` move the native
checkout and its build record. `UAT_REPORTS_DIR` moves the report directory.

For example, to build in a dedicated clone you manage yourself:

```bash
UAT_NATIVE_CLONE="$HOME/src/agent-browser-uat" \
  node ~/src/e2e-uat/apps/uat-verification/scripts/fixed-checkout.ts --paths scripted
```

That clone must still be a standalone, clean checkout with no worktrees; the
guards do not weaken for an explicit path. Do not point it at
`~/src/agent-browser`, the shared clone this default exists to stay out of.

Exit codes: `0` every selected verification path passed on every selected
browser launch, `2` the run could not start or the session or private model
settings are unusable, anything else a path ran and did not pass. Setup
failures (usage, a rejected checkout, a missing build tool, a commit without
the UAT runner) also exit 2. A session or settings failure stops before the
second path.

## First-time setup

Create the e2e clone once, outside the repository and outside the supervisor's
workspace:

```bash
git clone https://github.com/levicode/e2e.git ~/src/e2e-uat
```

Then write the private settings and sign in as described in
[README.md](README.md). The runner creates its state directory and the
runner-owned native clone at `~/.local/state/e2e-uat/agent-browser`, installs
the packages, and builds agent-browser on its first run.

## Dependencies

The runner checks these before it starts a browser and names the missing one:

- Node in `^22.22.3 || >=24.8.0`. This repository builds TypeScript 7 packages.
- pnpm with the major version in the root `packageManager` pin (`pnpm@12.3.4`
  today).
- Rust and `cargo` on `PATH`, with the host platform toolchain. The runner
  builds the pinned agent-browser source; it needs no vendored binary.
- Chromium for the web engine when the private settings do not name
  `chromeExecutable`:
  `pnpm --filter @e2e-dev/web exec playwright-core install chromium`.
- `~/.config/e2e-uat/config.json` for both paths, `llm.json` for the model path,
  and a session saved by `login`.

The native half has fixed locations:

- `~/.local/state/e2e-uat/agent-browser` is the runner-owned agent-browser
  checkout. The runner requires the pin file to use schemaVersion 1 and name
  `levicode/agent-browser`, clones that repository there when the directory is
  missing, and fetches and checks out the pinned commit on every run.
  `UAT_NATIVE_CLONE` moves it; `UAT_AGENT_BROWSER_CHECKOUT` is its older alias.
- `cli/target/ci/agent-browser` is the binary `cargo build --locked --profile
  ci --no-default-features` writes in that checkout's `cli/` directory.
- `~/.local/state/e2e-uat/native-build.json` records which commit and binary
  digest the last successful build produced. `UAT_NATIVE_BUILD_STATE` moves it.

The report takes the agent-browser source commit from `native-build.json` only
when that record's sha256 matches the binary that runs, and its version and
sha256 from the binary. The checkout's HEAD is never the commit label: a
checkout can move after the build. A binary with no matching record still
records its version and sha256, but not the commit.

### The runner-owned native clone

The native checkout is UAT machinery, not a development clone. The default
`~/.local/state/e2e-uat/agent-browser` belongs to the runner, sits beside its
state files and reports, and is created, fetched, and checked out by the same
command that runs the verification. A manual clone such as
`~/src/agent-browser`, and any worktree inside it, is a different directory: the
runner never reads, verifies, or cleans it unless `UAT_NATIVE_CLONE` (or
`UAT_AGENT_BROWSER_CHECKOUT`) names it, so concurrent development cannot change
or fail a UAT run.

Set `UAT_NATIVE_CLONE` (or `UAT_AGENT_BROWSER_CHECKOUT`) to build in a clone you
own instead. The standalone-clone and worktree guards apply to whichever path is
used: a checkout that hosts worktrees is still refused with
`UAT_NATIVE_CHECKOUT_INVALID`, because a shared checkout can change under the
build. To force a fresh clone at the same pin, delete the runner-owned
directory; the next run clones and builds it again.

### An explicit binary

Setting `E2E_AGENT_BROWSER_EXECUTABLE` to an absolute trusted binary skips the
checkout and build and uses that binary instead. This is the escape hatch for a
machine without a Rust toolchain, or for testing one specific build. The runner
also reads the bare `AGENT_BROWSER_EXECUTABLE` as its own alias for the same
override; the engine itself reads only `E2E_AGENT_BROWSER_EXECUTABLE`. The
report prefers the explicit binary, so it names what actually ran.

A verified runtime descriptor at
`apps/uat-verification/.e2e/native-runtime.json` only validates when the app
resolves bundle-installed packages. A workspace `pnpm install` links `e2e` and
`@e2e-dev/web` to their source packages, so the fixed checkout uses the built
binary and always sets the variable. Keep a descriptor for a direct development
run if it is useful; when both exist, the explicit binary wins.

## Updating

- `main` is the default target. The command fetches it, checks it out detached,
  and runs it.
- To run a pull request branch before it merges:
  `node ~/src/e2e-uat/apps/uat-verification/scripts/fixed-checkout.ts --ref origin/agent/<branch>`.
- To reproduce one exact run:
  `--commit <full sha>`. A commit whose tree lacks the UAT verification or the
  fixed runner is refused with `UAT_APP_MISSING` before HEAD moves, so the
  fixed checkout stays usable.
- When a target commit moves `.github/native-candidate.json`, the same command
  checks out that pin and rebuilds agent-browser. The rebuild is decided by the
  pin commit and the binary digest in `native-build.json`; no path or manual
  step changes.
- The SSO session is at `~/.config/e2e-uat/session.json` and the reports are
  under `~/.local/state/e2e-uat/reports`; neither is inside the checkout, so
  updating never invalidates them. The login command below is the only time the
  session changes.
- If the checkout needs a harness fix, make it in a normal worktree and merge
  it. The fixed checkout picks it up from `main` on the next run.

## Troubleshooting

### The session expired

The run exits `2` and names the session expiry with the login command. Sign in
once from the fixed checkout:

```bash
cd ~/src/e2e-uat
pnpm --filter @e2e-dev/uat-verification login
```

Scan the QR code with WeCom while the headed window is open. The session is
written to `~/.config/e2e-uat/session.json` and the next fixed-checkout run
reuses it. Do not copy the session file into the repository or a ticket.

### TLS, an internal CA, or a proxy

The default `engine` launch trusts a private CA file: put the PEM at
`~/.config/e2e-uat/internal-ca.pem` (or set `UAT_CA_CERT`), and `verify` passes
it as `AGENT_BROWSER_CA_CERT`; the web engine forwards it to the native launcher,
which trusts only that file (Linux NSS, macOS SPKI allow list). Without that
file the engine launch fails with a certificate error, so provide it on an
internal-CA machine. The private `config.json` may still name a Chromium binary,
extra launch arguments, and browser environment variables. Its `env` proxy
settings also apply to the default engine launch (the engine forwards
`AGENT_BROWSER_PROXY`/`AGENT_BROWSER_PROXY_BYPASS`); `chromiumArgs` and
`chromeExecutable` apply to the optional `cdp` browser launch only. See
"Browser launch paths" in [README.md](README.md) for the full explanation.

```json
{
  "chromeExecutable": "/absolute/path/to/Google Chrome for Testing",
  "chromiumArgs": ["--ignore-certificate-errors-spki-list=<base64 sha256 SPKI>"],
  "env": {
    "AGENT_BROWSER_PROXY": "http://<proxy>:<port>",
    "AGENT_BROWSER_PROXY_BYPASS": "<uat-host>,127.0.0.1,localhost"
  }
}
```

With any of these set, `--browser cdp` (or `--browsers cdp`) launches that
Chromium and the engine attaches over CDP, so the private proxy and SPKI list
apply to the page. A missing binary
fails with `UAT_CHROME_MISSING`. Use the exact SPKI hash for the internal CA
rather than disabling certificate validation for every host.

If the model gateway is unreachable, the report's failure says whether the
connection, the key, or the request shape failed. `baseUrl` in `llm.json`
points at an internal gateway; a proxy for the model process belongs in the
shell environment, not in the browser `env` block.

### The native checkout or build fails

`UAT_CARGO_MISSING` means `cargo` is not on `PATH`; install Rust and re-run.
`UAT_NATIVE_PIN_MISSING` names a missing or malformed
`.github/native-candidate.json`; `UAT_NATIVE_PIN_UNREACHABLE` means the pinned
commit is not in the agent-browser checkout's origin. `UAT_NATIVE_CHECKOUT_DIRTY`
lists local changes in the runner-owned clone; keep that checkout build-only.
`UAT_NATIVE_CHECKOUT_INVALID` means the path is not a standalone clone or hosts
worktrees; this applies to the runner-owned path and to an explicit
`UAT_NATIVE_CLONE`. `UAT_NATIVE_BUILD_FAILED` means cargo finished without
producing `cli/target/ci/agent-browser`; read the cargo output above it.

A failed build leaves no reusable native fingerprint, so the next run builds
again. To force a rebuild at the same pin, remove
`~/.local/state/e2e-uat/native-build.json` or the binary.

`UAT_NATIVE_MISSING` only appears when an explicit
`E2E_AGENT_BROWSER_EXECUTABLE` (or `AGENT_BROWSER_EXECUTABLE`) points at a
missing, relative, or non-executable file. Remove the override to let the
runner provision the configured pin.

### Another run is using the checkout

`UAT_CHECKOUT_BUSY` names the process that holds
`~/.local/state/e2e-uat/fixed-checkout.lock`. Wait for it, then re-run. A lock
whose process is gone is removed automatically.

### The checkout is rejected

`UAT_CHECKOUT_INVALID` means the path is not the root of a standalone clone, is
a git worktree, or is inside the supervisor's ticket workspace.
`UAT_CHECKOUT_DIRTY` lists local changes. Both fixed checkouts (e2e and
agent-browser) are execution-only, so move changes to normal worktrees and
leave the fixed ones clean.

### The target is unknown

`UAT_TARGET_UNKNOWN` means the ref could not be resolved even after fetching
it. Use `--ref origin/<branch>` or a full commit SHA with `--commit`. The
runner also fetches a branch by name when the clone does not track it.

`UAT_APP_MISSING` means the target commit's tree does not contain the UAT
verification, the fixed runner, or `.github/native-candidate.json`. HEAD is
left where it was.

### The build or install fails

Run again with `--force-install` or `--force-build` after fixing the environment.
A pnpm major mismatch fails with `UAT_PNPM_UNSUPPORTED`; install the version in
the root `packageManager` pin. A Node version outside the supported range fails
with `UAT_NODE_UNSUPPORTED` before the checkout is touched.

## What the report records

The rendered report is written to
`~/.local/state/e2e-uat/reports/<timestamp>/report.md` and `report.json`. Both
paths share the same structure. The `identity` section records:

- `e2e.commit` and `dirty` from the fixed checkout the runner checked out.
- `@e2e-dev/web`'s package version and the native `agent-browser` source commit
  and sha256 from the binary that ran. The provisioned binary lives inside the
  pinned runner-owned checkout, so its commit is recorded.
- Per-step error codes, observation `phases`, and the native `code` / `effects`
  / `scopeState` table.
- On the model path, the model rounds, latency, and input/output/cache tokens.

Raw run output, trace pages, and failure screenshots stay in the fixed
checkout's gitignored `apps/uat-verification/.e2e/` or `.e2e-model/`. That is
private working data, not the report.
