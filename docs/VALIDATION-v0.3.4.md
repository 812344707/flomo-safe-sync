# Flomo Safe Sync v0.3.4 验证记录

验证日期：2026-09-05

## 自动化检查

`npm run check` 通过：

- TypeScript 类型检查和生产构建通过。
- 新增核心级联测试覆盖父级选中、父级取消、中间子树取消、部分选择状态和手动标签选择。
- 受管区安全测试通过：38 个拒写场景、13 个兼容场景。
- 插件安全流程测试通过：18 项。
- v0.3.x 同步、迁移、删除和附件流程测试通过：62 项。

级联选择只展开当前已知标签树，并把每个完整标签明确写入设置，未将后端精确匹配改为模糊或前缀匹配。

## Obsidian 隔离库

在独立测试库 `/private/tmp/flomo-safe-sync-qa-v030/vault` 使用 Obsidian 1.13.7 验证：

- 点击 `#工作` 后，`#工作/项目` 与 `#工作/项目/甲` 同时选中并保存。
- 取消 `#工作/项目` 后，该标签及其子级同时取消，`#工作` 显示“部分选择”。
- 再次点击半选的 `#工作` 后，整个子树重新选中。
- 级联后的三个标签自动生成三行目录映射设置。
- 水平标签页、窄窗口布局、模板保存与重载回归正常。

原生文件接口回归通过：正文更新、归档、重启后恢复、回收站和图床链接保留流程正常。

测试只使用虚构 memo 和隔离 Vault，没有连接用户真实 Flomo 账号，也没有改动用户真实 Vault。

## 安装包

`npm run package` 与 ZIP CRC 检查通过。`flomo-safe-sync-0.3.4.zip` 只包含：

- `flomo-safe-sync/main.js`
- `flomo-safe-sync/manifest.json`
- `flomo-safe-sync/styles.css`

安装包不含 `data.json`。GitHub Release 同时提供 BRAT 所需的三个独立运行文件、源码包、校验文件和本验证报告。

本地安装包 SHA-256：`53a7fe824fd95cd771f76956afc56af2a849fe0a6974da9019abeb86de5e4971`。

GitHub 上传后将从公开 Release 地址重新下载全部资产并复核摘要。
