# Run from a verified source checkout

This is a source-build entry, not a prebuilt/offline archive download. It builds the current committed JavaScript checkout and the pinned native source `40655423deae8a4d0227068fbbd11e882f484bc0`. No runtime from a previous CI run is reused.

Prerequisites: a clean checkout, a writable HOME owned by the current user, Git, Node **24.22.1**, pnpm **12.3.4**, and Rust/cargo with the host platform toolchain. Supported source setup hosts are Linux/macOS, x64/ARM64. Building and public Chromium installation require network access; Linux Chromium system dependencies may require the normal installer privileges. Choose canonical absolute paths whose parents already exist. Both new directories must not exist, must be outside the checkout, and must be separate.

```sh
node scripts/setup-source-native.mjs /absolute/new-build-work /absolute/new-test-project
cd /absolute/new-test-project
pnpm exec e2e --help
```

The entry runs frozen-lockfile dependency installation, the original public package build, a fresh locked production native build, the original live capability/scope/cleanup probe, and the existing public package/runtime installer. An internally generated fresh bundle is only a transfer format between these existing interfaces; it is not the user deliverable or an older accepted artifact. The installed project uses its verified runtime descriptor. Only the source bootstrap uses an explicit absolute path to the just-built executable; installed commands do not rely on that override.

The public `pnpm exec e2e-web install chromium` and `pnpm exec e2e --help` run explicitly in the actual new user project, with both streams and exit codes retained. CI supplies its own fresh writable HOME; a sandbox running this entry must likewise provide a writable HOME, not restore inherited socket overrides. No runtime or browser is silently installed by test startup. The new project declares the documented SDK peer `ai@7.0.153`. Keep the build work directory for provenance and compiler/command logs. The entry never overwrites an existing project, runtime descriptor, or work directory.

CI invokes exactly this entry on Linux and Mac, then runs the unchanged deterministic core: fill, page and object PNG, independent object geometry/color oracle, compact and raw native reference taps, repeat without updating snapshots, and the six synthetic secret-boundary controls. Evidence records actual source/native identities, command exits and both streams. These checks do not exercise a live LLM and do not certify recovery/concurrency/full product acceptance. Existing ordinary PR/main gates remain independent and unchanged; source setup success alone is not merge approval.
