import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const PORT = 19223;
const VAULT = '/private/tmp/flomo-safe-sync-qa-v030/vault';
const OUTPUT = '/private/tmp/flomo-safe-sync-qa-v030/evidence-v032';
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(target => target.title.startsWith('设置 - vault')) || targets.find(target => target.type === 'page' && target.url.includes('obsidian.md')) || targets.find(target => target.type === 'page');
if (!page) throw new Error('Isolated Obsidian page unavailable');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let id = 0; const pending = new Map();
socket.addEventListener('message', event => { const message = JSON.parse(event.data); const task = pending.get(message.id); if (!task) return; pending.delete(message.id); if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result); });
function send(method, params = {}) { return new Promise((resolve, reject) => {
  const next = ++id;
  const detail = method === 'Runtime.evaluate' ? String(params.expression || '').slice(0, 180) : '';
  const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method} ${detail}`)); }, 15000);
  pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id: next, method, params }));
}); }
async function evaluate(expression) { const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; }
try {
  const path = await evaluate('(globalThis.app || globalThis.opener?.app)?.vault?.adapter?.basePath');
  if (path !== VAULT) throw new Error(`Refusing UI actions outside isolated vault; observed ${path}`);
  if (process.argv[2] === 'inspect') {
    console.log(await evaluate('({path:(globalThis.app || globalThis.opener.app).vault.adapter.basePath,plugins:Object.keys((globalThis.app || globalThis.opener.app).plugins.plugins),text:document.body.innerText.slice(0,1500)})'));
  } else if (process.argv[2] === 'prepare') {
    await evaluate(`(globalThis.app || globalThis.opener.app).setting.open(); (globalThis.app || globalThis.opener.app).setting.openTabById('flomo-safe-sync'); true`);
  } else if (process.argv[2] === 'native') {
    const result = await evaluate(`(async () => {
      const A = globalThis.app || globalThis.opener.app;
      await A.plugins.loadManifests(); await A.plugins.enablePlugin('flomo-native-tests');
      const plugin = A.plugins.plugins['flomo-native-tests'];
      if (!plugin) throw new Error('Native test plugin did not load');
      const memo = await plugin.qaPrepare();
      const original = plugin.settings.syncedMemos[memo.slug].filePaths[0];
      const changed = { ...memo, content: '<p>Native updated</p>', updated_at: '2026-09-02 09:00:00' };
      const check = (value, message) => { if (!value) throw new Error(message); };
      let run = await plugin.qaSync([changed]); check(run.updatedCount === 1, 'native update failed: '+JSON.stringify(run));
      let text = await A.vault.adapter.read(original); check(text.includes('Native updated') && text.includes('Native handwritten'), 'native process lost content');
      plugin.settings.deletionAction = 'archive'; run = await plugin.qaSync([]); check(run.archivedCount === 1, 'native archive failed: '+JSON.stringify(run));
      const archived = plugin.settings.syncedMemos[memo.slug].filePaths[0]; check(archived.startsWith('NativeArchive/'), 'archive location');
      check(!await A.vault.adapter.exists(original), 'original should have moved');
      await A.plugins.disablePlugin('flomo-native-tests'); await A.plugins.enablePlugin('flomo-native-tests');
      const reloaded = A.plugins.plugins['flomo-native-tests']; run = await reloaded.qaSync([changed]); check(run.conflictCount === 0, 'native restore failed: '+JSON.stringify(run));
      check(reloaded.settings.syncedMemos[memo.slug].filePaths[0] === original, 'restore path');
      reloaded.settings.deletionAction = 'trash'; run = await reloaded.qaSync([]); check(run.pendingTrashCount === 1, 'native trash queue');
      check(await A.vault.adapter.exists(original), 'queue must not delete');
      const trash = await reloaded.qaTrash([original]); check(trash.moved === 1, 'native trash failed: '+JSON.stringify(trash));
      check(!await A.vault.adapter.exists(original), 'trash must move file');
      const listing = await A.vault.adapter.list('.trash'); check(listing.files.some(path => path.endsWith(original)), 'file not found in local trash');
      const hosted = await reloaded.qaImageHost(); check(hosted.assetErrors === 0 && hosted.localStillExists === false, 'hosted image was downloaded again: '+JSON.stringify(hosted));
      await A.plugins.disablePlugin('flomo-native-tests');
      return { original, archived, trash, hosted, retainedInTrash: listing.files.filter(path => path.endsWith(original)) };
    })()`);
    await fs.mkdir(OUTPUT, { recursive: true }); await fs.writeFile(`${OUTPUT}/native-results.json`, JSON.stringify(result, null, 2)); console.log(result);
  } else {
    await fs.mkdir(OUTPUT, { recursive: true });
    await evaluate(`(async () => { const A = globalThis.app || globalThis.opener.app; await A.plugins.disablePlugin('flomo-safe-sync'); await A.plugins.enablePlugin('flomo-safe-sync'); A.setting.openTabById('flomo-safe-sync'); })()`);
    const clickTab = async id => evaluate(`document.querySelector('#flomo-tab-${id}').click()`);
    const change = async (selector, value, event = 'input') => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing control'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`);
    const button = async text => evaluate(`(() => { const e=[...document.querySelectorAll('.flomo-panel button')].find(x=>x.textContent===${JSON.stringify(text)}); if(!e) throw new Error('Missing button'); e.click(); })()`);
    const waitSaved = async () => {
      for (let i=0;i<40;i++) { if(await evaluate(`document.querySelector('.flomo-feedback')?.textContent.includes('已保存')`)) return; await new Promise(r=>setTimeout(r,50)); }
      throw new Error('Settings save did not finish');
    };
    const screenshot = async name => { const value=await send('Page.captureScreenshot',{format:'png'}); await fs.writeFile(`${OUTPUT}/${name}.png`,Buffer.from(value.data,'base64')); };
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.flomo-tabs [role=tab]')].map(x=>x.textContent)`), ['连接与同步','保存与命名','同步范围','笔记模板','更新与安全']);
    await clickTab('naming'); await change('.flomo-panel select','custom','change');
    await change('[aria-label="自定义文件名模板"]','{{yyyy-MM-dd}}_{{HHmmss}}_{{title:6}}');
    await clickTab('scope'); await clickTab('naming'); assert.equal(await evaluate(`document.querySelector('[aria-label="自定义文件名模板"]').value`),'{{yyyy-MM-dd}}_{{HHmmss}}_{{title:6}}');
    await button('保存文件名设置'); await waitSaved();
    await change('[aria-label="自定义文件名模板"]','{{unknown}}'); await button('保存文件名设置');
    assert.equal(await evaluate(`(globalThis.app || globalThis.opener.app).plugins.plugins['flomo-safe-sync'].settings.fileNameTemplate`),'{{yyyy-MM-dd}}_{{HHmmss}}_{{title:6}}');
    await change('.flomo-panel select','default','change'); await button('保存文件名设置'); await waitSaved();
    assert.equal(await evaluate(`(globalThis.app || globalThis.opener.app).plugins.plugins['flomo-safe-sync'].settings.customFileNameTemplate`),'{{yyyy-MM-dd}}_{{HHmmss}}_{{title:6}}');
    await button('还原'); await change('.flomo-panel select','custom','change'); await button('保存文件名设置'); await waitSaved();
    assert.ok((await evaluate(`document.querySelector('.flomo-preview').textContent`)).includes('2026-09-01_080910'));
    assert.ok(await evaluate(`document.querySelector('details.flomo-variable-reference')?.open`));
    await screenshot('naming-light');
    await clickTab('yaml'); const note='---\n# flomo-sync:frontmatter:start\nflomo_slug: "{{slug}}"\nflomo_status: active\nflomo_sync_policy: managed\nflomo_created_at: "{{created_at}}"\nflomo_updated_at: "{{updated_at}}"\nflomo_last_synced_at: "{{synced_at}}"\n# flomo-sync:frontmatter:end\n{{flomo_tags}}\nsource: flomo\ncreated: "{{yyyy-MM-dd}}"\naliases: ["{{title}}"]\n---\n\n# {{title:8}}\n\n<!-- flomo-sync:content:start -->\n{{flomo_content}}\n<!-- flomo-sync:content:end -->\n\n## 我的补充\n\n';
    await change('#flomo-note-template-input',note); await clickTab('scope'); await clickTab('yaml'); assert.equal(await evaluate(`document.querySelector('#flomo-note-template-input').value`),note);
    assert.ok(await evaluate(`document.querySelector('.flomo-whole-note-preview')?.textContent.includes('# flomo-sync:frontmatter:start')`));
    assert.equal(await evaluate(`document.querySelectorAll('.flomo-preview-zone.is-managed').length`),2);
    assert.ok(await evaluate(`[...document.querySelectorAll('.flomo-preview-zone.is-editable')].some(x=>x.textContent.includes('source: flomo'))`));
    assert.ok(await evaluate(`document.querySelector('.flomo-whole-note-preview')?.textContent.includes('# 第一条写作想法')`));
    await button('保存笔记模板'); await waitSaved();
    await change('#flomo-note-template-input',note.replace('{{flomo_content}}','')); await button('保存笔记模板'); assert.equal(await evaluate(`(globalThis.app || globalThis.opener.app).plugins.plugins['flomo-safe-sync'].settings.noteTemplate`),note);
    await button('还原'); assert.equal(await evaluate(`document.querySelector('#flomo-note-template-input').value`),note);
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false}); await screenshot('yaml-light-wide');
    await evaluate(`document.body.classList.remove('theme-light');document.body.classList.add('theme-dark')`); await screenshot('yaml-dark-wide');
    await send('Emulation.setDeviceMetricsOverride',{width:560,height:850,deviceScaleFactor:1,mobile:false}); await screenshot('yaml-dark-narrow');
    const geometry=await evaluate(`(() => {const root=document.querySelector('.flomo-safe-sync-settings'),grid=document.querySelector('.flomo-yaml-grid'),cards=[...grid.children].map(x=>x.getBoundingClientRect());return {client:root.clientWidth,scroll:root.scrollWidth,stacked:cards[1].top>cards[0].top+20,columns:getComputedStyle(grid).gridTemplateColumns,tabsOverflow:document.querySelector('.flomo-tabs').scrollWidth>document.querySelector('.flomo-tabs').clientWidth};})()`);
    assert.ok(geometry.scroll<=geometry.client+2,JSON.stringify(geometry)); assert.ok(geometry.stacked,JSON.stringify(geometry)); assert.ok(geometry.tabsOverflow);
    await evaluate(`document.querySelector('#flomo-tab-yaml').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('.flomo-tabs [aria-selected=true]').textContent`),'更新与安全');
    await evaluate(`(() => { const e=[...document.querySelectorAll('.flomo-panel select')].find(x=>[...x.options].some(o=>o.value==='trash')); e.value='trash';e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await screenshot('safety-dark-narrow');
    await send('Emulation.clearDeviceMetricsOverride');
    await evaluate(`document.body.classList.remove('theme-dark');document.body.classList.add('theme-light')`);
    await evaluate(`(async()=>{const A=globalThis.app||globalThis.opener.app,p=A.plugins.plugins['flomo-safe-sync'];p.settings.noteTemplate='unsaved-memory-value';p.settings.customFileNameTemplate='unsaved-memory-value';await p.loadSettings();A.setting.openTabById('flomo-safe-sync');})()`);
    assert.equal(await evaluate(`(globalThis.app || globalThis.opener.app).plugins.plugins['flomo-safe-sync'].settings.noteTemplate`),note);
    assert.equal(await evaluate(`(globalThis.app || globalThis.opener.app).plugins.plugins['flomo-safe-sync'].settings.customFileNameTemplate`),'{{yyyy-MM-dd}}_{{HHmmss}}_{{title:6}}');
    const data=JSON.parse(await fs.readFile(`${VAULT}/.obsidian/plugins/flomo-safe-sync/data.json`,'utf8')); assert.equal(data.noteTemplate,note);
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
    await evaluate(`(async()=>{const A=globalThis.app||globalThis.opener.app,p=A.plugins.plugins['flomo-safe-sync'];p.settings.scopeMode='include';p.settings.scopeTags=['工作','工作/项目','工作/项目/甲'];p.settings.availableFlomoTags=['工作','工作/项目','工作/项目/甲','生活'];p.settings.tagFolderMappings=[];await p.saveSettings();A.setting.openTabById('flomo-safe-sync');})()`);
    await clickTab('scope');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.flomo-tag-options [role=treeitem]')].map(x=>[x.textContent.trim(),x.getAttribute('aria-level')])`), [['#工作','1'],['#工作/项目','2'],['#工作/项目/甲','3'],['#生活','1']]);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.flomo-mapping-row .setting-item-name')].map(x=>x.textContent)`), ['#工作','#工作/项目','#工作/项目/甲']);
    assert.ok(await evaluate(`[...document.querySelectorAll('.setting-item-name')].some(x=>x.textContent==='未映射标签的默认位置')`));
    await screenshot('scope-light');
    await clickTab('safety'); assert.ok(await evaluate(`document.querySelectorAll('.flomo-hierarchy-branch').length===2`)); await screenshot('safety-hierarchy-light');
    await clickTab('connection');
    const compact=await evaluate(`(()=>{const row=[...document.querySelectorAll('.setting-item')].find(x=>x.querySelector('.setting-item-name')?.textContent==='启动时同步'),a=row.querySelector('.setting-item-info').getBoundingClientRect(),b=row.querySelector('.setting-item-control').getBoundingClientRect();return {sameRow:Math.abs(a.top-b.top)<12,rowHeight:row.getBoundingClientRect().height};})()`);
    assert.ok(compact.sameRow);
    const result={obsidian:'1.13.7',version:'0.3.2',tabs:5,draftsRetained:true,invalidTemplatesRejected:true,defaultPreservesCustom:true,pluginReloadPersisted:true,hierarchicalTags:true,automaticMappings:true,completeNoteEditable:true,wholeNotePreview:true,compact,geometry};
    await fs.writeFile(`${OUTPUT}/ui-results.json`,JSON.stringify(result,null,2)); console.log(result);

  }
} finally { socket.close(); }
