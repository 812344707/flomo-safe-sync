# Flomo Safe Sync v0.3.3

## 日期和时间占位符

- 新安装的默认文件名改为 `{{yyyy-MM-dd}}_{{HH-mm-ss}}_{{title:20}}_{{slug:8}}`。
- 推荐格式采用 Unicode 风格日期字段的文件名安全子集：`yyyy/yy` 年、`MM/M` 月、`dd/d` 日、`HH/H` 24 小时、`mm/m` 分、`ss/s` 秒。
- 设置页优先展示 `{{yyyy-MM-dd}}`、`{{yyyy-MM-dd_HH-mm-ss}}` 和 `{{yyyyMMdd-HHmmss}}`，并提供 Unicode 日期字段规范链接。
- 大小写含义明确：`MM` 是月份，`mm` 是分钟；新模板使用小写 `yyyy` 和 `dd`，避免大写 `YYYY`、`DD` 在通用日期规范中的不同语义。

## 兼容和迁移

- `{{date}}`、`{{time}}`、`{{year}}`、`{{month}}`、`{{day}}`、`{{hour}}`、`{{minute}}`、`{{second}}` 与完整旧变量 `{{YYYY-MM-DD-HHmmss}}` 继续渲染。
- 从 v0.3.2 或更早版本升级时，已保存的默认模板、自定义模板、同步历史和其他设置保持原样。
- 旧默认模板会显示为兼容格式；只有用户点击“采用推荐默认格式”并保存后，后续新导入笔记才使用新格式。
- 本次更新不重命名历史文件。

## 安装与更新

BRAT 可直接读取本 Release 的独立 `main.js`、`manifest.json`、`styles.css`。手工安装可下载 `flomo-safe-sync-0.3.3.zip`，解压后将 `flomo-safe-sync` 文件夹放入 Vault 的 `.obsidian/plugins/`。

升级时保留原有 `data.json`。本安装包不含用户设置或真实账号数据。
