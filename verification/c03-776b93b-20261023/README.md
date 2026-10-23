# C03 directed browser verification

The original public callback contracts passed 14/14: six callback cases and eight native primitive cases. C03 read the live page from a route callback while its parent evaluate awaited fetch. The original stage 3 locator textContent assertion and stage 4 arbitrary JavaScript evaluate assertion passed with the unchanged 8,000 ms budget.

The verified sources are e2e `b3a23a07c3f9068e7c0b122873b94f28cbb2e40b` and agent-browser `776b93b23902ceb1b38e965d1207f111d85fdd0d`. Both working trees and original test sources were unchanged during execution. `source.json` records their identities and file hashes, including the unchanged P27 and metadata files.

The production binary SHA-256 is `34259ec5aace51e3fd2a4d4fcb721a96e5af73a904e25fa28e0b98b2cb8c5325`. It was built once using `cargo build --locked --profile ci --no-default-features --message-format=json`, with two jobs. `production-compiler.jsonl` is the original compiler stream. `build.json` binds its executable, profile, empty feature set and compiler version to the copied binary. Core and Web dist were built from the exact e2e source.

The unchanged `scripts/acceptance/probe-native.ts` negotiated all 17 required capabilities through built Web, exercised the owned scope and confirmed page read/write and closure. `negotiation.json` records that result. `tests.json` contains the original 14 case names, compact results, execution arguments and raw report digests. `c03.jsonl` is the original fixture's source-bound C03 record.

Chromium was Debian `154.0.8037.57`. Its ELF SHA-256 is `4dc9f9f9b20e9bd95bf201f43d2d643f48938f36a70ddcb6fce3dd611a178180`. `chromium-main-processes.json` preserves the observed main-process argv for the probe and both test files. All three contain `--no-sandbox`; this does not establish sandbox-enabled behavior. The outer process used `CI=1`; the unchanged fixture helper supplied `CI=''`. The native launcher tests CI variable existence when choosing that flag.

Execution used only loopback synthetic pages and the fixture's synthetic cookie. The SUID helper and OS security configuration were unchanged. Executable and disabled telemetry/update variables are recorded in `result.json`. An explicit fresh `/tmp/c03s-*` socket directory was needed because the default home transport directory was read-only. This was an environment-only correction, with no source change.

The two original files ran separately with one Vitest worker. Their synthetic suite aggregates remain unknown because each lacks the other file's records. C03 is individually complete in the callback capture; C01 and C02 are individually complete in the primitives capture. These results do not constitute a complete candidate receipt. All 75 observed Chromium processes had exited at the final check.

No previously passed Rust tests, compilation boundaries or full clippy gate were rerun. Official Chromium 156 and complete new-source validation remain for CI and the integration owner. This result is not a 306-test acceptance claim or a release approval.
