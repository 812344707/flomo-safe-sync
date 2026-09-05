# Flomo Safe Sync v0.3.3 验证记录

验证日期：2026-09-05

## 自动化检查

`npm run check` 通过：

- TypeScript 类型检查和生产构建通过。
- 基础同步核心测试通过；推荐格式 `{{yyyy-MM-dd_HH-mm-ss}}` 与旧格式均能正确渲染。
- 非兼容的大写 `{{YYYY-MM-DD}}` 会给出改用 `yyyy`、`dd` 的具体提示；完整旧变量 `{{YYYY-MM-DD-HHmmss}}` 继续兼容。
- 受管区安全测试通过：38 个拒写场景、13 个兼容场景。
- 插件安全流程测试通过：18 项。
- v0.3.x 同步、迁移、删除和附件流程测试通过：62 项。

设置迁移测试确认：新安装使用推荐默认格式；v5 设置中的旧默认模板、自定义模板和同步记录原样保留，迁移后可重复加载。

## Obsidian 隔离库

在独立测试库 `/private/tmp/flomo-safe-sync-qa-v030/vault` 使用 Obsidian 1.13.7 验证：

- 插件清单和设置页显示 v0.3.3。
- 五个水平标签页、键盘切换、草稿保留、保存及插件重载正常。
- 升级前的自定义模板保持不变；切换默认模式后可主动采用推荐格式，已保存的自定义模板仍保留。
- 推荐默认格式预览生成 `2026-09-01_08-09-10_第一条写作想法_abcdef12.md`。
- 非法模板不会覆盖上次有效配置。
- 明暗主题完成截图检查；560 像素窄窗口为上下布局，标签栏可横向滚动且页面无横向溢出。

原生文件接口回归通过：正文更新、归档、重启后恢复、回收站和图床链接保留流程正常。

测试只使用虚构 memo 和隔离 Vault，没有连接用户真实 Flomo 账号，也没有改动用户真实 Vault。

## 安装包

`npm run package` 与 ZIP CRC 检查通过。`flomo-safe-sync-0.3.3.zip` 只包含：

- `flomo-safe-sync/main.js`
- `flomo-safe-sync/manifest.json`
- `flomo-safe-sync/styles.css`

安装包不含 `data.json`。GitHub Release 同时提供 BRAT 所需的三个独立运行文件、源码包、校验文件和本验证报告。

本地安装包 SHA-256：`3321753dbdd3fa46faa0e1bf25b58220793f1dff80afa33ad10f1015ed02bf25`。

GitHub 上传后将从公开 Release 地址重新下载全部资产并复核摘要。
