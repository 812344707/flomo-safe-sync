# Flomo Safe Sync v0.3.2

## 新增

- 自定义文件名支持日期格式占位符：`{{yyyy-MM-dd}}`、`{{yyyyMMdd-HHmmss}}`，以及由 `yyyy/yy`、`MM/M`、`dd/d`、`HH/H`、`mm/m`、`ss/s` 组成的文件名安全格式。
- 设置页的“YAML 模板”更名为“笔记模板”。编辑区直接显示首次导入使用的完整 Markdown 源码，可调整用户 YAML、标题、固定文字和正文结构。
- 完整笔记模板显示属性受管区、标签合并占位符、正文受管区和用户可编辑内容。右侧继续提供带颜色分区的首次导入结果预览。

## 安全与兼容

- 属性受管区的标记和必要字段必须保持完整；`{{flomo_tags}}` 与 `{{flomo_content}}` 必须各保留一个。无效草稿会显示具体错误，不会覆盖上次有效模板。
- 模板只影响之后首次导入的新笔记，不改写历史笔记。
- v0.3.1 的 YAML 字段模板会自动嵌入等效的完整笔记模板；原设置、同步历史和已有文件保持不变。
- 日期格式区分大小写：`MM` 表示月份，`mm` 表示分钟。

## 安装与更新

BRAT 可直接读取本 Release 的独立 `main.js`、`manifest.json`、`styles.css`。手工安装可下载 `flomo-safe-sync-0.3.2.zip`，解压后将 `flomo-safe-sync` 文件夹放入 Vault 的 `.obsidian/plugins/`。

升级时保留原有 `data.json`。本安装包不含用户设置或真实账号数据。
