# Install the source-pinned candidate

This is a fork build, not an npm release. Use the native binary and the two package tarballs from **the same successful commit**. The package version remains private `0.0.0`; the exact source commit and artifact hashes distinguish candidates. The native version is `0.39.1-e2e.4`, and the engine/cache identity is `agent-browser-exact-5`.

## Download the matching artifacts

Open a successful run of [the Linux workflow](https://github.com/levicode/e2e/actions/workflows/agent-browser-adapter.yml) or [the macOS workflow](https://github.com/levicode/e2e/actions/workflows/agent-browser-macos.yml). Check its commit and every required job before downloading:

- `agent-browser-packaged-consumer-<commit>` on Linux, or `agent-browser-packaged-consumer-darwin-<architecture>-<commit>` on macOS: contains `tarballs/e2e-0.21.2.tgz`, `tarballs/e2e-dev-agent-browser-0.0.0.tgz`, and hashed execution evidence.
- `agent-browser-native-<platform>-<architecture>-<commit>`: contains the patched executable in a mode-preserving `.tar.gz`, `SHA256SUMS`, and `manifest.json` with the executable hash, source/patch pins, architecture, compiler and tested Chromium version.

Platform names are `linux-x64`, `darwin-arm64` (Apple silicon), and `darwin-x64` (Intel). Never use a Linux executable on macOS or assume that one Mac architecture proves the other. `uname -m` prints `arm64` or `x86_64` on a Mac. Artifacts expire after seven days; the pinned source and build script remain the reproducible fallback. A missing or failed native artifact is not a tested binary.

Linux runs the complete required integration matrix. Each Mac architecture runs native tests, all units, seven locator/runner cases and the fresh-consumer browser smoke; pixel/state/network/video parity on macOS requires further platform-specific validation.

The workflow OS targets are Ubuntu 24.04 and macOS 15. The manifest records the actual OS release and, on Linux, the glibc version. Compatibility with older operating systems, other Linux distributions, and Windows is not established by these artifacts.

After extracting the GitHub artifact ZIP, verify and unpack its archive:

```sh
# Run in the extracted native artifact directory.
shasum -a 256 -c SHA256SUMS
tar -xzf agent-browser-0.39.1-e2e.4-darwin-arm64.tar.gz
./agent-browser --version
export E2E_AGENT_BROWSER_EXECUTABLE="$PWD/agent-browser"
```

Replace the archive suffix with your recorded platform. The tar archive preserves executable permissions. This candidate is not Apple-notarized; do not bypass an operating-system security warning. Build the reviewed source locally if your system does not permit the downloaded executable.

## Install the packages in a project

Use Node 24.19.0 and pnpm 12.3.4 to match CI. Node 24.8+ is the declared minimum, but other versions have not all been exercised.

```sh
pnpm add -D /absolute/path/to/tarballs/e2e-0.21.2.tgz \
  /absolute/path/to/tarballs/e2e-dev-agent-browser-0.0.0.tgz
```

Chromium is a separate prerequisite. For an exact repeat of the pinned browser download, use the source checkout below and run:

```sh
pnpm --filter @e2e-dev/web exec playwright-core install --no-shell chromium
```

This uses the pinned `playwright-core@1.64.0` only as a downloader; the adapter does not execute Playwright. Set `E2E_CHROMIUM_EXECUTABLE` to that downloaded Chromium executable. On macOS it is inside `Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`; quote paths containing spaces. On Linux the workflow records the `chrome-linux*/chrome` executable. The native artifact manifest records the browser version actually tested. An independently installed Chrome version requires its own compatibility check.

Change the engine factory and typed fixture import; keep the existing runner/model/report configuration:

```ts
import { agentBrowser } from '@e2e-dev/agent-browser';

const engine = agentBrowser({
  executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE,
  executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
  viewport: { width: 1280, height: 720 },
});
```

Tests import `test` from `@e2e-dev/agent-browser` and `expect` from `e2e`. Do not remove Chromium's sandbox for an ordinary desktop run. The CI-only `E2E_CHROMIUM_NO_SANDBOX` switch belongs only in an already isolated Linux runner that requires it.

## Run the complete standalone smoke

Copy `packages/agent-browser/examples/packaged-consumer` from the same source commit into a fresh directory. It contains a complete config, synthetic HTTP app, deterministic executor and test; no model key or private account is needed.

```sh
pnpm add -D /absolute/path/to/tarballs/e2e-0.21.2.tgz \
  /absolute/path/to/tarballs/e2e-dev-agent-browser-0.0.0.tgz \
  typescript@7.0.2 @types/node@26.6.2
pnpm check
pnpm run list
pnpm smoke
```

Both executable environment variables must be set. Success proves a real observed action, exactly one external fixture mutation, public report/trace output and zero model calls. It does not prove access to the user's private application.

## Build instead of downloading a native artifact

Choose the exact reviewed commit shown in the successful workflow:

```sh
git clone https://github.com/levicode/e2e.git
cd e2e
git checkout <reviewed-commit>
pnpm install --frozen-lockfile --ignore-scripts
rustup toolchain install 1.93.0 --profile minimal
rustup default 1.93.0
bash packages/agent-browser/scripts/build-exact-agent-browser.sh
export E2E_AGENT_BROWSER_EXECUTABLE="$PWD/.validation-tools/agent-browser-exact/cli/target/ci/agent-browser"
pnpm --filter e2e build
pnpm --filter @e2e-dev/agent-browser build
```

The script fetches the exact public upstream commit, applies the maintained patch, runs native tests, builds the CLI and checks its version. It never patches a global installation. Build tools and network access to the official GitHub/Cargo/package sources are required. To reproduce the fresh-consumer proof after selecting Chromium:

```sh
node packages/agent-browser/scripts/consumer-smoke.ts --browser --artifacts /tmp/agent-browser-proof
```

Read `ADAPTER_COMPATIBILITY.md` for dedicated-provider ownership, Chromium-only scope, emulation conflicts, storage exclusions and artifact video privacy. Private-application UAT remains a separate acceptance step.
