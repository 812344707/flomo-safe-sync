import { App, Notice, Platform, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type FlomoSafeSyncPlugin from './main';
import { DEFAULT_FILE_NAME, DeletionAction, FileState } from './settings';
import { BODY_END, BODY_START, DEFAULT_NOTE_TEMPLATE, FRONTMATTER_END, FRONTMATTER_START, FlomoMemo,
  NOTE_CONTENT_TOKEN, NOTE_TAGS_TOKEN, UpdateMode, buildNewMemoFile,
  computeDesiredPaths, hierarchicalTags, normalizeTag, normalizeTagList, normalizeVaultPath,
  renderFileName, validateFileNameTemplate, validateNoteTemplate, validateVaultRelativePath } from './sync-core';

export const SAMPLE_MEMO: FlomoMemo = { slug: 'abcdef123456', content: '<p>第一条写作想法</p>',
  tags: [{ name: '写作' }, { name: '素材' }], created_at: '2026-09-01 08:09:10', updated_at: '2026-09-01 08:09:10' };
const TABS = [['connection', '连接与同步'], ['naming', '保存与命名'], ['scope', '同步范围'], ['yaml', '笔记模板'], ['safety', '更新与安全']] as const;
const RECOMMENDED_TIME_VARIABLES = [
  ['{{yyyy-MM-dd}}', '推荐日期格式：年-月-日', '2026-09-01'],
  ['{{yyyy-MM-dd_HH-mm-ss}}', '推荐日期时间格式（24 小时制）', '2026-09-01_08-09-10'],
  ['{{yyyyMMdd-HHmmss}}', '推荐紧凑日期时间格式', '20260901-080910'],
] as const;
const LEGACY_TIME_VARIABLES = [
  ['{{date}}', '完整创建日期', '2026-09-01'], ['{{time}}', '完整创建时间，使用文件名安全分隔符', '08-09-10'],
  ['{{year}}', '四位年份', '2026'], ['{{month}}', '两位月份', '09'], ['{{day}}', '两位日期', '01'],
  ['{{hour}}', '两位小时', '08'], ['{{minute}}', '两位分钟', '09'], ['{{second}}', '两位秒数', '10'],
  ['{{YYYY-MM-DD-HHmmss}}', '兼容原有紧凑日期时间变量', '2026-09-01-080910'],
] as const;
const NOTE_STRUCTURE_VARIABLES = [
  [NOTE_TAGS_TOKEN, '标签合并区，必须在 YAML 中独占一行'],
  [NOTE_CONTENT_TOKEN, 'Flomo 正文内容，必须位于正文受管区标记之间'],
] as const;
const CONTENT_VARIABLES = [
  ['{{title:20}}', '正文首行，最多 20 字；可编辑长度或使用 {{title}}'], ['{{slug:8}}', 'memo 编号前 8 位；可编辑长度或使用 {{slug}}'], ['{{first_tag}}', '第一个标签；无标签时为 untagged'],
] as const;

export class FlomoSafeSyncSettingTab extends PluginSettingTab {
  activeTab: string = 'connection';
  draftFileMode: 'default' | 'custom';
  draftDefaultFileTemplate: string;
  draftFileTemplate: string;
  draftNoteTemplate: string;
  private busy = false;
  private suggestionId = 0;
  private selectedTrash = new Set<string>();

  constructor(app: App, public plugin: FlomoSafeSyncPlugin, private login: () => Promise<string | null>) {
    super(app, plugin);
    this.resetFileDraft();
    this.draftNoteTemplate = plugin.settings.noteTemplate;
  }
  private resetFileDraft(): void {
    this.draftFileMode = this.plugin.settings.fileNameMode;
    this.draftDefaultFileTemplate = this.plugin.settings.defaultFileNameTemplate || DEFAULT_FILE_NAME;
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
  private variables(parent: HTMLElement, insert: (value: string) => void, includeStructure = false): void {
    const toolbar = parent.createDiv({ cls: 'flomo-variable-toolbar' });
    const timeGroup = toolbar.createDiv({ cls: 'flomo-variable-group' });
    timeGroup.createSpan({ text: '推荐时间格式', cls: 'flomo-variable-group-label' });
    for (const [token, description, example] of RECOMMENDED_TIME_VARIABLES) {
      const button = timeGroup.createEl('button', { text: token, attr: { type: 'button', title: `${description} · ${example}` } });
      button.addEventListener('click', () => insert(token));
    }
    const contentGroup = toolbar.createDiv({ cls: 'flomo-variable-group' });
    contentGroup.createSpan({ text: '内容', cls: 'flomo-variable-group-label' });
    for (const [token, description] of CONTENT_VARIABLES) {
      const button = contentGroup.createEl('button', { text: token, attr: { type: 'button', title: description } });
      button.addEventListener('click', () => insert(token));
    }
    if (includeStructure) {
      const structureGroup = toolbar.createDiv({ cls: 'flomo-variable-group' });
      structureGroup.createSpan({ text: '同步结构', cls: 'flomo-variable-group-label' });
      for (const [token, description] of NOTE_STRUCTURE_VARIABLES) {
        const button = structureGroup.createEl('button', { text: token, attr: { type: 'button', title: description } });
        button.addEventListener('click', () => insert(token));
      }
    }
    const timeReference = parent.createEl('details', { cls: 'flomo-variable-reference' });
    timeReference.open = true;
    timeReference.createEl('summary', { text: '时间变量参考' });
    timeReference.createEl('p', { cls: 'flomo-muted', text: '新模板推荐使用以下 Unicode 风格日期字段；输出采用便于排序且适合文件名的年-月-日顺序。' });
    const table = timeReference.createDiv({ cls: 'flomo-variable-table' });
    for (const [token, description, example] of RECOMMENDED_TIME_VARIABLES) {
      const row = table.createDiv({ cls: 'flomo-variable-reference-row' });
      row.createEl('code', { text: token }); row.createSpan({ text: description }); row.createEl('code', { text: example });
    }
    timeReference.createEl('p', { cls: 'flomo-muted', text: '可组合字段：yyyy/yy 年，MM/M 月，dd/d 日，HH/H 24 小时，mm/m 分，ss/s 秒。大小写有区别；可使用 -、_、. 或空格分隔。' });
    timeReference.createEl('p', { cls: 'flomo-muted', text: '请使用 yyyy 表示年份、dd 表示日期。大写 YYYY、DD 在通用日期规范中含义不同，本插件只对完整旧变量提供兼容。' });
    const legacyTable = timeReference.createDiv({ cls: 'flomo-variable-table' });
    legacyTable.createEl('strong', { text: '兼容旧格式' });
    for (const [token, description, example] of LEGACY_TIME_VARIABLES) {
      const row = legacyTable.createDiv({ cls: 'flomo-variable-reference-row' });
      row.createEl('code', { text: token }); row.createSpan({ text: description }); row.createEl('code', { text: example });
    }
    const links = timeReference.createDiv({ cls: 'flomo-variable-links' });
    links.createEl('a', { text: 'Unicode 日期字段规范 ↗', href: 'https://unicode.org/reports/tr35/tr35-dates.html#Date_Field_Symbol_Table', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    links.createEl('a', { text: '插件完整变量参考 ↗', href: 'https://github.com/812344707/flomo-safe-sync#保存位置和文件名', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    const contentReference = parent.createEl('details', { cls: 'flomo-variable-reference' });
    contentReference.createEl('summary', { text: '内容变量参考' });
    for (const [token, description] of CONTENT_VARIABLES) contentReference.createEl('p', { text: `${token} — ${description}` });
    if (includeStructure) {
      const structureReference = parent.createEl('details', { cls: 'flomo-variable-reference' });
      structureReference.open = true;
      structureReference.createEl('summary', { text: '同步结构占位符' });
      for (const [token, description] of NOTE_STRUCTURE_VARIABLES) structureReference.createEl('p', { text: `${token} — ${description}` });
    }
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
    info.createEl('p', { cls: 'flomo-muted', text: `${this.plugin.settings.bearerToken ? '已连接 Flomo' : '尚未连接'} · ${this.plugin.settings.lastSyncTime ? `上次同步 ${new Date(this.plugin.settings.lastSyncTime).toLocaleString()}` : '尚未同步'} · v${this.plugin.manifest.version}` });
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
    } else {
      editor.createEl('code', { text: this.draftDefaultFileTemplate, cls: 'flomo-default-template' });
      if (this.draftDefaultFileTemplate !== DEFAULT_FILE_NAME) {
        editor.createEl('p', { cls: 'flomo-muted', text: '当前保留升级前的默认模板。它会继续生效，直到你主动采用推荐格式并保存。' });
        editor.createEl('button', { text: '采用推荐默认格式', attr: { type: 'button' } })
          .addEventListener('click', () => { this.draftDefaultFileTemplate = DEFAULT_FILE_NAME; this.display(); });
      } else editor.createEl('p', { cls: 'flomo-muted', text: '当前使用推荐的日期时间格式。' });
    }
    const preview = editor.createEl('pre', { cls: 'flomo-preview', attr: { 'aria-live': 'polite' } });
    const feedback = editor.createDiv({ cls: 'flomo-feedback', attr: { role: 'status' } });
    const update = () => {
      const template = this.draftFileMode === 'default' ? this.draftDefaultFileTemplate : this.draftFileTemplate;
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
      const template = this.draftFileMode === 'default' ? this.draftDefaultFileTemplate : this.draftFileTemplate;
      const error = validateFileNameTemplate(template); if (error) { update(); return; }
      Object.assign(this.plugin.settings, { fileNameMode: this.draftFileMode, defaultFileNameTemplate: this.draftDefaultFileTemplate, fileNameTemplate: template,
        customFileNameTemplate: this.draftFileMode === 'custom' ? this.draftFileTemplate : this.plugin.settings.customFileNameTemplate });
      await this.persist(); feedback.textContent = '已保存；现有笔记保持原文件名。';
    })).addButton(button => button.setButtonText('还原').onClick(() => { this.resetFileDraft(); this.display(); }));
    update();
  }
  private tagPicker(parent: HTMLElement, key: 'scopeTags' | 'excludedTags'): void {
    const box = parent.createDiv({ cls: 'flomo-tag-picker' });
    const selected = box.createDiv({ cls: 'flomo-selected-tags' });
    const inputRow = box.createDiv({ cls: 'flomo-tag-input-row' });
    const search = inputRow.createEl('input', { cls: 'flomo-template-input', attr: { type: 'search', placeholder: '搜索或输入完整标签', 'aria-label': key === 'scopeTags' ? '同步范围标签' : '更新例外标签' } });
    const add = inputRow.createEl('button', { text: '添加标签', attr: { type: 'button' } });
    const list = box.createDiv({ cls: 'flomo-tag-options', attr: { role: 'tree', 'aria-label': key === 'scopeTags' ? '同步范围标签层级' : '更新例外标签层级' } });
    const toggle = async (tag: string) => {
      const tags = this.plugin.settings[key];
      this.plugin.settings[key] = tags.includes(tag) ? tags.filter(value => value !== tag) : [...tags, tag];
      await this.persist(); this.display();
    };
    const draw = () => {
      selected.empty(); list.empty();
      for (const tag of this.plugin.settings[key]) {
        selected.createEl('button', { text: `#${tag} ×`, cls: 'flomo-chip', attr: { 'aria-label': `移除标签 ${tag}` } }).addEventListener('click', () => { void toggle(tag); });
      }
      const available = hierarchicalTags([...this.plugin.settings.availableFlomoTags, ...this.plugin.settings[key]])
        .filter(item => item.tag.toLocaleLowerCase().includes(search.value.toLocaleLowerCase().replace(/^#/, '')));
      for (const { tag, depth } of available) {
        const label = list.createEl('label', { cls: 'flomo-tag-option', attr: { role: 'treeitem', 'aria-level': String(depth + 1), title: `完整标签：#${tag}` } });
        label.style.setProperty('--flomo-tag-depth', String(depth));
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } }); checkbox.checked = this.plugin.settings[key].includes(tag);
        label.createSpan({ text: `#${tag}` }); checkbox.addEventListener('change', () => { void toggle(tag); });
      }
      if (!available.length) list.createEl('p', { cls: 'flomo-muted', text: '没有匹配标签，可以手动添加。' });
    };
    search.addEventListener('input', draw);
    const addTag = async () => { const tag = normalizeTag(search.value); if (tag && !this.plugin.settings[key].includes(tag)) await toggle(tag); };
    add.addEventListener('click', () => { void addTag(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addTag(); } });
    draw();
  }
  private mappingTags(): string[] {
    const excluded = new Set(this.plugin.settings.scopeMode === 'exclude' ? this.plugin.settings.scopeTags : []);
    const eligible = this.plugin.settings.scopeMode === 'include'
      ? normalizeTagList(this.plugin.settings.scopeTags)
      : normalizeTagList([...this.plugin.settings.availableFlomoTags, ...this.plugin.settings.tagFolderMappings.map(mapping => mapping.tag)])
        .filter(tag => !excluded.has(tag));
    const configured = this.plugin.settings.tagFolderMappings.map(mapping => normalizeTag(mapping.tag)).filter(tag => eligible.includes(tag));
    return [...configured, ...eligible.filter(tag => !configured.includes(tag))];
  }
  private scope(parent: HTMLElement): void {
    parent.createEl('h3', { text: '哪些内容参与同步' });
    new Setting(parent).setName('同步范围模式').setDesc(this.plugin.settings.scopeMode === 'include' ? '只同步命中任意所选标签的内容；未选择标签时不导入。' : '跳过命中任意所选标签的内容；未选择标签时同步全部，包括无标签内容。')
      .addDropdown(dropdown => dropdown.addOption('include', '包括所选标签').addOption('exclude', '排除所选标签').setValue(this.plugin.settings.scopeMode).onChange(async value => { this.plugin.settings.scopeMode = value as 'include' | 'exclude'; await this.persist(); this.display(); }));
    new Setting(parent).setName(`Flomo 标签（${this.plugin.settings.availableFlomoTags.length}）`).setDesc('按完整标签名匹配；退出范围的已有笔记原地保留。').addButton(button => button.setButtonText('刷新标签').setDisabled(!this.plugin.settings.bearerToken).onClick(() => this.action(() => this.plugin.refreshAvailableFlomoTags())));
    this.tagPicker(parent, 'scopeTags');
    parent.createEl('h3', { text: '标签 → 保存目录' });
    parent.createEl('p', { cls: 'flomo-muted', text: '映射标签根据当前同步范围自动列出，只需选择右侧文件夹。已设置的映射从上到下优先；已有笔记不自动搬动。' });
    this.pathSetting(parent, '未映射标签的默认位置', 'rootFolder', '无标签或没有设置专属映射的 memo 保存在这里。');
    const mappings = this.plugin.settings.tagFolderMappings;
    const routeTags = this.mappingTags();
    for (const [rowIndex, tag] of routeTags.entries()) {
      const mappingIndex = mappings.findIndex(mapping => normalizeTag(mapping.tag) === tag);
      const mapping = mappingIndex >= 0 ? mappings[mappingIndex] : undefined;
      const row = new Setting(parent).setName(`#${tag}`).setDesc(mapping ? `专属目录 · 映射优先级 ${mappingIndex + 1}` : `使用默认位置：${this.plugin.settings.rootFolder}`);
      row.settingEl.addClass('flomo-mapping-row');
      row.settingEl.style.setProperty('--flomo-tag-depth', String(Math.max(0, tag.split('/').length - 1)));
      row.addText(text => {
        this.suggestions(row.settingEl, text.inputEl, this.folders());
        text.inputEl.setAttribute('aria-label', `标签 #${tag} 的保存目录`);
        text.setPlaceholder(`默认：${this.plugin.settings.rootFolder}`).setValue(mapping?.folder || '').onChange(async value => {
          if (!value.trim()) {
            const index = mappings.findIndex(item => normalizeTag(item.tag) === tag);
            if (index >= 0) mappings.splice(index, 1);
            await this.persist(); row.setDesc(`已使用默认位置：${this.plugin.settings.rootFolder}`); return;
          }
          const error = validateVaultRelativePath(value);
          if (error) { row.setDesc(`未保存：${error}`); return; }
          const folder = normalizeVaultPath(value);
          const current = mappings.find(mapping => normalizeTag(mapping.tag) === tag);
          if (current) current.folder = folder;
          else {
            const priorConfigured = routeTags.slice(0, rowIndex).reverse().find(prior => mappings.some(item => normalizeTag(item.tag) === prior));
            const insertion = priorConfigured ? mappings.findIndex(item => normalizeTag(item.tag) === priorConfigured) + 1 : mappings.length;
            mappings.splice(insertion, 0, { tag, folder });
          }
          await this.persist(); row.setDesc(`已保存：${folder}`);
        });
      });
      if (mapping) {
        for (const offset of [-1, 1]) row.addExtraButton(button => button.setIcon(offset === -1 ? 'arrow-up' : 'arrow-down').setTooltip(offset === -1 ? '提高映射优先级' : '降低映射优先级')
          .setDisabled(mappingIndex + offset < 0 || mappingIndex + offset >= mappings.length).onClick(async () => {
            [mappings[mappingIndex], mappings[mappingIndex + offset]] = [mappings[mappingIndex + offset], mappings[mappingIndex]];
            await this.persist(); this.display();
          }));
        row.addExtraButton(button => button.setIcon('rotate-ccw').setTooltip('改用默认位置').onClick(async () => {
          mappings.splice(mappingIndex, 1); await this.persist(); this.display();
        }));
      }
    }
    if (!routeTags.length) parent.createEl('p', { cls: 'flomo-empty-state', text: this.plugin.settings.scopeMode === 'include'
      ? '请先在上方选择要包括的标签，映射行会自动出现。'
      : '刷新 Flomo 标签后，未被排除的标签会自动显示在这里。' });
    parent.createEl('h3', { text: '图片与附件' });
    new Setting(parent).setName('图片本地化').setDesc('识别图床插件已替换的远程图片链接并记住映射，后续同步不再重新下载；下载失败时保留 Flomo 原链接。').addToggle(toggle => toggle.setValue(this.plugin.settings.localizeImages).onChange(async value => { this.plugin.settings.localizeImages = value; await this.persist(); }));
    this.pathSetting(parent, '图片保存目录', 'imageFolder', '目录下按 memo 编号分文件夹；只影响新导入 memo，已有图片沿用原目录。');
  }
  private renderWholeNotePreview(parent: HTMLElement, content: string): void {
    parent.empty();
    const legend = parent.createDiv({ cls: 'flomo-note-legend' });
    for (const [label, cls] of [['插件受管区', 'is-managed'], ['标签合并区', 'is-merged'], ['用户可编辑区', 'is-editable']] as const) {
      legend.createSpan({ text: label, cls: `flomo-zone-badge ${cls}` });
    }
    const preview = parent.createEl('pre', { cls: 'flomo-preview flomo-whole-note-preview', attr: { 'aria-label': '完整笔记模板预览' } });
    const zones: Array<{ start: number; end: number; cls: string; title: string }> = [];
    for (const [startMarker, endMarker, title] of [
      [FRONTMATTER_START, FRONTMATTER_END, 'Flomo 属性受管区：同步时由插件更新'],
      [BODY_START, BODY_END, 'Flomo 正文受管区：按更新方式同步'],
    ] as const) {
      const start = content.indexOf(startMarker), markerEnd = content.indexOf(endMarker);
      if (start >= 0 && markerEnd >= start) zones.push({ start, end: markerEnd + endMarker.length, cls: 'is-managed', title });
    }
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter) {
      const yamlStart = content.indexOf(frontmatter[1]);
      const tagBlock = frontmatter[1].match(/^tags:[^\r\n]*(?:\r?\n[ \t]+-[^\r\n]*)*/m);
      if (tagBlock?.index !== undefined) zones.push({ start: yamlStart + tagBlock.index, end: yamlStart + tagBlock.index + tagBlock[0].length,
        cls: 'is-merged', title: '标签合并区：Flomo 标签会更新，手工标签会保留' });
    }
    zones.sort((left, right) => left.start - right.start);
    const append = (text: string, cls = '', title = '') => {
      if (!text) return;
      const span = preview.createSpan({ text, cls });
      if (title) span.setAttribute('title', title);
    };
    let cursor = 0;
    for (const zone of zones) {
      if (zone.start < cursor) continue;
      append(content.slice(cursor, zone.start), 'flomo-preview-zone is-editable', '用户可编辑区：模板可自主修改，首次导入后保留');
      append(content.slice(zone.start, zone.end), `flomo-preview-zone ${zone.cls}`, zone.title);
      cursor = zone.end;
    }
    append(content.slice(cursor), 'flomo-preview-zone is-editable', '用户可编辑区：模板可自主修改，首次导入后保留');
  }
  private yaml(parent: HTMLElement): void {
    parent.createEl('h3', { text: '完整笔记模板' });
    parent.createEl('p', { cls: 'flomo-muted', text: '左侧就是首次导入时使用的完整 Markdown 源码，可修改用户 YAML、标题和正文结构。受管区代码已完整显示且不能删除或改写；标签与正文动态占位符必须各保留一个。' });
    const grid = parent.createDiv({ cls: 'flomo-yaml-grid' });
    const editor = grid.createDiv({ cls: 'flomo-editor-card' }); editor.createEl('label', { text: '完整笔记源码（可编辑）', attr: { for: 'flomo-note-template-input' } });
    const input = editor.createEl('textarea', { cls: 'flomo-yaml-input flomo-note-template-input', attr: { id: 'flomo-note-template-input', rows: '24', spellcheck: 'false' } }); input.value = this.draftNoteTemplate;
    const output = grid.createDiv({ cls: 'flomo-editor-card' }); output.createEl('strong', { text: '首次导入结果预览' });
    const preview = output.createDiv({ attr: { 'aria-live': 'polite' } });
    const feedback = parent.createDiv({ cls: 'flomo-feedback', attr: { role: 'status' } });
    const update = () => {
      try {
        const error = validateNoteTemplate(this.draftNoteTemplate); if (error) throw new Error(error);
        const wholeNote = buildNewMemoFile(SAMPLE_MEMO, { syncedAt: '2026-09-01T08:10:00+08:00', noteTemplate: this.draftNoteTemplate });
        this.renderWholeNotePreview(preview, wholeNote);
        feedback.textContent = '草稿预览 · 点击保存后生效'; feedback.removeClass('is-error');
      } catch (error) { preview.textContent = '请修正模板后查看完整笔记预览'; feedback.textContent = `未保存：${(error as Error).message}`; feedback.addClass('is-error'); }
    };
    input.addEventListener('input', () => { this.draftNoteTemplate = input.value; update(); });
    this.variables(editor, token => this.insert(input, token, value => { this.draftNoteTemplate = value; update(); }), true);
    new Setting(parent).addButton(button => button.setButtonText('保存笔记模板').setCta().onClick(async () => {
      try { buildNewMemoFile(SAMPLE_MEMO, { syncedAt: '2026-09-01T08:10:00+08:00', noteTemplate: this.draftNoteTemplate }); } catch { update(); return; }
      this.plugin.settings.noteTemplate = this.draftNoteTemplate; await this.persist(); feedback.textContent = '已保存；仅应用于之后首次导入的新笔记。';
    })).addButton(button => button.setButtonText('还原').onClick(() => { this.draftNoteTemplate = this.plugin.settings.noteTemplate; this.display(); }))
      .addButton(button => button.setButtonText('恢复默认模板').onClick(() => { this.draftNoteTemplate = DEFAULT_NOTE_TEMPLATE; input.value = this.draftNoteTemplate; update(); }));
    update();
  }
  private safety(parent: HTMLElement): void {
    parent.createEl('h3', { text: '更新已有笔记' });
    new Setting(parent).setName('受管区更新方式').setDesc('手工正文及手工属性始终保留。首次导入生成完整笔记；删除与恢复状态按下面的独立规则处理。').addDropdown(dropdown => dropdown
      .addOption('both', '正文与属性').addOption('body', '仅正文').addOption('properties', '仅属性').addOption('new-only', '仅首次导入')
      .setValue(this.plugin.settings.updateMode).onChange(async value => { this.plugin.settings.updateMode = value as UpdateMode; await this.persist(); }));
    const exceptions = parent.createDiv({ cls: 'flomo-hierarchy-group' });
    exceptions.createEl('h4', { text: `标签更新例外（${this.plugin.settings.excludedTags.length}）` });
    exceptions.createEl('p', { cls: 'flomo-muted', text: '只在同步范围内生效。以下内容按层级缩进展示：先选择例外标签，再设置命中后的处理。' });
    const tagBranch = exceptions.createDiv({ cls: 'flomo-hierarchy-branch' });
    tagBranch.createEl('strong', { text: '例外标签' });
    this.tagPicker(tagBranch, 'excludedTags');
    const policyBranch = exceptions.createDiv({ cls: 'flomo-hierarchy-branch' });
    new Setting(policyBranch).setName('命中后的处理').addDropdown(dropdown => dropdown.addOption('freeze', '首次导入后冻结').addOption('skip', '完全不导入，也不更新').setValue(this.plugin.settings.excludedPolicy).onChange(async value => { this.plugin.settings.excludedPolicy = value as 'freeze' | 'skip'; await this.persist(); }));
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
