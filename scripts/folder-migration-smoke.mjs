import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const VAULT = '/private/tmp/flomo-safe-sync-qa-v030/vault';
const OUTPUT = '/private/tmp/flomo-safe-sync-qa-v030/evidence-v0310';
const pluginDir = `${VAULT}/.obsidian/plugins/flomo-safe-sync`;
const targets = await (await fetch('http://127.0.0.1:19223/json/list')).json();
const page = targets.find(target => target.title.startsWith('设置 - vault'));
if (!page) throw new Error('Open the isolated settings first with node scripts/ui-smoke.mjs prepare');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let id = 0; const pending = new Map();
socket.addEventListener('message', event => {
  const response = JSON.parse(event.data), task = pending.get(response.id);
  if (!task) return; pending.delete(response.id);
  if (response.error) task.reject(new Error(JSON.stringify(response.error))); else task.resolve(response.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
const context = 'const A=globalThis.app||globalThis.opener.app,p=A.plugins.plugins["flomo-safe-sync"],n=A.plugins.plugins["flomo-native-tests"],D=globalThis.opener?.document||document;';
const run = code => evaluate(`(async()=>{${context}${code}})()`);
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) { if (await run(`return ${expression}`)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${expression}`);
}
async function change(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('!p.syncRunning');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function captureMain() {
  const main = targets.find(target => target.type === 'page' && target.id !== page.id);
  const connection = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(resolve => connection.addEventListener('open', resolve, { once: true }));
  const result = new Promise((resolve, reject) => connection.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id === 1) value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); }));
  connection.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  try { return await result; } finally { connection.close(); }
}
const results = { cases: [] };
let originalLinkPreference;
try {
  assert.equal(await evaluate('(globalThis.app||globalThis.opener?.app)?.vault?.adapter?.basePath'), VAULT);
  await fs.mkdir(OUTPUT, { recursive: true });
  const before = await fs.readFile(`${pluginDir}/data.json`);
  const backup = `${OUTPUT}/backup-${Date.now()}`; await fs.mkdir(backup);
  for (const file of ['main.js', 'manifest.json', 'styles.css', 'data.json']) await fs.copyFile(`${pluginDir}/${file}`, `${backup}/${file}`);
  await run("await A.plugins.disablePlugin('flomo-safe-sync');await A.plugins.disablePlugin('flomo-native-tests');");
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(file, `${pluginDir}/${file}`);
  assert.equal(hash(await fs.readFile(`${pluginDir}/data.json`)), hash(before));
  await run("await A.plugins.loadManifests();await A.plugins.enablePlugin('flomo-safe-sync');await A.plugins.enablePlugin('flomo-native-tests');");
  results.version = await run('return p.manifest.version'); assert.equal(results.version, '0.3.10');
  results.preservedInstallData = true;
  originalLinkPreference = await run('return A.vault.getConfig("alwaysUpdateLinks")');
  for (const autoLinks of [false, true]) {
    await run(`A.vault.setConfig('alwaysUpdateLinks',${autoLinks});globalThis.folderFixture=await n.qaFolderFixture();p.settings=globalThis.folderFixture.settings;await p.saveSettings();await p.loadSettings();A.setting.open();A.setting.openTabById('flomo-safe-sync');`);
    const fixture = await run('return globalThis.folderFixture');
    const imageHash = hash(await fs.readFile(`${VAULT}/${fixture.asset}`));
    await evaluate("document.querySelector('#flomo-tab-scope').click()");
    const input = '[aria-label="默认保存目录"]';
    await evaluate(`document.querySelector('${input}').focus();document.querySelector('${input}').select();`);
    await send('Input.insertText', { text: `${fixture.prefix}/Typing` });
    assert.equal(await run('return p.settings.rootFolder'), `${fixture.prefix}/Old`);
    assert.equal(await run(`return await A.vault.adapter.exists(${JSON.stringify(fixture.note)})`), true);
    await evaluate(`document.querySelector('${input}').select()`);
    await send('Input.insertText', { text: `${fixture.prefix}/Correct` });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`!p.syncRunning && p.settings.rootFolder===${JSON.stringify(`${fixture.prefix}/Correct`)}`);
    assert.deepEqual(await run('return p.lastErrors'), []);
    const moved = await run('return p.settings.syncedMemos[globalThis.folderFixture.slug]');
    assert.equal(moved.filePaths[0], `${fixture.prefix}/Correct/手写笔记.md`);
    assert.equal(moved.assetFolder, `${fixture.prefix}/Correct/_attachments/flomo/${fixture.slug}`);
    assert.equal(hash(await fs.readFile(`${VAULT}/${moved.assetMap[fixture.source]}`)), imageHash);
    assert.equal(await run(`return await A.vault.adapter.exists(${JSON.stringify(fixture.note)})`), false);
    assert.equal(await evaluate('document.querySelector(\'[aria-label="图片保存目录"]\').value'), `${fixture.prefix}/Correct/_attachments/flomo`);
    await change('[aria-label="标签 #写作 的保存目录"]', `${fixture.prefix}/Writing`);
    assert.equal(await run('return p.settings.syncedMemos[globalThis.folderFixture.slug].filePaths[0]'), `${fixture.prefix}/Writing/手写笔记.md`);
    await change('[aria-label="图片保存目录"]', `${fixture.prefix}/Pictures`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual(await run('return p.lastErrors'), []);
    const finalRecord = await run('return p.settings.syncedMemos[globalThis.folderFixture.slug]');
    assert.equal(hash(await fs.readFile(`${VAULT}/${finalRecord.assetMap[fixture.source]}`)), imageHash);
    const finalText = await fs.readFile(`${VAULT}/${finalRecord.filePaths[0]}`, 'utf8');
    assert.ok(finalText.includes('不能丢失的手写内容。'));
    assert.ok(!finalText.includes(`${fixture.prefix}/Old/`), finalText);
    const rendered = await run(`const f=A.vault.getAbstractFileByPath(${JSON.stringify(finalRecord.filePaths[0])});await A.workspace.getLeaf(false).openFile(f,{state:{mode:'preview'}});return f.path;`);
    assert.equal(rendered, finalRecord.filePaths[0]);
    await waitFor("D.querySelectorAll('.markdown-preview-view img').length>=2 && [...D.querySelectorAll('.markdown-preview-view img')].every(img=>img.complete&&img.naturalWidth>0)");
    results.cases.push({ autoLinks, note: finalRecord.filePaths[0], image: finalRecord.assetMap[fixture.source], renderedImages: await run("return D.querySelectorAll('.markdown-preview-view img').length"), imageHash, handwrittenPreserved: true, draftDoesNotMove: true });
    const shot = await captureMain(); await fs.writeFile(`${OUTPUT}/note-auto-links-${autoLinks}.png`, Buffer.from(shot.data, 'base64'));
    await run("await A.plugins.disablePlugin('flomo-safe-sync');await A.plugins.enablePlugin('flomo-safe-sync');");
    assert.deepEqual(await run('return p.settings.syncedMemos[globalThis.folderFixture.slug]'), finalRecord);
    await run("n.settings=p.settings;const f=globalThis.folderFixture;const result=await n.qaSync([{...f.memo,content:'<p>移动后的更新</p><img src=\"'+f.source+'\">',updated_at:'2026-09-03 08:00:00'}]);if(result.updatedCount!==1||result.assetErrorCount)throw new Error(JSON.stringify(result));");
  }
  await run("globalThis.folderFixture=await n.qaFolderFixture();p.settings=globalThis.folderFixture.settings;await p.saveSettings();await p.loadSettings();const f=A.vault.getAbstractFileByPath(globalThis.folderFixture.note);await A.fileManager.processFrontMatter(f,metadata=>{metadata.handwritten='保留';});p.settings.rootFolder=globalThis.folderFixture.prefix+'/Properties';await p.saveSettingsAndMigrate();");
  assert.deepEqual(await run('return p.lastErrors'), []);
  results.propertiesEditorMigration = await run('const record=p.settings.syncedMemos[globalThis.folderFixture.slug];const text=await A.vault.adapter.read(record.filePaths[0]);return {path:record.filePaths[0],commentsRemoved:!text.includes("# flomo-sync:frontmatter:start"),handwrittenPreserved:text.includes("不能丢失的手写内容。")};');
  assert.ok(results.propertiesEditorMigration.commentsRemoved && results.propertiesEditorMigration.handwrittenPreserved);
  await run("globalThis.folderFixture=await n.qaFolderFixture();p.settings=globalThis.folderFixture.settings;await p.saveSettings();await p.loadSettings();const rename=A.vault.rename;A.vault.rename=async function(file,path){if(file.path===globalThis.folderFixture.asset)throw new Error('Native injected interruption');return rename.call(this,file,path);};try{p.settings.rootFolder=globalThis.folderFixture.prefix+'/Resumed';await p.saveSettingsAndMigrate();}finally{A.vault.rename=rename;}if(!p.settings.pendingFolderMigration?.current)throw new Error('Native interruption was not recorded');await A.plugins.disablePlugin('flomo-safe-sync');await A.plugins.enablePlugin('flomo-safe-sync');");
  await waitFor('!p.syncRunning && !p.settings.pendingFolderMigration');
  assert.deepEqual(await run('return p.lastErrors'), []);
  results.automaticResume = await run('const record=p.settings.syncedMemos[globalThis.folderFixture.slug];const text=await A.vault.adapter.read(record.filePaths[0]);return {path:record.filePaths[0],image:record.assetMap[globalThis.folderFixture.source],imageExists:await A.vault.adapter.exists(record.assetMap[globalThis.folderFixture.source]),linksRepaired:!text.includes(globalThis.folderFixture.prefix+"/Old/")};');
  assert.ok(results.automaticResume.imageExists && results.automaticResume.linksRepaired);
  await run("A.setting.open();A.setting.openTabById('flomo-safe-sync');");
  await evaluate("document.querySelector('#flomo-tab-scope').click()");
  await waitFor("!document.querySelector('.notice-container .notice')");
  await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 850, deviceScaleFactor: 1, mobile: false });
  results.narrow = await evaluate("(()=>{const e=document.querySelector('.flomo-safe-sync-settings');return {client:e.clientWidth,scroll:e.scrollWidth};})()");
  assert.ok(results.narrow.scroll <= results.narrow.client + 2);
  const shot = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(`${OUTPUT}/settings-narrow.png`, Buffer.from(shot.data, 'base64'));
  await fs.writeFile(`${OUTPUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (originalLinkPreference !== undefined) await run(`A.vault.setConfig('alwaysUpdateLinks',${JSON.stringify(originalLinkPreference)});`);
  await send('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
