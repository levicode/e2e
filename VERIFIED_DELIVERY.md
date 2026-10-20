# Maintained agent-browser delivery / 维护版交付

The current supported native line is `0.39.1-e2e.5`, contract `e2e-exact-1`, engine/cache identity `agent-browser-exact-6`. The stable native commit is [`a4cd9f8c728d590e6d5c3c5546f961874aa715be`](https://github.com/levicode/agent-browser/commit/a4cd9f8c728d590e6d5c3c5546f961874aa715be), with reviewed tree `4f52f3e35fc26bee9f2a9ad29e75467e9c9907f8`.

Use [the installation guide](packages/agent-browser/INSTALL.md) and [current validation evidence and boundaries](packages/agent-browser/VALIDATION.md). Install native and core/adapter packages from the same successful final integration workflow commit. Check the exact source lock and artifact hashes; do not substitute an old `.4` package or a failed run's outputs.

当前只有一套维护实现，不保留旧补丁安装路径或永久双模式。旧 `.4` 交付记录仅保存在 Git 历史中，不能作为当前版本的安装依据。Linux 与两种 Mac 架构分别验证，Mac 验证范围不等于完整 Linux 矩阵；私人应用 UAT、用户实际电脑及真实托管账号仍未验证。

The official-baseline comparison uses independent executables, not a second distributed runtime. Known ordinary unscoped external-CDP limitations on macOS remain explicit in [the compatibility inventory](packages/agent-browser/ADAPTER_COMPATIBILITY.md). This migration does not claim those limitations are fixed.

No npm publication, Apple notarization or Developer ID signing is supplied. Do not bypass OS security warnings; build the reviewed source when necessary. Keep Chromium's sandbox on ordinary desktops.
