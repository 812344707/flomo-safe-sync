import { App, Notice, Platform, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type FlomoSafeSyncPlugin from './main';
import { DEFAULT_FILE_NAME, DeletionAction, FileState } from './settings';
import { FlomoMemo, UpdateMode, computeDesiredPaths, normalizeTag, normalizeTagList, normalizeVaultPath,
  renderFileName, renderYamlTemplate, validateFileNameTemplate, validateVaultRelativePath, validateYamlTemplate } from './sync-core';

export const SAMPLE_MEMO: FlomoMemo = { slug: 'abcdef123456', content: '<p>第一条写作想法</p>',
  tags: [{ name: '写作' }, { name: '素材' }], created_at: '2026-09-01 08:09:10', updated_at: '2026-09-01 08:09:10' };
const TABS = [['connection', '连接与同步'], ['naming', '保存与命名'], ['scope', '同步范围'], ['yaml', 'YAML 模板'], ['safety', '更新与安全']] as const;
const VARIABLES = [
  ['{{date}}', '创建日期 · 2026-09-01'], ['{{time}}', '创建时间 · 08-09-10'], ['{{YYYY-MM-DD-HHmmss}}', '紧凑日期时间 · 2026-09-01-080910'],
  ['{{title:20}}', '正文首行，最多 20 字；可编辑长度或使用 {{title}}'], ['{{slug:8}}', 'memo 编号前 8 位；可编辑长度或使用 {{slug}}'], ['{{first_tag}}', '第一个标签；无标签时为 untagged'],
];

export class FlomoSafeSyncSettingTab extends PluginSettingTab {
  activeTab: string = 'connection';
  draftFileMode: 'default' | 'custom';
  draftFileTemplate: string;
  draftYaml: string;
  private busy = false;
  private suggestionId = 0;
  private selectedTrash = new Set<string>();
  private draftTag = '';
  private draftFolder = '';

  constructor(app: App, public plugin: FlomoSafeSyncPlugin, private login: () => Promise<string | null>) {
    super(app, plugin);
    this.resetFileDraft();
    this.draftYaml = plugin.settings.yamlTemplate;
  }
  private resetFileDraft(): void {
    this.draftFileMode = this.plugin.settings.fileNameMode;
    this.draftFileTemplate = this.plugin.settings.customFileNameTemplate;
  }
  private async action(work: () => Promise<unknown>): Promise<void> {
    this.busy = true; this.display();
    try { await work(); } catch (error) { new Notice((error as Error).message); }
    finally { this.busy = false; this.display(); }
  }
  private persist(): Promise<void> {
    return this.plugin.saveSettings().catch(error => { new Notice(`设置保存失败：${error.message}`); throw error; });
  }
  private folders(): string[] {
    return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !!file.path).map(file => file.path).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  private suggestions(parent: HTMLElement, input: HTMLInputElement, values: string[]): void {
    const id = `flomo-suggestion-${this.suggestionId++}`;
    input.setAttribute('list', id);
    const list = parent.createEl('datalist', { attr: { id } });
    for (const value of [...new Set(values)]) list.createEl('option', { attr: { value } });
  }
  private pathSetting(parent: HTMLElement, name: string, key: 'rootFolder' | 'imageFolder' | 'archiveFolder', description: string): void {
    const setting = new Setting(parent).setName(name).setDesc(description);
    setting.addText(text => {
      text.inputEl.addClass('flomo-wide'); text.inputEl.setAttribute('aria-label', name);
      this.suggestions(setting.settingEl, text.inputEl, this.folders());
      text.setValue(this.plugin.settings[key]).onChange(async value => {
        const error = validateVaultRelativePath(value);
        if (error) { setting.setDesc(`未保存：${error}`); return; }
        this.plugin.settings[key] = normalizeVaultPath(value);
        await this.persist(); setting.setDesc(`已保存。${description}`);
      });
    });
  }
  private variables(parent: HTMLElement, insert: (value: string) => void): void {
    const toolbar = parent.createDiv({ cls: 'flomo-variable-toolbar' });
    for (const [token, description] of VARIABLES) {
      const button = toolbar.createEl('button', { text: token, attr: { type: 'button', title: description } });
      button.addEventListener('click', () => insert(token));
    }
    const details = parent.createEl('details', { cls: 'flomo-variable-reference' });
    details.createEl('summary', { text: '变量参考' });
    for (const [token, description] of VARIABLES) details.createEl('p', { text: `${token} — ${description}` });
    details.createEl('a', { text: '打开在线变量参考 ↗', href: 'https://github.com/812344707/flomo-safe-sync#保存位置和文件名', attr: { target: '_blank', rel: 'noopener noreferrer' } });
  }
  private insert(input: HTMLInputElement | HTMLTextAreaElement, token: string, update: (value: string) => void): void {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + token + input.value.slice(end);
    input.focus(); input.setSelectionRange(start + token.length, start + token.length);
    update(input.value);
  }
  display(): void {
    const root = this.containerEl;
    root.empty(); root.addClass('flomo-safe-sync-settings');
    const header = root.createDiv({ cls: 'flomo-settings-header' });
    const info = header.createDiv();
    info.createEl('h2', { text: 'Flomo Safe Sync' });
    info.createEl('p', { cls: 'flomo-muted', text: `${this.plugin.settings.bearerToken ? '已连接 Flomo' : '尚未连接'} · ${this.plugin.settings.lastSyncTime ? `上次同步 ${new Date(this.plugin.settings.lastSyncTime).toLocaleString()}` : '尚未同步'} · v0.3.0` });
    const sync = header.createEl('button', { text: this.plugin.syncRunning ? '同步中…' : '立即同步', cls: 'mod-cta' });
    sync.disabled = this.busy || this.plugin.syncRunning;
    sync.addEventListener('click', () => { void this.action(() => this.plugin.runSync()); });
    const navigation = root.createDiv({ cls: 'flomo-tabs', attr: { role: 'tablist', 'aria-label': 'Flomo 插件设置' } });
    for (const [id, title] of TABS) {
      const button = navigation.createEl('button', { text: title, cls: this.activeTab === id ? 'is-active' : '',
        attr: { id: `flomo-tab-${id}`, role: 'tab', 'aria-selected': String(this.activeTab === id), 'aria-controls': `flomo-panel-${id}`, tabindex: this.activeTab === id ? '0' : '-1' } });
      button.addEventListener('click', () => { this.activeTab = id; this.display(); this.containerEl.querySelector<HTMLButtonElement>(`#flomo-tab-${id}`)?.focus(); });
      button.addEventListener('keydown', event => {
        const index = TABS.findIndex(([key]) => key === this.activeTab);
        const target = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
        if (target >= 0) { event.preventDefault(); this.activeTab = TABS[target][0]; this.display(); this.containerEl.querySelector<HTMLButtonElement>(`#flomo-tab-${this.activeTab}`)?.focus(); }
      });
    }
    const panel = root.createEl('fieldset', { cls: 'flomo-panel', attr: { id: `flomo-panel-${this.activeTab}`, role: 'tabpanel', 'aria-labelledby': `flomo-tab-${this.activeTab}` } });
    panel.disabled = this.busy || this.plugin.syncRunning;
    if (this.activeTab === 'connection') this.connection(panel);
    if (this.activeTab === 'naming') this.naming(panel);
    if (this.activeTab === 'scope') this.scope(panel);
    if (this.activeTab === 'yaml') this.yaml(panel);
    if (this.activeTab === 'safety') this.safety(panel);
  }
  private connection(parent: HTMLElement): void {
    parent.createEl('h3', { text: '连接与同步' });
    if (Platform.isDesktop) new Setting(parent).setName('Flomo 账号').setDesc('登录信息保存在本地插件数据中。').addButton(button => button.setButtonText(this.plugin.settings.bearerToken ? '重新登录' : '登录 Flomo').onClick(() => this.action(async () => {
      const token = await this.login();
      if (!token) return;
      this.plugin.settings.bearerToken = token;
      await this.persist(); this.plugin.startIntervalSync();
      await this.plugin.refreshAvailableFlomoTags();
    })));
    new Setting(parent).setName('启动时同步').addToggle(toggle => toggle.setValue(this.plugin.settings.autoSyncOnStartup).onChange(async value => { this.plugin.settings.autoSyncOnStartup = value; await this.persist(); }));
    const interval = new Setting(parent).setName('同步间隔（分钟）').setDesc('0 为关闭定时同步。');
    interval.addText(text => text.setValue(String(this.plugin.settings.autoSyncIntervalMinutes)).onChange(async value => {
      if (!/^\d+$/.test(value) || Number(value) > 10080) { interval.setDesc('未保存：请输入 0 至 10080 的整数。'); return; }
      this.plugin.settings.autoSyncIntervalMinutes = Number(value); await this.persist(); this.plugin.startIntervalSync(); interval.setDesc('已保存。0 为关闭定时同步。');
    }));
    parent.createEl('p', { cls: 'flomo-muted', text: `已记录 ${Object.keys(this.plugin.settings.syncedMemos).length} 条 memo。图片和删除规则可在其他标签页设置。` });
    if (this.plugin.lastErrors.length) {
      const errors = parent.createDiv({ cls: 'flomo-feedback is-error', attr: { role: 'status' } });
      errors.createEl('strong', { text: '待处理问题' });
      for (const error of this.plugin.lastErrors) errors.createEl('p', { text: error });
    }
  }
  private naming(parent: HTMLElement): void {
    parent.createEl('h3', { text: '保存与命名' });
    this.pathSetting(parent, '默认保存根目录', 'rootFolder', '范围内的笔记没有命中目录映射时保存在这里。');
    const mode = new Setting(parent).setName('文件名模式').setDesc('只影响新导入的笔记。切换模式会保留自定义模板。');
    mode.addDropdown(dropdown => dropdown.addOption('default', '默认模式').addOption('custom', '自定义模式').setValue(this.draftFileMode).onChange(value => { this.draftFileMode = value as 'default' | 'custom'; this.display(); }));
    const editor = parent.createDiv({ cls: 'flomo-editor-card' });
    let input: HTMLInputElement | undefined;
    if (this.draftFileMode === 'custom') {
      input = editor.createEl('input', { cls: 'flomo-template-input', attr: { type: 'text', 'aria-label': '自定义文件名模板' } });
      input.value = this.draftFileTemplate;
    } else editor.createEl('code', { text: DEFAULT_FILE_NAME, cls: 'flomo-default-template' });
    const preview = editor.createEl('pre', { cls: 'flomo-preview', attr: { 'aria-live': 'polite' } });
    const feedback = editor.createDiv({ cls: 'flomo-feedback', attr: { role: 'status' } });
    const update = () => {
      const template = this.draftFileMode === 'default' ? DEFAULT_FILE_NAME : this.draftFileTemplate;
      const error = validateFileNameTemplate(template);
      feedback.textContent = error ? `未保存：${error}` : '草稿预览 · 点击保存后生效'; feedback.toggleClass('is-error', !!error);
      if (error) { preview.textContent = '请修正模板后查看预览'; return; }
      const path = computeDesiredPaths(SAMPLE_MEMO, { ...this.plugin.settings, fileNameTemplate: template });
      preview.textContent = `文件名：${renderFileName(template, SAMPLE_MEMO)}.md\n保存路径：${path[0] || '样例标签“写作 / 素材”不在当前同步范围内'}`;
    };
    if (input) {
      input.addEventListener('input', () => { this.draftFileTemplate = input!.value; update(); });
      this.variables(editor, token => this.insert(input!, token, value => { this.draftFileTemplate = value; update(); }));
    }
    new Setting(editor).addButton(button => button.setButtonText('保存文件名设置').setCta().onClick(async () => {
      const template = this.draftFileMode === 'default' ? DEFAULT_FILE_NAME : this.draftFileTemplate;
      const error = validateFileNameTemplate(template); if (error) { update(); return; }
      Object.assign(this.plugin.settings, { fileNameMode: this.draftFileMode, fileNameTemplate: template,
        customFileNameTemplate: this.draftFileMode === 'custom' ? this.draftFileTemplate : this.plugin.settings.customFileNameTemplate });
      await this.persist(); feedback.textContent = '已保存；现有笔记保持原文件名。';
    })).addButton(button => button.setButtonText('还原').onClick(() => { this.resetFileDraft(); this.display(); }));
    update();
  }
  private tagPicker(parent: HTMLElement, key: 'scopeTags' | 'excludedTags'): void {
    const box = parent.createDiv({ cls: 'flomo-tag-picker' });
    const selected = box.createDiv({ cls: 'flomo-selected-tags' });
    const search = box.createEl('input', { cls: 'flomo-template-input', attr: { type: 'search', placeholder: '搜索或输入完整标签', 'aria-label': key === 'scopeTags' ? '同步范围标签' : '更新例外标签' } });
    const add = box.createEl('button', { text: '添加输入的标签', attr: { type: 'button' } });
    const list = box.createDiv({ cls: 'flomo-tag-options' });
    const toggle = async (tag: string) => {
      const tags = this.plugin.settings[key];
      this.plugin.settings[key] = tags.includes(tag) ? tags.filter(value => value !== tag) : [...tags, tag];
      await this.persist(); draw();
    };
    const draw = () => {
      selected.empty(); list.empty();
      for (const tag of this.plugin.settings[key]) {
        selected.createEl('button', { text: `#${tag} ×`, cls: 'flomo-chip', attr: { 'aria-label': `移除标签 ${tag}` } }).addEventListener('click', () => { void toggle(tag); });
      }
      const available = normalizeTagList([...this.plugin.settings.availableFlomoTags, ...this.plugin.settings[key]]).filter(tag => tag.toLocaleLowerCase().includes(search.value.toLocaleLowerCase().replace(/^#/, '')));
      for (const tag of available) {
        const label = list.createEl('label', { cls: 'flomo-tag-option' });
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } }); checkbox.checked = this.plugin.settings[key].includes(tag);
        label.createSpan({ text: tag }); checkbox.addEventListener('change', () => { void toggle(tag); });
      }
      if (!available.length) list.createEl('p', { cls: 'flomo-muted', text: '没有匹配标签，可以手动添加。' });
    };
    search.addEventListener('input', draw);
    const addTag = async () => { const tag = normalizeTag(search.value); if (tag && !this.plugin.settings[key].includes(tag)) await toggle(tag); };
    add.addEventListener('click', () => { void addTag(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addTag(); } });
    draw();
  }
  private scope(parent: HTMLElement): void {
    parent.createEl('h3', { text: '哪些内容参与同步' });
    new Setting(parent).setName('同步范围模式').setDesc(this.plugin.settings.scopeMode === 'include' ? '只同步命中任意所选标签的内容；未选择标签时不导入。' : '跳过命中任意所选标签的内容；未选择标签时同步全部，包括无标签内容。')
      .addDropdown(dropdown => dropdown.addOption('include', '包括所选标签').addOption('exclude', '排除所选标签').setValue(this.plugin.settings.scopeMode).onChange(async value => { this.plugin.settings.scopeMode = value as 'include' | 'exclude'; await this.persist(); this.display(); }));
    new Setting(parent).setName(`Flomo 标签（${this.plugin.settings.availableFlomoTags.length}）`).setDesc('按完整标签名匹配；退出范围的已有笔记原地保留。').addButton(button => button.setButtonText('刷新标签').setDisabled(!this.plugin.settings.bearerToken).onClick(() => this.action(() => this.plugin.refreshAvailableFlomoTags())));
    this.tagPicker(parent, 'scopeTags');
    parent.createEl('h3', { text: '标签 → 保存目录' });
    parent.createEl('p', { cls: 'flomo-muted', text: '目录映射不改变同步范围。多条命中时第一条优先，没有匹配时使用默认根目录；已有笔记不自动搬动。' });
    const mappings = this.plugin.settings.tagFolderMappings;
    mappings.forEach((mapping, index) => {
      const row = new Setting(parent).setName(`映射 ${index + 1}`); row.settingEl.addClass('flomo-mapping-row');
      const edit = async (key: 'tag' | 'folder', value: string) => {
        const next = { ...mapping, [key]: key === 'tag' ? normalizeTag(value) : value };
        const error = !next.tag ? '标签不能为空' : mappings.some((item, i) => i !== index && item.tag === next.tag) ? '该标签已设置映射' : validateVaultRelativePath(next.folder);
        if (error) { row.setDesc(`未保存：${error}`); return; }
        Object.assign(mapping, { ...next, folder: normalizeVaultPath(next.folder) }); await this.persist(); row.setDesc('已保存');
      };
      row.addText(text => { this.suggestions(row.settingEl, text.inputEl, this.plugin.settings.availableFlomoTags); text.inputEl.setAttribute('aria-label', `映射 ${index + 1} 标签`); text.setValue(mapping.tag).onChange(value => edit('tag', value)); });
      row.addText(text => { this.suggestions(row.settingEl, text.inputEl, this.folders()); text.inputEl.setAttribute('aria-label', `映射 ${index + 1} 目录`); text.setValue(mapping.folder).onChange(value => edit('folder', value)); });
      for (const offset of [-1, 1]) row.addExtraButton(button => button.setIcon(offset === -1 ? 'arrow-up' : 'arrow-down').setTooltip(offset === -1 ? '上移' : '下移').setDisabled(index + offset < 0 || index + offset >= mappings.length).onClick(async () => { [mappings[index], mappings[index + offset]] = [mappings[index + offset], mappings[index]]; await this.persist(); this.display(); }));
      row.addExtraButton(button => button.setIcon('trash').setTooltip('移除映射').onClick(async () => { mappings.splice(index, 1); await this.persist(); this.display(); }));
    });
    const add = new Setting(parent).setName('添加映射'); add.settingEl.addClass('flomo-mapping-row');
    add.addText(text => { this.suggestions(add.settingEl, text.inputEl, this.plugin.settings.availableFlomoTags); text.setPlaceholder('完整标签').setValue(this.draftTag).onChange(value => { this.draftTag = value; }); });
    add.addText(text => { this.suggestions(add.settingEl, text.inputEl, this.folders()); text.setPlaceholder('保存目录').setValue(this.draftFolder || this.plugin.settings.rootFolder).onChange(value => { this.draftFolder = value; }); });
    add.addButton(button => button.setButtonText('添加').onClick(async () => {
      const tag = normalizeTag(this.draftTag), folder = this.draftFolder || this.plugin.settings.rootFolder;
      const error = !tag ? '请输入标签' : mappings.some(mapping => mapping.tag === tag) ? '该标签已设置映射' : validateVaultRelativePath(folder);
      if (error) { add.setDesc(error); return; }
      mappings.push({ tag, folder: normalizeVaultPath(folder) }); await this.persist(); this.draftTag = ''; this.draftFolder = ''; this.display();
    }));
    parent.createEl('h3', { text: '图片与附件' });
    new Setting(parent).setName('图片本地化').setDesc('下载失败时保留远端链接。').addToggle(toggle => toggle.setValue(this.plugin.settings.localizeImages).onChange(async value => { this.plugin.settings.localizeImages = value; await this.persist(); }));
    this.pathSetting(parent, '图片保存目录', 'imageFolder', '目录下按 memo 编号分文件夹；只影响新导入 memo，已有图片沿用原目录。');
  }
  private yaml(parent: HTMLElement): void {
    parent.createEl('h3', { text: '新笔记 YAML 字段模板' });
    parent.createEl('p', { cls: 'flomo-muted', text: '每行一个顶层字段，仅在首次导入时写入。tags 和 flomo_ 字段由插件维护。' });
    const grid = parent.createDiv({ cls: 'flomo-yaml-grid' });
    const editor = grid.createDiv({ cls: 'flomo-editor-card' }); editor.createEl('label', { text: '编辑模板', attr: { for: 'flomo-yaml-input' } });
    const input = editor.createEl('textarea', { cls: 'flomo-yaml-input', attr: { id: 'flomo-yaml-input', rows: '14', spellcheck: 'false' } }); input.value = this.draftYaml;
    const output = grid.createDiv({ cls: 'flomo-editor-card' }); output.createEl('strong', { text: '生成预览' });
    const preview = output.createEl('pre', { cls: 'flomo-preview', attr: { 'aria-live': 'polite' } });
    const feedback = parent.createDiv({ cls: 'flomo-feedback', attr: { role: 'status' } });
    const update = () => {
      try {
        const error = validateYamlTemplate(this.draftYaml); if (error) throw new Error(error);
        preview.textContent = renderYamlTemplate(this.draftYaml, SAMPLE_MEMO) || '未添加额外字段';
        feedback.textContent = '草稿预览 · 点击保存后生效'; feedback.removeClass('is-error');
      } catch (error) { preview.textContent = '请修正模板后查看预览'; feedback.textContent = `未保存：${(error as Error).message}`; feedback.addClass('is-error'); }
    };
    input.addEventListener('input', () => { this.draftYaml = input.value; update(); });
    this.variables(editor, token => this.insert(input, token, value => { this.draftYaml = value; update(); }));
    new Setting(parent).addButton(button => button.setButtonText('保存 YAML 模板').setCta().onClick(async () => {
      try { renderYamlTemplate(this.draftYaml, SAMPLE_MEMO); } catch { update(); return; }
      this.plugin.settings.yamlTemplate = this.draftYaml; await this.persist(); feedback.textContent = '已保存；仅应用于之后首次导入的新笔记。';
    })).addButton(button => button.setButtonText('还原').onClick(() => { this.draftYaml = this.plugin.settings.yamlTemplate; this.display(); }))
      .addButton(button => button.setButtonText('插入示例').onClick(() => { this.draftYaml += `${this.draftYaml ? '\n' : ''}source: flomo\nnote_type: memo\ncreated: "{{date}}"\naliases: []`; input.value = this.draftYaml; update(); }));
    update();
  }
  private safety(parent: HTMLElement): void {
    parent.createEl('h3', { text: '更新已有笔记' });
    new Setting(parent).setName('受管区更新方式').setDesc('手工正文及手工属性始终保留。首次导入生成完整笔记；删除与恢复状态按下面的独立规则处理。').addDropdown(dropdown => dropdown
      .addOption('both', '正文与属性').addOption('body', '仅正文').addOption('properties', '仅属性').addOption('new-only', '仅首次导入')
      .setValue(this.plugin.settings.updateMode).onChange(async value => { this.plugin.settings.updateMode = value as UpdateMode; await this.persist(); }));
    const exceptions = parent.createEl('details'); exceptions.createEl('summary', { text: `标签更新例外（${this.plugin.settings.excludedTags.length}）` });
    exceptions.createEl('p', { cls: 'flomo-muted', text: '只在同步范围内生效。命中任意完整标签时，采用以下例外规则。' });
    this.tagPicker(exceptions, 'excludedTags');
    new Setting(exceptions).setName('命中例外标签时').addDropdown(dropdown => dropdown.addOption('freeze', '首次导入后冻结').addOption('skip', '完全不导入，也不更新').setValue(this.plugin.settings.excludedPolicy).onChange(async value => { this.plugin.settings.excludedPolicy = value as 'freeze' | 'skip'; await this.persist(); }));
    parent.createEl('h3', { text: 'Flomo 删除后的本地处理' });
    new Setting(parent).setName('删除动作').setDesc('以通过完整性检查的全量响应判定；退出同步范围不等于删除。所有动作保留附件。').addDropdown(dropdown => dropdown
      .addOption('keep', '保持原样').addOption('mark', '标记已删除').addOption('archive', '移入归档目录').addOption('trash', '列出后手动移入回收站')
      .setValue(this.plugin.settings.deletionAction).onChange(async value => { this.plugin.settings.deletionAction = value as DeletionAction; await this.persist(); this.display(); }));
    if (this.plugin.settings.deletionAction === 'archive') this.pathSetting(parent, '归档目录', 'archiveFolder', '保留原相对路径；Flomo 恢复后移回原位置，路径冲突时停止移动。');
    if (this.plugin.settings.deletionAction === 'trash') this.trashList(parent);
    parent.createEl('p', { cls: 'flomo-muted', text: '写入和移动前都会核对受管区标记与笔记编号。冲突时保留原文件，可在“连接与同步”查看原因。' });
  }
  private trashList(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: 'flomo-editor-card' }); box.createEl('h4', { text: '待移入回收站' });
    box.createEl('p', { cls: 'flomo-muted', text: '勾选后执行。执行前重新核对远端状态，只移动所选笔记至 Obsidian .trash；附件保留。' });
    const candidates = Object.values(this.plugin.settings.syncedMemos).filter(record => record.pendingTrash).flatMap(record =>
      (record.fileStates || record.filePaths.map((path): FileState => ({ path, state: 'live' }))).filter(file => file.state !== 'trashed').map(file => ({ ...file, date: record.deletedDetectedAt })));
    const paths = new Set(candidates.map(file => file.path));
    this.selectedTrash = new Set([...this.selectedTrash].filter(path => paths.has(path)));
    let execute: HTMLButtonElement;
    for (const file of candidates) {
      const row = box.createEl('label', { cls: 'flomo-trash-row' });
      const checkbox = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选择 ${file.path}` } }); checkbox.checked = this.selectedTrash.has(file.path);
      const info = row.createDiv(); info.createEl('strong', { text: file.path.split('/').pop() || file.path }); info.createEl('div', { cls: 'flomo-muted', text: `${file.path} · ${file.date ? new Date(file.date).toLocaleString() : '待确认'}` });
      checkbox.addEventListener('change', () => { if (checkbox.checked) this.selectedTrash.add(file.path); else this.selectedTrash.delete(file.path); execute.disabled = this.selectedTrash.size === 0; execute.textContent = `将所选 ${this.selectedTrash.size} 篇移入回收站`; });
    }
    if (!candidates.length) box.createEl('p', { text: '暂无待处理笔记。同步后会在此列出。' });
    execute = box.createEl('button', { text: `将所选 ${this.selectedTrash.size} 篇移入回收站`, cls: 'mod-warning' }); execute.disabled = this.selectedTrash.size === 0;
    execute.addEventListener('click', () => { const selected = [...this.selectedTrash]; void this.action(() => this.plugin.trashSelected(selected)); });
  }
}
