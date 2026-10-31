import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageExpression } from './image-dom.mjs';
import { patchSource, createConversationIdentity } from './patch.mjs';
import { modernFixture, Element } from './dom-fixture.mjs';

const root = process.env.CE_ORACLE_PACKAGE_ROOT;
if (!root) throw new Error('Run with CE_ORACLE_PACKAGE_ROOT and --import ./tools/oracle/register.mjs');
const images = await import(pathToFileURL(join(root, 'dist/src/browser/chatgptImages.js')).href);
function read(f, boundary = 0, conversation = 'synthetic-conversation') {
  return JSON.parse(JSON.stringify(vm.runInNewContext(imageExpression(boundary, conversation), { document: f.document, location: f.location, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, URL })));
}
test('observed modern nested user exchange admits completed blob with no assistant role', () => {
  const f = modernFixture();
  assert.equal(f.turn.getAttribute('data-message-author-role'), null);
  assert.equal(read(f)[0].width, 1254);
});
test('strict conversation, origin, and fresh turn boundary are mandatory', () => {
  const f = modernFixture();
  assert.deepEqual(read(f, 0, 'foreign'), []);
  assert.deepEqual(read(f, 1), []);
  assert.deepEqual(read(f, undefined, null), []);
  f.location.origin = 'https://chatgpt.com.attacker.example'; assert.deepEqual(read(f), []);
});
test('user attachments and earlier images are not generated outputs for latest request', () => {
  const f = modernFixture(); f.gallery.parentElement = f.user; f.user.children.push(f.gallery); f.complete.children = [f.user];
  assert.deepEqual(read(f), []);
  const g = modernFixture(); const next = new Element('div', { 'data-content-search-unit-key': 'fixture:1:user' });
  g.complete.children.push(next); next.parentElement = g.complete;
  assert.deepEqual(read(g), []);
});
test('streaming, stop control, unloaded, hidden and foreign image URLs fail closed', () => {
  for (const mutate of [
    f => { f.complete.attributes['data-talvt-turn-state'] = 'streaming'; },
    f => { f.image.complete = false; },
    f => { f.image.naturalWidth = 0; },
    f => { f.image.hidden = true; },
    f => { f.image.src = 'blob:https://other.example/image'; },
    f => { f.image.src = 'https://chatgpt.com/other-image'; },
    f => { const n = new Element('button', { 'data-testid': 'stop-button' }); f.main.children.push(n); n.parentElement = f.main; },
  ]) { const f = modernFixture(); mutate(f); assert.deepEqual(read(f), []); }
});
test('later concurrent request with its own completed image cannot satisfy earlier attempt', () => {
  const f = modernFixture(), later = modernFixture();
  later.turn.attributes['data-turn-key'] = 'later-exchange';
  later.user.attributes['data-chatgpt-search-unit-key'] = 'later:0:user';
  later.image.src = 'blob:https://chatgpt.com/later-completed-image';
  f.main.children.push(later.turn); later.turn.parentElement = f.main;
  assert.deepEqual(read(f), []);
  assert.equal(read(f,1)[0].url,'blob:https://chatgpt.com/later-completed-image');
});
test('legacy same-origin estuary image URL and localized alt remain admitted', () => {
  const f = modernFixture(); f.image.src = 'https://chatgpt.com/backend-api/estuary/content?id=file_synthetic';
  assert.equal(read(f).length, 1);
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function runtime(f, options = {}) {
  return { async evaluate({expression}) {
    if (expression.includes('const response = await fetch')) {
      options.onFetch?.();
      return { result: { value: { ok: true, b64: (options.bytes ?? png).toString('base64'), contentType: 'image/png', finalUrl: f.image.src } } };
    }
    return { result: { value: vm.runInNewContext(expression, { document: f.document, location: f.location, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, URL }) } };
  } };
}
test('patched installed collector waits for stable image, keeps ownership, writes validated bytes once', async () => {
  const f = modernFixture(), Runtime = runtime(f), dir = await mkdtemp(join(tmpdir(), 'oracle-patch-'));
  try {
    assert.deepEqual(await images.readAssistantGeneratedImages(Runtime, 0, 'synthetic-conversation'), []);
    await new Promise(r => setTimeout(r, 510));
    const result = await images.collectGeneratedImageArtifacts({ Runtime, minTurnIndex: 0, expectedConversationId: 'synthetic-conversation', outputPath: join(dir,'result.png'), answerText: '', Network: { getCookies() { throw Error('cookie export forbidden'); } } });
    assert.equal(result.imageCount, 1); assert.equal(result.savedImages.length, 1);
    assert.deepEqual(await readFile(join(dir,'result.png')), png);
    await assert.rejects(images.collectGeneratedImageArtifacts({ Runtime, minTurnIndex: 0, expectedConversationId: 'synthetic-conversation', outputPath: join(dir,'result.png'), answerText: '' }), /ORACLE_IMAGE_RESULT_UNKNOWN/);
  } finally { await rm(dir, { recursive: true }); }
});
test('download ownership change or non-image bytes leave no result and no retry', async () => {
  for (const mode of ['foreign-after-download','html']) {
    const f = modernFixture(), dir = await mkdtemp(join(tmpdir(), 'oracle-patch-'));
    let count = 0;
    const Runtime = runtime(f, { bytes: mode === 'html' ? Buffer.from('<html>not an image</html>') : png, onFetch() { count++; if (mode !== 'html') f.location.pathname='/c/foreign'; } });
    try {
      await images.readAssistantGeneratedImages(Runtime, 0, 'synthetic-conversation'); await new Promise(r=>setTimeout(r,510));
      await assert.rejects(images.collectGeneratedImageArtifacts({ Runtime, minTurnIndex: 0, expectedConversationId: 'synthetic-conversation', outputPath: join(dir,'result.png'), answerText: '' }), /ORACLE_IMAGE_RESULT_UNKNOWN/);
      await assert.rejects(stat(join(dir,'result.png')), {code:'ENOENT'}); assert.equal(count,1);
    } finally { await rm(dir,{recursive:true}); }
  }
});
test('missing collection identity and upstream drift fail closed', async () => {
  await assert.rejects(images.collectGeneratedImageArtifacts({ Runtime: {}, minTurnIndex:0 }), /OWNERSHIP_REQUIRED/);
  assert.throws(()=>patchSource('dist/src/browser/index.js','changed upstream'), /MISMATCH/);
});
test('first post-submit conversation stays frozen through monitor and snapshot changes', () => {
  const owner = createConversationIdentity();
  assert.equal(owner.observe('https://chatgpt.com/'),undefined);
  assert.throws(()=>owner.current('https://chatgpt.com/c/one'), /UNCONFIRMED/);
  assert.equal(owner.observe('https://chatgpt.com/c/one'),'one');
  assert.equal(owner.current('https://chatgpt.com/c/one'),'one');
  // Upstream monitor may swallow its persist callback error; the invalid state survives.
  try { owner.observe('https://chatgpt.com/c/foreign'); } catch {}
  assert.throws(()=>owner.current('https://chatgpt.com/c/foreign'), /CHANGED/);
  assert.throws(()=>owner.current('https://chatgpt.com/c/one'), /CHANGED/);
  const snapshot = createConversationIdentity(); snapshot.observe('https://chatgpt.com/c/one');
  assert.throws(()=>snapshot.current('https://chatgpt.com/c/other'), /CHANGED/);
});
function failedFixture(label = '图像生成失败', retry = '重试') {
  const f=modernFixture(), button=new Element('button'); button.textContent=retry;
  const card=new Element('div',{},[button]); card.childNodes=[{nodeType:3,textContent:label},button];
  f.complete.children=[f.user,card];card.parentElement=f.complete;f.card=card;f.retry=button;
  return f;
}
test('owned completed image failure surfaces as terminal code across serialized DOM and patched collector', async () => {
  for (const [label,retry,code] of [['图像生成失败','重试','CE_ORACLE_IMAGE_GENERATION_FAILED'],['Image generation failed','Retry','CE_ORACLE_IMAGE_GENERATION_FAILED'],['无法加载此回复','重试','CE_ORACLE_RESPONSE_UNAVAILABLE']]) {
    const f=failedFixture(label,retry);
    assert.equal(read(f).ceTerminalError,code);
    await assert.rejects(images.readAssistantGeneratedImages(runtime(f),0,'synthetic-conversation'),{code});
    await assert.rejects(images.collectGeneratedImageArtifacts({Runtime:runtime(f),minTurnIndex:0,expectedConversationId:'synthetic-conversation',outputPath:'/not-written.png'}),{code});
  }
});
test('failure words in user/quote/earlier/foreign/active/later requests are not terminal proof', () => {
  for(const mutate of [
    f=>{f.complete.attributes['data-talvt-turn-state']='streaming';},
    f=>{f.location.pathname='/c/foreign';},
    f=>{const stop=new Element('button',{'data-testid':'stop-button'});f.main.children.push(stop);stop.parentElement=f.main;},
    f=>{f.complete.children=[f.user];f.user.children.push(f.card);f.card.parentElement=f.user;},
    f=>{const quote=new Element('div',{},[f.card]);f.complete.children=[f.user,quote];quote.parentElement=f.complete;},
    f=>{f.complete.children=[f.card,f.user];},
    f=>{const later=new Element('div',{'data-content-search-unit-key':'later:user'});f.complete.children.push(later);later.parentElement=f.complete;},
    f=>{f.complete.children.push(f.gallery);f.gallery.parentElement=f.complete;f.image.complete=false;},
  ]) {const f=failedFixture();mutate(f);assert.deepEqual(read(f),[]);}
});
test('actual patched poll preserves terminal failure instead of swallowing it', async () => {
  const raw=await readFile(join(root,'dist/src/browser/index.js'),'utf8');
  const patched=patchSource('dist/src/browser/index.js',raw);
  const start=patched.indexOf('async function pollGeneratedImageOrTextAssistantResponse(');
  const end=patched.indexOf('export function isImageOnlyUiChromeText(',start);
  const f=failedFixture(), Runtime=runtime(f);
  const poll=vm.runInNewContext('('+patched.slice(start,end).trim()+')',{Date,readAssistantSnapshot:async()=>null,throwIfAssistantUiError(){},isGeneratedImageAssistantAnswer:()=>false,isImageOnlyUiChromeText:t=>!t,readAssistantGeneratedImages:images.readAssistantGeneratedImages,delay:async()=>{throw Error('should not keep polling');}});
  await assert.rejects(poll(Runtime,1000,0,'synthetic-conversation'),{code:'CE_ORACLE_IMAGE_GENERATION_FAILED'});
});
test('patched upstream URL monitor and collection getter cannot replace first submitted identity', async () => {
  const source=patchSource('dist/src/browser/index.js',await readFile(join(root,'dist/src/browser/index.js'),'utf8'));
  const persist=[...source.matchAll(/persistUrl: async \(url\) => \{([\s\S]*?)\n            \},/g)];
  const getter=[...source.matchAll(/const expectedConversationId = \(\) => ([^;]+);/g)];
  assert.equal(persist.length,2);assert.equal(getter.length,2);
  for(let i=0;i<2;i++) {
    const script=`let lastUrl='https://chatgpt.com/';const promptSubmitted=true;const ceConversation=createConversationIdentity();const emitRuntimeHint=async()=>{};const persist=async(url)=>{${persist[i][1]}};const expectedConversationId=()=>${getter[i][1]};({persist,expectedConversationId})`;
    const flow=vm.runInNewContext(script,{createConversationIdentity});
    await flow.persist('https://chatgpt.com/c/submitted');assert.equal(flow.expectedConversationId(),'submitted');
    await assert.rejects(flow.persist('https://chatgpt.com/c/foreign'),{code:'CE_ORACLE_CONVERSATION_CHANGED'});
    assert.throws(()=>flow.expectedConversationId(),{code:'CE_ORACLE_CONVERSATION_CHANGED'});
  }
});
