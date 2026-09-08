import { App, Notice, Platform, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type FlomoSafeSyncPlugin from './main';
import { DEFAULT_FILE_NAME, DeletionAction, FileState } from './settings';
import type { MissingLocalMemo } from './sync-engine';
import { BODY_END, BODY_START, DEFAULT_NOTE_TEMPLATE, FRONTMATTER_END, FRONTMATTER_START, FlomoMemo,
  NOTE_CONTENT_TOKEN, NOTE_TAGS_TOKEN, UpdateMode, buildNewMemoFile,
  computeDesiredPaths, hierarchicalTags, normalizeTag, normalizeTagList, normalizeVaultPath,
  renderFileName, tagSelectionState, updateCascadingTagSelection,
  validateFileNameTemplate, validateNoteTemplate, validateVaultRelativePath } from './sync-core';

export const SAMPLE_MEMO: FlomoMemo = { slug: 'abcdef123456', content: '<p>第一条写作想法</p>',
  tags: [{ name: '写作' }, { name: '素材' }], created_at: '2026-09-01 08:09:10', updated_at: '2026-09-01 08:09:10' };
const TABS = [['connection', '连接与同步'], ['naming', '保存与命名'], ['scope', '同步范围'], ['yaml', '笔记模板'], ['safety', '更新与安全'], ['more', '更多']] as const;
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
type FundingUrls = Record<string, string>;

function validFundingUrls(value: unknown): FundingUrls {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => {
    const [label, address] = entry;
    if (!label.trim() || typeof address !== 'string') return false;
    try { return ['https:', 'http:'].includes(new URL(address).protocol); } catch { return false; }
  }));
}

export class FlomoSafeSyncSettingTab extends PluginSettingTab {
  activeTab: string = 'connection';
  draftFileMode: 'default' | 'custom';
  draftDefaultFileTemplate: string;
  draftFileTemplate: string;
  draftNoteTemplate: string;
  private busy = false;
  private suggestionId = 0;
  private selectedTrash = new Set<string>();
  private missingLocalMemos: MissingLocalMemo[] | null = null;
  private selectedMissingLocal = new Set<string>();
  private expandedScopeTags = new Set<string>();
  private scopeOnlySelected = false;
  private scopeSearch = '';
  private scopeAdvancedOpen = false;

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
  private async persist(): Promise<void> {
    const panel = this.containerEl.querySelector<HTMLFieldSetElement>('.flomo-panel');
    if (panel) panel.disabled = true;
    try { await this.plugin.saveSettingsAndMigrate(); }
    catch (error) { new Notice(`设置保存失败：${(error as Error).message}`); this.display(); throw error; }
    finally { if (panel) panel.disabled = this.busy || this.plugin.syncRunning; }
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
    const help = key === 'archiveFolder' ? description : `${description} 输入完成后按 Enter 或离开输入框，保存并自动迁移。`;
    const setting = new Setting(parent).setName(name).setDesc(help);
    setting.addText(text => {
      text.inputEl.addClass('flomo-wide'); text.inputEl.setAttribute('aria-label', name);
      this.suggestions(setting.settingEl, text.inputEl, this.folders());
      text.setValue(this.plugin.settings[key]);
      text.inputEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); text.inputEl.blur(); } });
      text.inputEl.addEventListener('change', async () => {
        const value = text.inputEl.value;
        const error = validateVaultRelativePath(value);
        if (error) { setting.setDesc(`未保存：${error}`); return; }
        this.plugin.settings[key] = normalizeVaultPath(value);
        try {
          await this.persist();
          const imageInput = this.containerEl.querySelector<HTMLInputElement>('[aria-label="图片保存目录"]');
          if (imageInput) imageInput.value = this.plugin.settings.imageFolder;
          setting.setDesc(this.plugin.settings.pendingFolderMigration ? '设置已保存；部分文件未迁移，请在“连接与同步”查看原因。' : `已保存。${help}`);
        } catch { /* persist already displayed the error and restored the saved value. */ }
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
      button.addEventListener('click', () => {
        this.activeTab = id; this.display();
        const active = this.containerEl.querySelector<HTMLButtonElement>(`#flomo-tab-${id}`);
        active?.focus(); active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      button.addEventListener('keydown', event => {
        const index = TABS.findIndex(([key]) => key === this.activeTab);
        const target = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
        if (target >= 0) {
          event.preventDefault(); this.activeTab = TABS[target][0]; this.display();
          const active = this.containerEl.querySelector<HTMLButtonElement>(`#flomo-tab-${this.activeTab}`);
          active?.focus(); active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
    }
    const panel = root.createEl('fieldset', { cls: 'flomo-panel', attr: { id: `flomo-panel-${this.activeTab}`, role: 'tabpanel', 'aria-labelledby': `flomo-tab-${this.activeTab}` } });
    panel.disabled = this.busy || this.plugin.syncRunning;
    if (this.activeTab === 'connection') this.connection(panel);
    if (this.activeTab === 'naming') this.naming(panel);
    if (this.activeTab === 'scope') this.scope(panel);
    if (this.activeTab === 'yaml') this.yaml(panel);
    if (this.activeTab === 'safety') this.safety(panel);
    if (this.activeTab === 'more') this.more(panel);
  }
  private more(parent: HTMLElement): void {
    parent.createEl('h3', { text: '更多' });
    const hero = parent.createDiv({ cls: 'flomo-more-hero' });
    hero.createEl('h3', { text: '支持开发者' });
    hero.createEl('p', { text: '如果 Flomo Safe Sync 对你有帮助，可以请开发者喝杯咖啡。' });
    const manifest = this.plugin.manifest as typeof this.plugin.manifest & { fundingUrl?: FundingUrls };
    const fundingUrls = validFundingUrls(manifest.fundingUrl);
    const grid = parent.createDiv({ cls: 'flomo-funding-grid' });
    for (const [label, address] of Object.entries(fundingUrls)) {
      const card = grid.createDiv({ cls: 'flomo-funding-card' });
      card.createEl('h3', { text: label });
      const image = card.createEl('img', { attr: { src: address, alt: label } });
      image.addEventListener('error', () => { card.createEl('p', { cls: 'flomo-feedback is-error', text: `${label}加载失败。` }); });
    }
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
    if (this.plugin.lastResult?.missingLocalCount) {
      new Setting(parent).setName(`本地文件缺失 ${this.plugin.lastResult.missingLocalCount} 条`)
        .setDesc('旧路径已经不存在。先检查是否移到了其他位置，再勾选真正缺失的笔记重新导入。')
        .addButton(button => button.setButtonText('检查缺失文件').onClick(() => {
          this.activeTab = 'safety';
          void this.action(() => this.checkMissingLocal());
        }));
    }
    if (this.plugin.lastErrors.length) {
      const errors = parent.createEl('details', { cls: 'flomo-feedback is-error' });
      errors.createEl('summary', { text: `待处理问题（${this.plugin.lastErrors.length}）` });
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
    box.createEl('p', { cls: 'flomo-muted', text: '父级标签采用级联选择：选中或取消父级时，会同时处理它的全部子级；部分子级被选中时，父级显示半选状态。' });
    const list = box.createDiv({ cls: 'flomo-tag-options', attr: { role: 'tree', 'aria-label': key === 'scopeTags' ? '同步范围标签层级' : '更新例外标签层级' } });
    const allTags = () => hierarchicalTags([...this.plugin.settings.availableFlomoTags, ...this.plugin.settings[key]]).map(item => item.tag);
    const setSubtree = async (tag: string, checked: boolean) => {
      this.plugin.settings[key] = updateCascadingTagSelection(allTags(), this.plugin.settings[key], tag, checked);
      await this.persist(); this.display();
    };
    const draw = () => {
      selected.empty(); list.empty();
      for (const tag of this.plugin.settings[key]) {
        selected.createEl('button', { text: `#${tag} ×`, cls: 'flomo-chip', attr: { 'aria-label': `移除标签 ${tag} 及其下级` } }).addEventListener('click', () => { void setSubtree(tag, false); });
      }
      const tree = hierarchicalTags([...this.plugin.settings.availableFlomoTags, ...this.plugin.settings[key]]);
      const treeTags = tree.map(item => item.tag);
      const available = tree
        .filter(item => item.tag.toLocaleLowerCase().includes(search.value.toLocaleLowerCase().replace(/^#/, '')));
      for (const { tag, depth } of available) {
        const label = list.createEl('label', { cls: 'flomo-tag-option', attr: { role: 'treeitem', 'aria-level': String(depth + 1), title: `完整标签：#${tag}` } });
        label.style.setProperty('--flomo-tag-depth', String(depth));
        const checkbox = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选择标签 #${tag}` } });
        const state = tagSelectionState(treeTags, this.plugin.settings[key], tag);
        checkbox.checked = state.checked; checkbox.indeterminate = state.indeterminate;
        checkbox.setAttribute('aria-checked', state.indeterminate ? 'mixed' : String(state.checked));
        if (state.indeterminate) checkbox.addClass('flomo-is-indeterminate');
        label.createSpan({ text: `#${tag}` });
        if (state.indeterminate) label.createSpan({ text: '部分选择', cls: 'flomo-partial-state' });
        checkbox.addEventListener('change', () => { void setSubtree(tag, checkbox.checked); });
      }
      if (!available.length) list.createEl('p', { cls: 'flomo-muted', text: '没有匹配标签，可以手动添加。' });
    };
    search.addEventListener('input', draw);
    const addTag = async () => { const tag = normalizeTag(search.value); if (tag) await setSubtree(tag, true); };
    add.addEventListener('click', () => { void addTag(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addTag(); } });
    draw();
  }
  private scopeTreeTags(): Array<{ tag: string; depth: number }> {
    const tags = normalizeTagList([
      ...this.plugin.settings.availableFlomoTags,
      ...this.plugin.settings.scopeTags,
      ...this.plugin.settings.tagFolderMappings.map(mapping => mapping.tag),
    ]);
    const withAncestors = new Set<string>();
    for (const tag of tags) {
      const segments = tag.split('/');
      for (let index = 1; index <= segments.length; index++) withAncestors.add(segments.slice(0, index).join('/'));
    }
    return hierarchicalTags([...withAncestors]);
  }
  private scopeTagIsSynchronized(tag: string): boolean {
    const selected = new Set(normalizeTagList(this.plugin.settings.scopeTags));
    return this.plugin.settings.scopeMode === 'include' ? selected.has(tag) : !selected.has(tag);
  }
  private renderMappingPriority(parent: HTMLElement): void {
    const mappings = this.plugin.settings.tagFolderMappings;
    if (!mappings.length) return;
    const details = parent.createEl('details', { cls: 'flomo-scope-advanced' });
    details.open = this.scopeAdvancedOpen;
    details.addEventListener('toggle', () => { this.scopeAdvancedOpen = details.open; });
    details.createEl('summary', { text: `高级设置 · 映射优先级（${mappings.length}）` });
    details.createEl('p', { cls: 'flomo-muted', text: '一条 memo 同时命中多个专属目录时，使用这里最靠前的映射。调整顺序后自动移动已有笔记。' });
    const list = details.createDiv({ cls: 'flomo-priority-list' });
    mappings.forEach((mapping, index) => {
      const tag = normalizeTag(mapping.tag);
      const row = list.createDiv({ cls: 'flomo-priority-row' });
      const label = row.createDiv();
      label.createEl('strong', { text: `${index + 1}. #${tag}` });
      label.createEl('span', { text: mapping.folder, cls: 'flomo-muted' });
      if (!this.scopeTagIsSynchronized(tag)) label.createEl('span', { text: '当前范围外，设置已保留', cls: 'flomo-muted' });
      const actions = row.createDiv({ cls: 'flomo-priority-actions' });
      for (const offset of [-1, 1]) {
        const action = offset === -1 ? '提高' : '降低';
        const button = actions.createEl('button', { text: offset === -1 ? '↑' : '↓', attr: { type: 'button', 'aria-label': `${action}标签 #${tag} 的映射优先级` } });
        button.disabled = index + offset < 0 || index + offset >= mappings.length;
        button.addEventListener('click', async () => {
          [mappings[index], mappings[index + offset]] = [mappings[index + offset], mappings[index]];
          this.scopeAdvancedOpen = true; await this.persist(); this.display();
        });
      }
      actions.createEl('button', { text: '使用默认目录', attr: { type: 'button', 'aria-label': `清除标签 #${tag} 的专属目录` } }).addEventListener('click', async () => {
        mappings.splice(index, 1); this.scopeAdvancedOpen = true; await this.persist(); this.display();
      });
    });
  }
  private renderScopeTree(parent: HTMLElement): void {
    const tree = this.scopeTreeTags();
    const treeTags = tree.map(item => item.tag);
    const selectedTags = normalizeTagList(this.plugin.settings.scopeTags);
    const selected = new Set(selectedTags);
    const mappings = this.plugin.settings.tagFolderMappings;
    const toolbar = parent.createDiv({ cls: 'flomo-scope-toolbar' });
    const inputRow = toolbar.createDiv({ cls: 'flomo-tag-input-row' });
    const search = inputRow.createEl('input', { cls: 'flomo-template-input', attr: { type: 'search', placeholder: '搜索或输入完整标签', 'aria-label': '搜索或添加同步范围标签' } });
    search.value = this.scopeSearch;
    const add = inputRow.createEl('button', { text: '添加标签', attr: { type: 'button' } });
    const only = inputRow.createEl('button', { text: this.scopeOnlySelected ? '显示全部' : this.plugin.settings.scopeMode === 'include' ? '仅看已选' : '仅看已排除',
      attr: { type: 'button', 'aria-pressed': String(this.scopeOnlySelected) } });
    toolbar.createEl('span', { cls: 'flomo-scope-summary', text: `${this.plugin.settings.scopeMode === 'include' ? '已选' : '已排除'} ${selectedTags.length} 个标签 · ${mappings.length} 个专属目录` });
    const list = parent.createDiv({ cls: 'flomo-scope-tree', attr: { role: 'treegrid', 'aria-label': '标签范围与保存目录' } });
    const header = list.createDiv({ cls: 'flomo-scope-tree-header', attr: { role: 'row' } });
    header.createSpan({ text: '标签', attr: { role: 'columnheader' } });
    header.createSpan({ text: '保存目录（留空＝默认）', attr: { role: 'columnheader' } });
    const draw = () => {
      list.querySelectorAll('.flomo-scope-row, .flomo-empty-state').forEach(element => element.remove());
      const query = this.scopeSearch.toLocaleLowerCase().replace(/^#/, '').trim();
      const matching = query ? treeTags.filter(tag => tag.toLocaleLowerCase().includes(query)) : treeTags;
      const selectedBranches = treeTags.filter(tag => selected.has(tag));
      const visible = tree.filter(({ tag }) => {
        const searchVisible = !query || matching.some(match => match === tag || match.startsWith(`${tag}/`));
        const selectionVisible = !this.scopeOnlySelected || selectedBranches.some(chosen => chosen === tag || chosen.startsWith(`${tag}/`));
        if (!searchVisible || !selectionVisible) return false;
        if (query || this.scopeOnlySelected) return true;
        const segments = tag.split('/');
        const ancestors = segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
        return ancestors.every(ancestor => !treeTags.includes(ancestor) || this.expandedScopeTags.has(ancestor));
      });
      for (const { tag, depth } of visible) {
        const hasChildren = treeTags.some(candidate => candidate.startsWith(`${tag}/`));
        const row = list.createDiv({ cls: 'flomo-scope-row', attr: { role: 'row', 'aria-level': String(depth + 1), title: `完整标签：#${tag}` } });
        row.style.setProperty('--flomo-tag-depth', String(depth));
        const tagCell = row.createDiv({ cls: 'flomo-scope-tag-cell', attr: { role: 'gridcell' } });
        if (hasChildren) {
          const expanded = !!query || this.scopeOnlySelected || this.expandedScopeTags.has(tag);
          const expand = tagCell.createEl('button', { text: expanded ? '▾' : '▸', cls: 'flomo-scope-expand', attr: { type: 'button', 'aria-label': `${expanded ? '折叠' : '展开'}标签 #${tag}`, 'aria-expanded': String(expanded) } });
          expand.addEventListener('click', () => {
            if (this.expandedScopeTags.has(tag)) this.expandedScopeTags.delete(tag); else this.expandedScopeTags.add(tag);
            draw();
          });
        } else tagCell.createSpan({ cls: 'flomo-scope-expand-spacer' });
        const checkbox = tagCell.createEl('input', { attr: { type: 'checkbox', 'aria-label': `${this.plugin.settings.scopeMode === 'include' ? '包括' : '排除'}标签 #${tag}` } });
        const state = tagSelectionState(treeTags, selectedTags, tag);
        checkbox.checked = state.checked; checkbox.indeterminate = state.indeterminate;
        checkbox.setAttribute('aria-checked', state.indeterminate ? 'mixed' : String(state.checked));
        tagCell.createSpan({ text: `#${tag.split('/').at(-1)}`, cls: 'flomo-scope-tag-label' });
        if (state.indeterminate) tagCell.createSpan({ text: '部分选择', cls: 'flomo-partial-state' });
        checkbox.addEventListener('change', async () => {
          this.plugin.settings.scopeTags = updateCascadingTagSelection(treeTags, selectedTags, tag, checkbox.checked);
          await this.persist(); this.display();
        });
        const folderCell = row.createDiv({ cls: 'flomo-scope-folder-cell', attr: { role: 'gridcell' } });
        const mappingIndex = mappings.findIndex(mapping => normalizeTag(mapping.tag) === tag);
        const mapping = mappingIndex >= 0 ? mappings[mappingIndex] : undefined;
        const folder = folderCell.createEl('input', { cls: 'flomo-scope-folder', attr: { type: 'text', placeholder: '默认目录', 'aria-label': `标签 #${tag} 的保存目录` } });
        folder.value = mapping?.folder || '';
        folder.disabled = !this.scopeTagIsSynchronized(tag);
        this.suggestions(folderCell, folder, this.folders());
        const status = folderCell.createSpan({ cls: 'flomo-scope-folder-status', attr: { role: 'status' } });
        if (folder.disabled) status.textContent = mapping ? '范围外 · 已保留' : '范围外';
        folder.addEventListener('change', async () => {
          const value = folder.value.trim();
          const currentIndex = mappings.findIndex(item => normalizeTag(item.tag) === tag);
          if (!value) {
            if (currentIndex >= 0) mappings.splice(currentIndex, 1);
            status.textContent = '使用默认目录'; await this.persist(); this.display(); return;
          }
          const error = validateVaultRelativePath(value);
          if (error) { status.textContent = `未保存：${error}`; status.addClass('is-error'); return; }
          const normalized = normalizeVaultPath(value);
          const current = currentIndex >= 0 ? mappings[currentIndex] : undefined;
          if (current) current.folder = normalized; else mappings.push({ tag, folder: normalized });
          folder.value = normalized; status.removeClass('is-error'); status.textContent = '已保存'; await this.persist(); this.display();
        });
      }
      if (!visible.length) list.createEl('p', { cls: 'flomo-empty-state', text: tree.length ? '没有符合当前筛选的标签。' : '尚无标签。连接 Flomo 后刷新，或在上方手动输入完整标签。' });
    };
    search.addEventListener('input', () => { this.scopeSearch = search.value; draw(); });
    const addTag = async () => {
      const tag = normalizeTag(search.value); if (!tag) return;
      const updatedTree = this.scopeTreeTags().map(item => item.tag);
      this.plugin.settings.scopeTags = updateCascadingTagSelection([...updatedTree, tag], this.plugin.settings.scopeTags, tag, true);
      this.scopeSearch = tag; await this.persist(); this.display();
    };
    add.addEventListener('click', () => { void addTag(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addTag(); } });
    only.addEventListener('click', () => { this.scopeOnlySelected = !this.scopeOnlySelected; this.display(); });
    draw();
  }
  private scope(parent: HTMLElement): void {
    parent.createEl('h3', { text: '标签范围与保存目录' });
    const modeDescription = this.plugin.settings.scopeMode === 'include'
      ? '命中任意所选标签才同步；未选择标签时不导入。'
      : '命中任意所选标签时跳过；未选择标签时同步全部，包括无标签内容。';
    new Setting(parent).setName('同步范围').setDesc(`${modeDescription} 退出范围的已有笔记原地保留。`)
      .addDropdown(dropdown => dropdown.addOption('include', '包括所选标签').addOption('exclude', '排除所选标签').setValue(this.plugin.settings.scopeMode).onChange(async value => {
        this.plugin.settings.scopeMode = value as 'include' | 'exclude'; await this.persist(); this.display();
      }))
      .addButton(button => button.setButtonText(`刷新标签（${this.plugin.settings.availableFlomoTags.length}）`).setDisabled(!this.plugin.settings.bearerToken)
        .onClick(() => this.action(() => this.plugin.refreshAvailableFlomoTags())));
    this.pathSetting(parent, '默认保存目录', 'rootFolder', '无标签或没有设置专属目录的 memo 保存在这里。');
    parent.createEl('p', { cls: 'flomo-muted', text: '勾选范围与专属目录放在同一棵标签树中。选择父级会级联全部子级；目录留空时使用默认保存目录。' });
    this.renderScopeTree(parent);
    this.renderMappingPriority(parent);
    parent.createEl('h3', { text: '图片与附件' });
    new Setting(parent).setName('图片本地化').setDesc('识别图床插件已替换的远程图片链接并记住映射，后续同步不再重新下载；下载失败时保留 Flomo 原链接。').addToggle(toggle => toggle.setValue(this.plugin.settings.localizeImages).onChange(async value => { this.plugin.settings.localizeImages = value; await this.persist(); }));
    this.pathSetting(parent, '图片保存目录', 'imageFolder', '目录下按 memo 编号分文件夹；修改后移动已记录的本地图片和附件，并更新链接。独立设置的图片目录不会跟随笔记目录改变。');
    new Setting(parent).setName('整理已有文件').setDesc('按当前目录设置移动范围内的已有笔记与附件，保留文件名、手写内容及图床链接。同名文件自动避让；已删除的文件请到“更新与安全”检查。')
      .addButton(button => button.setButtonText(this.plugin.settings.pendingFolderMigration ? '重试未完成的迁移' : '按当前目录整理').onClick(() => this.action(() => this.plugin.relocateExistingFiles())));
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
    this.missingLocalList(parent);
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
  private async checkMissingLocal(): Promise<void> {
    this.missingLocalMemos = await this.plugin.findMissingLocalMemos();
    const available = new Set(this.missingLocalMemos.filter(item => !item.blockedReason).map(item => item.slug));
    this.selectedMissingLocal = new Set([...this.selectedMissingLocal].filter(slug => available.has(slug)));
  }
  private missingLocalList(parent: HTMLElement): void {
    new Setting(parent).setName('本地缺失笔记').setDesc('修改保存目录会自动移动已有笔记和已记录的附件。如果文件已经删除，可检查后按当前目录设置重新导入。')
      .addButton(button => button.setButtonText('检查缺失文件').onClick(() => this.action(() => this.checkMissingLocal())));
    if (this.missingLocalMemos === null) return;
    const available = this.missingLocalMemos.filter(item => !item.blockedReason);
    const blocked = this.missingLocalMemos.filter(item => item.blockedReason);
    const allowed = new Set(available.map(item => item.slug));
    this.selectedMissingLocal = new Set([...this.selectedMissingLocal].filter(slug => allowed.has(slug)));
    const box = parent.createDiv({ cls: 'flomo-editor-card flomo-missing-local-list' });
    box.createEl('h4', { text: `可重新导入（${available.length}） · 需检查（${blocked.length}）` });
    box.createEl('p', { cls: 'flomo-muted', text: `使用当前默认目录“${this.plugin.settings.rootFolder}”和标签目录映射。重新导入前会读取完整 Flomo 快照，并重新核对范围和笔记身份。` });
    const selection = new Setting(box).setName(`已选 ${this.selectedMissingLocal.size} / ${available.length} 篇`);
    selection.settingEl.addClass('flomo-recovery-actions');
    selection.addButton(button => button.setButtonText('全选可导入').setDisabled(!available.length).onClick(() => {
      this.selectedMissingLocal = new Set(allowed); this.display();
    })).addButton(button => button.setButtonText('取消全选').onClick(() => {
      this.selectedMissingLocal.clear(); this.display();
    }));
    const execute = selection.controlEl.createEl('button', { text: `按当前目录重新导入所选 ${this.selectedMissingLocal.size} 篇`, cls: 'mod-cta' });
    execute.disabled = this.selectedMissingLocal.size === 0 || !this.plugin.settings.bearerToken;
    execute.addEventListener('click', () => {
      const selected = [...this.selectedMissingLocal];
      void this.action(async () => {
        await this.plugin.reimportMissingLocalMemos(selected);
        await this.checkMissingLocal();
      });
    });
    const candidates = box.createDiv({ cls: 'flomo-missing-candidates' });
    for (const memo of available) {
      const row = candidates.createEl('label', { cls: 'flomo-trash-row' });
      const checkbox = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选择重新导入 ${memo.fileName}` } });
      checkbox.checked = this.selectedMissingLocal.has(memo.slug);
      const info = row.createDiv();
      info.createEl('strong', { text: memo.fileName });
      info.createEl('div', { cls: 'flomo-muted', text: `原记录：${memo.filePaths.join('；')}` });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selectedMissingLocal.add(memo.slug); else this.selectedMissingLocal.delete(memo.slug);
        selection.setName(`已选 ${this.selectedMissingLocal.size} / ${available.length} 篇`);
        execute.disabled = this.selectedMissingLocal.size === 0 || !this.plugin.settings.bearerToken;
        execute.textContent = `按当前目录重新导入所选 ${this.selectedMissingLocal.size} 篇`;
      });
    }
    if (!available.length) box.createEl('p', { text: '没有发现可以重新导入的本地缺失笔记。' });
    if (blocked.length) {
      const problems = box.createEl('details', { cls: 'flomo-missing-blocked' });
      problems.createEl('summary', { text: `需检查（${blocked.length}）：已找到同编号笔记，禁止重复导入` });
      for (const memo of blocked) {
        const row = problems.createDiv({ cls: 'flomo-trash-row' });
        const info = row.createDiv();
        info.createEl('strong', { text: memo.fileName });
        info.createEl('div', { cls: 'flomo-muted', text: `原记录：${memo.filePaths.join('；')}` });
        info.createEl('div', { cls: 'flomo-feedback is-error', text: memo.blockedReason });
      }
    }
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
