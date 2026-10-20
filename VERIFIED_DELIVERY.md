# Verified agent-browser delivery / 已验证交付

Historical delivery evidence for `0.39.1-e2e.4`, not validation of the prepared `0.39.1-e2e.5` source-lock migration.

**Verified October 19, 2026 UTC / 北京时间 2026 年 10 月 20 日**

Tested runtime / 已测试代码：[`e1c7458d44a6ce0d7b7cb12bfdd727271898ae72`](https://github.com/levicode/e2e/tree/e1c7458d44a6ce0d7b7cb12bfdd727271898ae72). Git tree: `b8ffe49922ff2bae9615cc629067f250ab342ebf`.

This document is a later documentation-only update. Its own commit is not a new runtime test result. / 本文属于后续纯文档更新；其提交不代表重新构建或测试了运行时代码。

## Results / 验证结果

- **Linux x64:** [two complete runs of the exact commit](https://github.com/levicode/e2e/actions/runs/39324527722), each with 1,501 passing native tests, 333 passing units and a passing default unnamed-icon smoke; all 54 integration cases passed with zero skips; fresh installed consumer and native packaging pass. The 54 cases include real Chromium contracts, refusal checks and the encoder check. / 同一提交完整复跑两次，全部通过。
- **macOS 15 ARM64 and Intel:** [both jobs pass](https://github.com/levicode/e2e/actions/runs/39324527558); each has 1,499 native tests, 333 units, five locator/default-icon cases, two public runner/replay cases and a fresh installed consumer. / 两种原生架构均通过各自完整工作流。
- The 147 existing upstream ignored native tests are reported explicitly. No new skip or larger stack/operation timeout was used to obtain these results. / 保留并明确报告上游已有的 147 个 ignored 测试。
- **Mac coverage is the selected seven browser cases plus consumer, not the complete Linux matrix.** The full pixel/state/network/video matrix ran only on Linux. / Mac 验证范围不能推广为完整 Linux 矩阵已在 Mac 执行。
- **Private-application UAT and the user's actual desktop are still untested.** Synthetic fixtures do not establish real hosted-account access or model reasoning quality. / 私人应用 UAT、用户实际电脑和真实托管账号尚未验证。

The original unnamed, below-viewport font-icon case passes through the public observation/action/trace/replay path. The unchanged icon gets an observed ref, auto-scrolls and opens a visible synthetic tag list once. Both Linux runs also pass 12 decoded-PNG mask captures and a separate 12-round public state/masking/native-command regression. / 原始无名称、屏外图标场景通过公开观察与动作链路；无需给图标补业务名称或预先使用选择器绕过观察。

## Downloads / 下载

Use the native binary and package tarballs from the same tested commit. / 使用同一提交的 native 与 npm 压缩包。

- Linux: [core/adapter packages and consumer proof](https://github.com/levicode/e2e/actions/runs/39324527722/artifacts/12222124713), [native x64](https://github.com/levicode/e2e/actions/runs/39324527722/artifacts/12222448273).
- Apple silicon: [packages and consumer proof](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12222277507), [native ARM64](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12222073579).
- Intel Mac: [packages and consumer proof](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12223776234), [native x64](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12223508115).

GitHub artifacts expire after seven days. Durable compact attachments, when supplied, contain the same unchanged archives and independent checksum manifests: download the common package/example bundle plus your platform's native bundle. They are split to stay below the messaging file-size limit. / GitHub 产物保留七天；独立附件副本不依赖该期限。安装需要 common 包及对应平台的 native 包。

The full public source remains pinned at the commit above. / 完整源码始终可通过上述精确提交获取：

```sh
git clone https://github.com/levicode/e2e.git
cd e2e
git checkout e1c7458d44a6ce0d7b7cb12bfdd727271898ae72
```

All original consumer evidence hashes and all 50 adapter output files match the reviewed source build. Package tarballs are byte-identical across the three platforms. Native hashes:

- Linux x64: `a63fea23d556fef25d6b195369b8293ed5bc32482407aefb17f9806e50ad7bbe`.
- Mac ARM64: `c65ca0eaa5d8414eb238e70b7b75f9696c3e160c473fec7b3886adada043424c`.
- Mac x64: `d5c26351ccb4072e1da4bd9a2063381a8471b09b54a10c9fd60d4a9f655c8a00`.

Architecture, mode 0755, archive hashes, license/NOTICE and source/patch metadata were independently verified. / 架构、权限、哈希、许可与来源均已独立核验。

## Install and migrate / 安装与迁移

Follow [the full installation instructions](packages/agent-browser/INSTALL.md) or the bilingual `INSTALL.md` in the compact common attachment. Node 24.19.0 and pnpm 12.3.4 match CI. Chromium is a separate prerequisite; the tested version is Chrome for Testing 156.0.8078.4. The pinned Playwright package only downloads Chromium and is not this engine's execution path.

Install the two provided package tarballs, then select the new factory and typed fixture import. Keep the existing e2e runner/model/report configuration. / 安装两个压缩包并替换引擎工厂及 typed test 导入，保留原有 runner/model/report 配置。

```sh
pnpm add -D /absolute/path/e2e-0.21.2.tgz \
  /absolute/path/e2e-dev-agent-browser-0.0.0.tgz
```

```ts
import { agentBrowser } from '@e2e-dev/agent-browser';

const engine = agentBrowser({
  executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE,
  executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
  viewport: { width: 1280, height: 720 },
});
```

Tests import `test` from `@e2e-dev/agent-browser` and `expect` from `e2e`. The included [standalone consumer](packages/agent-browser/examples/packaged-consumer) runs without a model key or private account and asserts one real mutation plus report/trace output. / 随附独立示例无需模型密钥或私人账号。

The native version must be `0.39.1-e2e.4`; stock/older binaries fail preflight. Mac binaries are not Apple-notarized, and this build supplies no Developer ID signing. Do not bypass OS security warnings; use the reviewed-source build if necessary. Retain Chromium's sandbox on ordinary desktops. / Mac 二进制未经过 Apple 公证；不要绕过系统安全警告。普通桌面运行保留 Chromium 沙箱。

## Scope and maintenance / 范围与维护

- Chromium only, with dedicated whole-browser attempts. Shared/worker endpoints are refused before provisioning or connection. Provider preparation/recording clients must retain no competing locale/timezone overrides.
- Fill uses an exact-node setter with synthetic input events; trusted keyboard typing is a separate contract. Supported structured-clone IndexedDB values are preserved, but partitioned third-party storage, unsupported host objects and historical sessionStorage are not approximated.
- Screenshot proof failures withhold all pixels. Artifact video is unredacted and never sent as model pixels. Remote downloads require a provider transfer hook.
- Ambiguous input is nonretryable and poisons the attempt. No hidden Playwright fallback or automatic input replay/reconnect is used.
- Original Web/mobile packages remain available; the adapter uses public SPI 1. Cache identity is `agent-browser-exact-5`; changing only package version would not invalidate old core replay entries.

See [compatibility](packages/agent-browser/ADAPTER_COMPATIBILITY.md), [detailed validation](packages/agent-browser/VALIDATION.md) and [upstream maintenance](packages/agent-browser/UPSTREAM_SYNC.md). e2e remains based on `97f453fbcfd99b73faa0177ba60e489df9625b86`; agent-browser remains pinned to `1165952d74ceed98fdc2dd97190ad41f44dd0e24`. Native patch SHA-256: `77e28ffda52b7dcf6cd27d7b8b3599c625959b39fc1f301609c02077200671fd`.

Historical status files inside already-built package/source archives are intentionally preserved byte-for-byte. This dated final evidence supersedes their earlier pending-checkpoint statements for the tested commit; it does not change those archives. / 已构建压缩包中的历史状态文件保持原样；本文的最终证据更新了其中的待验证状态，并未改写归档。

No npm publication, GitHub Release, deployment or main-branch merge has been performed. / 未发布 npm/GitHub Release，未部署或合并 main。
