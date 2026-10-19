# Fresh packaged consumer

This example imports only `e2e`, `e2e/runner`, and `@e2e-dev/agent-browser`. It has no workspace-relative imports. A deterministic executor observes a real button, taps its observed node ID, and checks the resulting UI and server-side commit. No model or API key is needed.

The adapter is a development candidate, not a published npm release. Build it and the runner before packing, then run the validation script from the repository root:

```sh
pnpm --filter e2e build
pnpm --filter @e2e-dev/agent-browser build
node packages/agent-browser/scripts/consumer-smoke.ts --artifacts /tmp/consumer-import-artifacts
```

The script packs both packages, installs the tarballs in a fresh directory outside the workspace, repeats installation with the frozen lockfile, checks public import resolution and TypeScript declarations, then runs `e2e list`. This default mode never launches a browser. Use `--offline --store-dir /path/to/pnpm/store --cache-dir /path/to/pnpm/cache` when package contents and registry metadata are already cached. Add `--keep` to inspect the installed project afterward.

## Run the real browser smoke

Use the reviewed native `agent-browser 0.39.1-e2e.3` build and a Chromium executable. Stock agent-browser is rejected. The native binary and Chromium are separate prerequisites, not bundled inside the adapter tarball.

```sh
export E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/reviewed/agent-browser
export E2E_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium
node packages/agent-browser/scripts/consumer-smoke.ts --browser --artifacts /tmp/consumer-browser-artifacts
```

The browser mode starts its own local fixture server, runs the installed package, and verifies one server-side commit, a passed `agent.act` step, zero model calls, and a closed trace. The artifact directory contains package tarballs, install and command logs, import-resolution evidence, the selected test list, the report, and `trace.md`. `manifest.json` records the exact CI commit, Node and pnpm versions, each check's outcome, and every saved file's size and SHA-256 hash. It is written on failure too. The directory must be new or empty. The script does not publish or upload anything.

The `agent-browser adapter` GitHub Actions workflow runs browser mode after the adapter build, even if an independent acceptance test failed, then uploads this synthetic evidence as `agent-browser-packaged-consumer-<commit>`. The workflow has only `contents: read`; it receives no model keys and has no publish or deployment step. The artifact excludes browser profiles, runner session files, and `node_modules`.

Only set `E2E_CHROMIUM_NO_SANDBOX=1` in an already-isolated CI environment that requires it. Normal runs keep Chromium's sandbox enabled.

## Use the example as a project

Copy this directory outside the repository and install your two local tarballs plus the type tools:

```sh
pnpm add -D /absolute/path/to/e2e-0.21.2.tgz /absolute/path/to/e2e-dev-agent-browser-0.0.0.tgz typescript@7.0.2 @types/node@26.6.2
pnpm check
pnpm run list
pnpm smoke
```

`e2e.config.ts` is the complete configuration. `tests/consumer.e2e.ts` shows the typed browser fixture and an agent action driven by the deterministic executor. `run-smoke.ts` starts the synthetic app and checks the report. For an existing app, set `CONSUMER_FIXTURE_URL`, replace the fixture-specific executor and test, then use `pnpm exec e2e run`.
