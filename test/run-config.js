'use strict';
// Network search, and setting everything up from the web page (receivers, PIN, read-only).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createFake } = require('./fake-slxd');
const D = require('../discover.js');

let failed = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- range parsing ----
  ok(D.parseRange('192.168.1.0/24').hosts.length === 254, 'a /24 is 254 addresses');
  ok(D.parseRange('192.168.1.10-192.168.1.12').hosts.length === 3, 'start-end range');
  ok(!!D.parseRange('8.8.8.0/24').error, 'public ranges are refused');
  ok(!!D.parseRange('10.0.0.0/16').error, 'ranges over 1,024 addresses are refused');
  ok(D.channelsForModel('SLXD4D') === 2 && D.channelsForModel('SLXD4') === 1 && D.channelsForModel('SLXD4Q+') === 4, 'channels from model name');

  // ---- search finds an SLX-D, tells other things apart ----
  const slx = await createFake(12202), ulx = await createFake(12203, { model: 'ULXD4' });
  const silent = net.createServer(() => {}); await new Promise((r) => silent.listen(12204, '127.0.0.1', r));
  let st = {}; await D.scan(['127.0.0.1'], st, { port: 12202, answerMs: 800 });
  ok(st.found.length === 1 && st.found[0].kind === 'slxd' && st.found[0].model === 'SLXD4D' && st.found[0].channels === 2 && st.found[0].deviceId === 'Church Rack' && st.found[0].fw === '2.1.4', 'search: SLX-D identified (model, firmware, name, 2 channels)');
  st = {}; await D.scan(['127.0.0.1'], st, { port: 12203, answerMs: 800 });
  ok(st.found[0] && st.found[0].kind === 'other', 'search: a different Shure model is not offered as SLX-D');
  st = {}; await D.scan(['127.0.0.1'], st, { port: 12204, answerMs: 500 });
  ok(st.found[0] && st.found[0].kind === 'silent', 'search: open port with no reply is flagged');
  st = {}; await D.scan(['127.0.0.1'], st, { port: 12299, answerMs: 300 });
  ok(st.found.length === 0, 'search: nothing listening finds nothing');
  silent.close(); ulx.server.close();

  // ---- the server: set everything up from the web ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemic-'));
  const cfgFile = path.join(dir, 'data', 'config.json');          // folder does not exist yet
  const base = 'http://127.0.0.1:18090';
  let srv;
  const start = async () => { srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CONFIG: cfgFile, PORT: '18090', LIVEMIC_SCAN_PORT: '12202' }, stdio: 'ignore' }); await sleep(1200); };
  const stop = async () => { srv.kill(); await sleep(300); };
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body, pin) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(pin ? { 'x-pin': pin } : {}) }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const onDisk = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

  try {
    await start();
    let s = await get('/api/state');
    ok(!s.demo && s.configurable && s.receivers.length === 0 && !s.pinRequired, 'fresh start: live, no receivers, no PIN');

    // search through the API
    let r = await post('/api/discover', { range: '8.8.8.0/24' });
    ok(r.status === 400, 'API refuses a public range');
    r = await post('/api/discover', { range: '127.0.0.1' });
    ok(r.j.ok, 'API starts a search');
    let d; for (let i = 0; i < 30; i++) { await sleep(200); d = await get('/api/discover'); if (!d.running) break; }
    ok(!d.running && d.found.length === 1 && d.found[0].kind === 'slxd', 'API search result lists the SLX-D');

    // add, duplicate, bad address
    r = await post('/api/receivers', { action: 'add', name: 'Mic Rack', host: '127.0.0.1:12202', channels: 2 });
    ok(r.j.ok, 'add a receiver');
    r = await post('/api/receivers', { action: 'add', name: 'Again', host: '127.0.0.1:12202', channels: 2 });
    ok(!r.j.ok && /already added/.test(r.j.error), 'adding the same receiver twice is refused');
    r = await post('/api/receivers', { action: 'add', name: 'Bad', host: '8.8.8.8', channels: 2 });
    ok(!r.j.ok, 'a public address is refused');
    await sleep(1200);
    s = await get('/api/state');
    const id = s.receivers[0].id;
    ok(s.receivers.length === 1 && s.receivers[0].status === 'ok' && s.receivers[0].channels[0].name === 'Pastor', 'new receiver connects live, without a restart');
    ok(onDisk().receivers.length === 1 && onDisk().receivers[0].host === '127.0.0.1' && onDisk().receivers[0].port === 12202, 'saved to the config file (folder created)');

    // rename keeps the connection
    r = await post('/api/receivers', { action: 'update', id, name: 'Main Rack' });
    s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].name === 'Main Rack' && s.receivers[0].status === 'ok', 'rename keeps the connection');
    r = await post('/api/receivers', { action: 'update', id, channels: 1 });
    await sleep(1200); s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].channels.length === 1 && s.receivers[0].status === 'ok', 'changing channels reconnects with the new count');

    // PIN
    r = await post('/api/settings', { newPin: 'abc' });
    ok(!r.j.ok, 'a PIN under 4 characters is refused');
    r = await post('/api/settings', { newPin: '2468' });
    s = await get('/api/state');
    ok(r.j.ok && s.pinRequired, 'set a PIN from the web');
    const txt = fs.readFileSync(cfgFile, 'utf8');
    ok(/controlPinHash/.test(txt) && !/2468/.test(txt), 'PIN is stored hashed, not in plain text');
    r = await post('/api/receivers', { action: 'update', id, name: 'X' });
    ok(r.status === 401, 'changing receivers needs the PIN once one is set');
    r = await post('/api/receivers', { action: 'update', id, name: 'Main Rack' }, '2468');
    ok(r.j.ok, 'right PIN is accepted');
    r = await post('/api/settings', { newPin: '1357' }, '2468');
    ok(r.j.ok, 'change the PIN (needs the old one)');
    r = await post('/api/cmd', { receiver: id, channel: 1, action: 'gain', value: 10 }, '2468');
    ok(r.status === 401, 'old PIN stops working after a change');

    // read-only
    r = await post('/api/settings', { readOnly: true }, '1357');
    r = await post('/api/cmd', { receiver: id, channel: 1, action: 'gain', value: 10 }, '1357');
    s = await get('/api/state');
    ok(r.status === 403 && !s.canControl && s.readOnly, 'read-only blocks gain changes');
    await post('/api/settings', { readOnly: false }, '1357');

    // survives a restart
    await stop(); await start();
    s = await get('/api/state');
    ok(s.receivers.length === 1 && s.receivers[0].name === 'Main Rack' && s.pinRequired, 'receivers and PIN survive a restart');
    r = await post('/api/settings', { newPin: null }, '1357');
    s = await get('/api/state');
    ok(r.j.ok && !s.pinRequired && !/controlPin/.test(fs.readFileSync(cfgFile, 'utf8')), 'remove the PIN');

    // remove
    r = await post('/api/receivers', { action: 'remove', id });
    s = await get('/api/state');
    ok(r.j.ok && s.receivers.length === 0 && onDisk().receivers.length === 0, 'remove a receiver');
  } catch (e) { ok(false, 'test error: ' + e.stack); }
  srv.kill(); slx.server.close();
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})();
