# Flomo Safe Sync

一个强调“本地内容不丢失”的 Flomo → Obsidian 桌面插件，基于
[Watermelon4000/flomo-obsidian-sync](https://github.com/Watermelon4000/flomo-obsidian-sync)
修改。

## 与原版相比

- 只更新明确标记的 Flomo 受管区，保留受管区之外的手工内容。
- Flomo 删除 memo 后，Obsidian 文件和附件继续保留，仅标记
  `flomo_status: deleted`。
- 默认保存根目录可自定义。
- 文件名模板可自定义，支持单变量 `{{YYYY-MM-DD-HHmmss}}`。
- 可为新笔记设置额外的 YAML 字段模板。
- Flomo 标签与 Obsidian 手工标签统一合并到标准 `tags` 字段。
- 登录后可读取 Flomo 标签，并通过快捷选择设置“Flomo 标签 → Vault 文件夹”的有序映射。
- 只有已设置文件夹映射的标签参与同步；未映射 memo 不导入、不更新。
- 可按完整 Flomo 标签排除更新，并选择“首次导入后冻结”或“完全跳过”。
- 可把 Flomo 图片下载到 Vault 内，远程下载失败时保留原链接。
- 路径冲突时自动追加短 slug，不覆盖已有文件。

## 受管区

新笔记大致如下：

```markdown
---
# flomo-sync:frontmatter:start
flomo_slug: "abcdef123456"
flomo_status: active
flomo_sync_policy: managed
flomo_created_at: "2026-09-01 08:09:10"
flomo_updated_at: "2026-09-01 08:09:10"
flomo_last_synced_at: "2026-09-01T08:10:00.000Z"
# flomo-sync:frontmatter:end
tags:
  - "写作"
  - "重点"
source: flomo
note_type: memo
---

<!-- flomo-sync:content:start -->
这里由 Flomo 更新。
<!-- flomo-sync:content:end -->

## 我的补充

这里可以长期添加批注、双链和加工内容，插件不会改写。
```

如果受管区标记缺失或损坏，插件会停止覆盖该文件并报告冲突。

`tags` 是唯一的标签属性。插件会记录上次真正写入笔记的 Flomo 标签，更新其中的
Flomo 部分，同时保留你在 Obsidian 中手工添加的标签。旧版笔记中的 `flomo_tags`
会在下次受管更新时自动并入 `tags`。

## 保存位置和文件名

默认根目录必须是 Vault 内相对路径，例如：

```text
00-Flomo收件箱
```

设置输入框会列出当前 Vault 的文件夹，并可通过输入关键词快速筛选。默认根目录用作
新增标签映射的初始目标和附件保存根目录；memo 正文只会写入明确配置的标签映射目录。

文件名模板支持：

- `{{YYYY-MM-DD-HHmmss}}`：紧凑日期时间，例如 `2026-09-01-080910`
- `{{date}}`：创建日期，例如 `2026-09-01`
- `{{time}}`：创建时间，例如 `08-09-10`
- `{{title}}`、`{{title:20}}`：正文首行或限定长度
- `{{slug}}`、`{{slug:8}}`：Flomo slug 或限定长度
- `{{first_tag}}`：第一个 Flomo 标签

默认模板：

```text
{{date}}_{{time}}_{{title:20}}_{{slug:8}}
```

设置变化只影响新导入的 memo，不会静默移动或重命名已有笔记。

## YAML 字段模板

设置页可为首次导入的新笔记填写额外 YAML 字段，每行一个顶层字段：

```yaml
source: flomo
note_type: memo
created: "{{date}}"
aliases: []
```

模板支持与文件名相同的 `{{YYYY-MM-DD-HHmmss}}`、`{{date}}`、`{{time}}`、
`{{title}}`、`{{slug}}`、`{{first_tag}}` 变量。模板只用于首次创建，不会批量改写现有笔记；`tags` 和
所有 `flomo_` 字段由插件维护，不能在模板中重复定义。

## 标签 → 文件夹

登录 Flomo 后，设置页会读取当前 memo 中出现过的标签。标签和 Vault 文件夹输入框
都支持输入关键词快速筛选，也允许直接输入。每条映射形如：

```text
写作 = 20-写作素材
医学/论文 = 30-医学研究
```

规则：

1. 只有命中至少一条映射的 memo 才参与同步。
2. 未命中任何映射的 memo 不导入、不更新；已经存在的 Obsidian 文件原地保留。
3. 多标签 memo 命中多个文件夹映射时，列表中最靠前的一条优先。
4. 命中文件夹映射后只保存一份，不再复制到其他标签目录。
5. 映射按完整标签名精确匹配；排除更新规则只在已映射的同步范围内生效。

## 排除更新

- `首次导入后冻结`：第一次创建 Obsidian 笔记，以后不再更新受管区。
- `完全不导入，也不更新`：新 memo 不创建文件；已经存在的文件原地保留。
- 多标签 memo 命中任意一个排除标签，即进入排除规则。
- 排除标签从 Flomo memo 上移除后，下次同步恢复受管区更新。

## 安装

### 构建

```bash
npm install
npm run check
npm run package
```

构建后的安装目录位于 `dist/flomo-safe-sync`，同时会生成与当前版本一致的压缩包，例如 `dist/flomo-safe-sync-0.2.0.zip`。将整个目录复制到 Vault：

```text
<Vault>/.obsidian/plugins/flomo-safe-sync/
├── main.js
├── manifest.json
└── styles.css
```

重新加载 Obsidian 后，在“设置 → 第三方插件”中启用 **Flomo Safe Sync**。

## 注意事项

- 插件使用 Flomo 网页端内部 API，不是 Flomo 官方集成；接口变化可能导致同步失效。
- 自动登录依赖 Electron，因此插件仅支持 Obsidian 桌面版。
- Flomo 登录令牌保存在本地 Obsidian 插件数据中，不会由本插件上传到其他服务。
- 第一次用于真实 Vault 前，建议先使用测试 Vault 验证目录、命名和标签规则。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

## 许可与致谢

本项目保留上游 MIT License。感谢原作者 Zihong Chen 提供登录、API 请求、增量记录和
HTML → Markdown 的基础实现。
