# Flomo Safe Sync v0.3.6 验证记录

验证日期：2026-09-07

## 自动化检查

`npm run check` 通过：

- TypeScript 类型检查和生产构建通过。
- 同步核心测试通过。
- 受管区安全测试通过：38 个拒写场景、13 个兼容场景。
- 插件安全流程测试通过：18 项。
- v0.3.x 同步、迁移、删除、附件和缺失笔记恢复流程测试通过：65 项。

新增测试确认：

- 远端时间戳没有变化时，本地缺失文件仍会被报告，不再静默跳过。
- 用户明确选择后，缺失笔记按当前正确目录重新创建。
- 重新导入保留历史附件目录和图床地址映射。
- 旧文件仍存在、Vault 其他路径已存在相同 `flomo_slug` 笔记，或 memo 已退出当前同步范围时拒绝重新导入，不产生重复文件。

## Obsidian 隔离库

在独立测试库 `/private/tmp/flomo-safe-sync-qa-v030/vault` 使用 Obsidian 1.13.7 验证：

- “更新与安全”能检查并列出同步记录存在、Markdown 文件已经缺失的笔记。
- 缺失列表显示笔记名和原记录路径；只有勾选后，重新导入按钮才可执行。
- 水平标签页、标签范围与目录树、模板草稿、明暗主题和窄窗口布局回归正常。

原生文件接口回归覆盖正文更新、归档、重启后恢复、回收站及图床链接保留。

测试使用虚构 memo 和隔离 Vault，没有连接用户真实 Flomo 账号，也没有改动用户真实 Vault。重新导入的完整远端请求由模拟快照验证，仍需用户用真实账号确认 Flomo 当前接口兼容性。

## 安装包

`npm run package` 与 ZIP CRC 检查通过。`flomo-safe-sync-0.3.6.zip` 只包含：

- `flomo-safe-sync/main.js`
- `flomo-safe-sync/manifest.json`
- `flomo-safe-sync/styles.css`

安装包不含 `data.json`。GitHub Release 同时提供 BRAT 所需的三个独立运行文件、源码包、校验文件和本验证报告。

本地安装包 SHA-256：`02abdacb235a7e4cd6e93c497aff1aecbbac4be96e2c64d216454acab3f7b49d`。

GitHub 上传后会从公开 Release 地址重新下载全部资产并复核摘要。
