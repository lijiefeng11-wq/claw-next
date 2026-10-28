// Run after building the client: CLAW_NEXT_CLIENT_ROOT points to apps/client;
// CLAW_NEXT_BACKEND_ROOT points to this checkout; CLAW_NEXT_PYTHON is Python 3.11+.
// Only MockPlatformAdapter and a disposable backend with synthetic shops are used.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {test} = require('node:test');
if (!process.env.CLAW_NEXT_CLIENT_ROOT || !process.env.CLAW_NEXT_BACKEND_ROOT) {
  throw new Error('Set CLAW_NEXT_CLIENT_ROOT and CLAW_NEXT_BACKEND_ROOT for the two checked-out implementations.');
}
const {startBackend, makeShop, waitFor, eventsOf, settle} = require(path.join(process.env.CLAW_NEXT_CLIENT_ROOT, 'dist/test/helpers.js'));

function candidate(type, key = 'synthetic-object') {
  return {type, key, observed_at: Date.now()/1000,
    ...(type !== 'video' ? {goods_title: '虚构商品'} : {}),
    ...(type !== 'goods_card' ? {name: '虚构内容'} : {})};
}

async function setup(t, rule, {enabled = true, mode = 'auto'} = {}) {
  const backend = await startBackend();
  t.after(() => backend.stop());
  await backend.settings('shop-a', enabled, [rule]);
  const h = await makeShop({backend, mode});
  assert.equal(h.mock.kind, 'mock');
  t.after(async () => {
    await h.rt.stop(false);
    const root = path.resolve(os.tmpdir()) + path.sep;
    const dir = path.resolve(h.dir);
    assert.ok(dir.startsWith(root) && path.basename(dir).startsWith('claw-next-client-'));
    fs.rmSync(dir, {recursive: true, force: true});
  });
  return {backend, ...h};
}

for (const type of ['instruction', 'goods_card', 'video']) {
  test(`actual backend + mock frontend: ${type} sends once and receipt is durable`, async t => {
    const h = await setup(t, {id: 'item', contains: '内容', send: {type}});
    assert.equal(h.rt.sendItemConfirmed(), true);
    h.mock.injectSendOptions('buyer', [candidate(type)]);
    h.mock.injectBuyerMessage({conversation_id: 'buyer', content: '请发内容'});
    await waitFor(() => eventsOf(h.rt).some(e => e.snapshot?.delivery.status === 'sent'), 'durable sent');
    assert.equal(h.mock.platformItemSends.length, 1);
    const [saved] = await h.backend.events('shop-a');
    assert.equal(saved.decision.action, 'send_item');
    assert.equal(saved.decision.item.type, type);
    assert.equal(saved.decision.text, undefined);
    assert.equal(saved.delivery.status, 'sent');
    await h.rt.refresh(); await settle(h.rt);
    assert.equal(h.mock.platformItemSends.length, 1);
  });
}

test('ambiguous candidates use the configured text, never an arbitrary item', async t => {
  const h = await setup(t, {id: 'item', contains: '内容', send: {type: 'video'}, reply: '请确认具体商品。'});
  h.mock.injectSendOptions('buyer', [candidate('video', 'one'), candidate('video', 'two')]);
  h.mock.injectBuyerMessage({conversation_id: 'buyer', content: '请发内容'});
  await waitFor(() => eventsOf(h.rt).some(e => e.snapshot?.delivery.status === 'sent'), 'text receipt');
  assert.equal(h.mock.platformItemSends.length, 0);
  const [saved] = await h.backend.events('shop-a');
  assert.equal(saved.decision.action, 'reply');
  assert.equal(saved.decision.text, '请确认具体商品。');
});

for (const mode of ['manual', 'disabled']) {
  test(`${mode}: accept data without platform send`, async t => {
    const h = await setup(t, {id: 'item', contains: '内容', send: {type: 'instruction'}},
      {enabled: mode !== 'disabled', mode: mode === 'manual' ? 'manual' : 'auto'});
    h.mock.injectSendOptions('buyer', [candidate('instruction')]);
    h.mock.injectBuyerMessage({conversation_id: 'buyer', content: '请发内容'});
    await waitFor(() => eventsOf(h.rt).some(e => e.snapshot?.state === 'ready'), 'ready');
    await settle(h.rt);
    const [saved] = await h.backend.events('shop-a');
    assert.equal(saved.delivery.status, 'unclaimed');
    assert.equal(h.mock.platformItemSends.length, 0);
    assert.equal(saved.decision.action, mode === 'manual' ? 'send_item' : 'none');
  });
}

test('unknown is permanent while a new buyer message can send a new item', async t => {
  const h = await setup(t, {id: 'item', contains: '内容', send: {type: 'video'}});
  h.mock.injectSendOptions('buyer', [candidate('video')]);
  h.mock.itemBehavior = 'ambiguous';
  h.mock.injectBuyerMessage({conversation_id: 'buyer', content: '请发内容'});
  await waitFor(() => eventsOf(h.rt).some(e => e.snapshot?.delivery.status === 'unknown'), 'unknown');
  const old = eventsOf(h.rt)[0].event_id;
  h.mock.itemBehavior = 'confirm';
  h.mock.injectBuyerMessage({conversation_id: 'buyer', content: '新问题：请发内容'});
  await waitFor(() => eventsOf(h.rt).some(e => e.event_id !== old && e.snapshot?.delivery.status === 'sent'), 'new message sent');
  const saved = await h.backend.events('shop-a');
  assert.equal(saved.find(e => e.event_id === old).delivery.status, 'unknown');
  assert.equal(h.mock.platformItemSends.length, 2);
});
