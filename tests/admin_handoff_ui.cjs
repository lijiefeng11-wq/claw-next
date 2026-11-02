// Actual management functions; all DOM, credentials and HTTP responses are fictional.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false; this.checked = false; this.listeners = {};
    this.style = {}; this.options = []; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  replaceChildren(...items) { this.children = items; this.textContent = ''; }
  appendChild(item) { this.children.push(item); return item; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute() {} removeAttribute() {} focus() {} select() {}
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
}
const root = path.join(__dirname, '..');
let source = fs.readFileSync(path.join(root, 'backend/static/app.js'), 'utf8');
source = source.replace(/  if \(document.readyState === "loading"\) \{[\s\S]*?\n  \}\n\}\)\(\);\s*$/, `
  globalThis.fixture = { state, el, IDS, init, login, endSession, takeHandoffTicket,
    redeemHandoff, manageHandoff, loadHandoffGrants, clearHandoff, hideHandoffCode, applyRoute,
    stubOldDashboardLoading() { startShopPolling = function () {}; loadDashboard = async function () {}; } };
})();`);
assert.ok(source.includes('globalThis.fixture'));
const grant = { grant_id: 'a'.repeat(32), grant_token: 'G'.repeat(43), created_at: 1790000000, protocol_version: '1.0' };
const session = () => ({ role: 'admin', username: 'admin', session_token: 'S'.repeat(43),
  expires_at: Date.now() / 1000 + 3600, must_change_password: false, protocol_version: '1.0' });
const response = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
const failure = secret => response({ error: { code: secret, message: secret } }, 401);
function setup(hash = '', handler = async () => response({})) {
  const ids = {}, calls = [], location = { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '', hash };
  const document = { readyState: 'loading', getElementById: id => ids[id] ??= new Element(),
    createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {} };
  const storage = new Proxy({}, { get() { throw Error('No persistent browser storage permitted'); } });
  const window = { location, history: { replaceState(_a, _b, url) { location.hash = new URL(url, 'http://127.0.0.1').hash; } },
    setupAdminAssist() { return { reset() {}, sync() {} }; }, addEventListener() {}, setInterval() { return 1; },
    clearInterval() {}, scrollTo() {}, confirm() { return true; }, localStorage: storage, sessionStorage: storage };
  const context = { window, document, URL, Date, console: { log() { throw Error('No feature logging permitted'); } },
    setTimeout() { return 1; }, clearTimeout() {}, fetch: async (url, options) => {
      calls.push({ url, options, hash: location.hash }); return handler(url, options);
    } };
  vm.runInNewContext(source, context);
  const h = context.fixture; h.IDS.forEach(id => h.el[id] = document.getElementById(id));
  h.stubOldDashboardLoading();
  h.el.dashboard.hidden = true;
  return { h, ids, location, calls, window };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
(async () => {
  {
    const f = setup('#handoff=' + 'T'.repeat(43), async () => response(session()));
    f.h.init(); await tick();
    assert.equal(f.location.hash, ''); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].hash, ''); assert.equal(f.calls[0].url, '/api/v1/admin/handoff/redeem');
    assert.equal(f.calls[0].options.headers.Authorization, undefined);
    assert.equal(f.calls[0].options.redirect, 'error');
    assert.equal(f.h.state.token, 'S'.repeat(43)); assert.equal(f.ids.dashboard.hidden, false); passed++;
  }
  {
    const f = setup(); f.h.init(); await tick();
    assert.equal(f.calls.length, 0); assert.equal(f.h.state.token, null); passed++;
  }
  {
    const f = setup('#handoff=bad-secret'); f.h.init(); await tick();
    assert.equal(f.location.hash, ''); assert.equal(f.calls.length, 0);
    assert.match(f.ids['login-error'].textContent, /无效/); passed++;
  }
  {
    const f = setup('#handoff=' + 'T'.repeat(43));
    f.window.history.replaceState = () => { throw Error('fictional denial'); };
    f.h.init(); await tick(); assert.equal(f.calls.length, 0); assert.equal(f.h.state.token, null); passed++;
  }
  {
    const f = setup('#handoff=' + 'T'.repeat(43)); f.location.hostname = 'remote.invalid';
    f.h.init(); await tick(); assert.equal(f.calls.length, 0); assert.equal(f.location.hash, ''); passed++;
  }
  for (const [status, data] of [[401, { error: { code: grant.grant_token, message: grant.grant_token } }],
      [404, { error: { code: 'not_found' } }], [200, { ...session(), role: 'client' }],
      [200, { ...session(), expires_at: 'tomorrow' }], [200, { ...session(), must_change_password: true }]]) {
    const f = setup('#handoff=' + 'T'.repeat(43), async () => response(data, status));
    f.h.init(); await tick();
    assert.equal(f.h.state.token, null); assert.equal(f.ids.dashboard.hidden, true); assert.equal(f.calls.length, 1);
    assert.ok(!f.ids['login-notice'].textContent.includes(grant.grant_token)); passed++;
  }
  {
    let done; const f = setup('', () => new Promise(resolve => { done = resolve; }));
    const pending = f.h.redeemHandoff('T'.repeat(43)); f.h.endSession('manual cancellation');
    done(response(session())); await pending; assert.equal(f.h.state.token, null); passed++;
  }
  {
    const f = setup('', async (_url, options) => response(options.method === 'POST' ? grant
      : { grants: [{ grant_id: grant.grant_id, created_at: grant.created_at }], protocol_version: '1.0' }));
    Object.assign(f.h.state, { token: 'S'.repeat(43), route: 'system', me: { must_change_password: false } });
    await f.h.manageHandoff('create');
    assert.equal(f.ids['handoff-code'].value, grant.grant_token); assert.equal(f.ids['handoff-secret'].hidden, false);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.redirect, 'error');
    assert.ok(!JSON.stringify(f.ids['handoff-grants'].children).includes(grant.grant_token));
    f.h.applyRoute('dashboard'); assert.equal(f.ids['handoff-code'].value, ''); assert.equal(f.ids['handoff-secret'].hidden, true); passed++;
  }
  {
    let done; const f = setup('', () => new Promise(resolve => { done = resolve; }));
    Object.assign(f.h.state, { token: 'S'.repeat(43), route: 'system', me: { must_change_password: false } });
    const pending = f.h.manageHandoff('create'); f.h.applyRoute('dashboard');
    done(response(grant)); await pending;
    assert.equal(f.ids['handoff-code'].value, ''); assert.equal(f.calls.length, 1); passed++;
  }
  {
    const f = setup('', async () => failure(grant.grant_token));
    Object.assign(f.h.state, { token: 'S'.repeat(43), route: 'system', me: { must_change_password: false } });
    await f.h.manageHandoff('create');
    assert.equal(f.h.state.token, null); assert.equal(f.ids['handoff-code'].value, '');
    assert.ok(!f.ids['login-notice'].textContent.includes(grant.grant_token)); passed++;
  }
  {
    const f = setup('', async (_url, options) => response(options.method === 'DELETE'
      ? { ok: true, protocol_version: '1.0' } : { grants: [], protocol_version: '1.0' }));
    Object.assign(f.h.state, { token: 'S'.repeat(43), route: 'system', me: { must_change_password: false } });
    await f.h.manageHandoff('revoke', grant.grant_id);
    assert.equal(f.calls[0].url, '/api/v1/admin/handoff/grants/' + grant.grant_id);
    assert.equal(f.calls[0].options.method, 'DELETE'); assert.match(f.ids['handoff-status'].textContent, /已撤销/); passed++;
  }
  {
    const f = setup('', async () => response({ error: { code: grant.grant_token, message: grant.grant_token } }, 500));
    Object.assign(f.h.state, { token: 'S'.repeat(43), route: 'system', me: { must_change_password: false } });
    await f.h.manageHandoff('create');
    assert.ok(!f.ids['handoff-status'].textContent.includes(grant.grant_token));
    assert.match(f.ids['handoff-status'].textContent, /结果未确认/); assert.equal(f.calls.length, 1); passed++;
  }
  {
    const f = setup('', async () => response({ ...session(), must_change_password: true }));
    await f.h.login('admin', 'fictional-password');
    assert.equal(f.h.state.me.must_change_password, true); assert.equal(f.ids.dashboard.hidden, true);
    assert.equal(f.ids['account-panel'].open, true); passed++;
  }
  console.log(JSON.stringify({ passed, actualManagementCode: true, fictionalDomAndHttp: true, realCredentials: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
