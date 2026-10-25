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

    // ---- channels detected automatically ----
    const ulx2 = await createFake(12205, { model: 'ULXD4' });
    r = await post('/api/receivers', { action: 'add', host: '127.0.0.1:12205' });
    ok(!r.j.ok && /not an SLX-D/.test(r.j.error), 'auto-add refuses a device that is not an SLX-D');
    r = await post('/api/receivers', { action: 'add', host: '127.0.0.1:12299' });
    ok(!r.j.ok && /Could not read the model/.test(r.j.error), 'auto-add explains when nothing answers');
    r = await post('/api/receivers', { action: 'add', host: '127.0.0.1:12202' });
    await sleep(1200); s = await get('/api/state');
    const id2 = s.receivers[0] && s.receivers[0].id;
    ok(r.j.ok && s.receivers.length === 1 && s.receivers[0].channels.length === 2 && s.receivers[0].name === 'Church Rack', 'auto-add: channels and name come from the receiver');
    await post('/api/receivers', { action: 'update', id: id2, channels: 1 });
    r = await post('/api/receivers', { action: 'update', id: id2, channels: 'auto' });
    await sleep(1200); s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].channels.length === 2, 'Detect puts the channel count back from the model');

    // ---- photos ----
    const jpg = (n) => 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, n, 2, 3, 4]).toString('base64');
    r = await post('/api/photo', { receiver: id2, channel: 1, data: 'data:text/plain;base64,AAAA' });
    ok(!r.j.ok, 'a picture that is not a JPEG is refused');
    r = await post('/api/photo', { receiver: id2, channel: 1, data: 'data:image/jpeg;base64,' + Buffer.from('not a picture').toString('base64') });
    ok(!r.j.ok, 'a JPEG-labelled file without JPEG data is refused');
    r = await post('/api/photo', { receiver: id2, channel: 1, data: 'data:image/jpeg;base64,' + 'A'.repeat(500000) });
    ok(r.status === 413, 'an oversized upload is refused');
    r = await post('/api/photo', { receiver: id2, channel: 1, data: jpg(1) });
    const photoA = r.j.id;
    s = await get('/api/state');
    const photoFile = (id) => path.join(path.dirname(cfgFile), 'photos', id + '.jpg');
    ok(r.j.ok && photoA && s.receivers[0].channels[0].photo === photoA && s.receivers[0].channels[1].photo === null && fs.existsSync(photoFile(photoA)), 'a channel photo is saved and shown on that channel only');
    const pr = await fetch(base + '/photos/' + photoA + '.jpg');
    ok(pr.status === 200 && pr.headers.get('content-type') === 'image/jpeg', 'the picture is served');
    ok((await fetch(base + '/photos/../config.json')).status === 404 && (await fetch(base + '/photos/zzzzzzzzzzzz.jpg')).status === 404, 'only real picture ids are served');

    // ---- presets ----
    r = await post('/api/presets', { action: 'save', receiver: id2, channel: 1 });
    s = await get('/api/state');
    const pA = s.presets[0];
    ok(r.j.ok && s.presets.length === 1 && pA.name === 'Pastor' && pA.gain === 12 && pA.output === 'MIC' && pA.freq === 606.025 && pA.photo === photoA, 'save a preset from a channel (name, gain, output, frequency, photo)');
    r = await post('/api/photo', { receiver: id2, channel: 1, data: null });
    s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].channels[0].photo === null && fs.existsSync(photoFile(photoA)), 'removing a channel photo keeps the picture a preset still uses');
    r = await post('/api/presets', { action: 'apply', id: pA.id, receiver: id2, channel: 2 });
    await sleep(500); s = await get('/api/state');
    ok(r.j.ok && slx.ch[1].name === 'Pastor' && slx.ch[1].gain === 30 && slx.ch[1].out === 'MIC' && slx.ch[1].freq === 606025, 'loading a preset sets name, gain, output level and frequency on the receiver');
    ok(s.receivers[0].channels[1].photo === photoA, 'loading a preset also sets the channel photo');
    r = await post('/api/presets', { action: 'save', receiver: id2, channel: 2, name: 'pastor' });
    s = await get('/api/state');
    ok(r.j.ok && s.presets.length === 1, 'saving under an existing name replaces that preset');
    r = await post('/api/presets', { action: 'create' });
    s = await get('/api/state');
    const pB = s.presets.find((p) => p.id !== pA.id);
    ok(r.j.ok && pB && pB.name === 'New mic' && pB.gain === 0, 'create a blank preset');
    r = await post('/api/presets', { action: 'update', id: pB.id, gain: 99 });
    ok(!r.j.ok, 'a preset gain outside -18 to +42 is refused');
    r = await post('/api/presets', { action: 'update', id: pB.id, name: 'Choir', gain: 5, output: 'LINE', freq: 607.5 });
    s = await get('/api/state');
    ok(r.j.ok && s.presets.find((p) => p.id === pB.id).freq === 607.5 && s.presets.find((p) => p.id === pB.id).output === 'LINE', 'edit a preset');
    r = await post('/api/presets', { action: 'update', id: pB.id, freq: '' });
    s = await get('/api/state');
    ok(r.j.ok && s.presets.find((p) => p.id === pB.id).freq === undefined, 'a blank frequency means leave the frequency alone');
    r = await post('/api/presets', { action: 'remove', id: pA.id });
    ok(r.j.ok && fs.existsSync(photoFile(photoA)), 'deleting a preset keeps a picture a channel still uses');
    r = await post('/api/photo', { receiver: id2, channel: 2, data: null });
    ok(r.j.ok && !fs.existsSync(photoFile(photoA)), 'a picture nothing uses any more is deleted');
    await post('/api/settings', { readOnly: true });
    r = await post('/api/presets', { action: 'apply', id: pB.id, receiver: id2, channel: 1 });
    ok(r.status === 403, 'read-only blocks loading a preset');
    await post('/api/settings', { readOnly: false });
    await stop(); await start();
    s = await get('/api/state');
    ok(s.presets.length === 1 && s.presets[0].name === 'Choir', 'presets survive a restart');
    // ---- identify, group/channel, device name, band, output level read-back ----
    const vr = await post('/api/receivers', { action: 'add', host: '127.0.0.1:12202' });
    await sleep(1200); s = await get('/api/state');
    const id3 = s.receivers[0].id;
    ok(s.receivers[0].band === 'G55' && s.receivers[0].deviceId === 'Church Rack', 'the receiver\'s RF band and device name are read');
    slx.log.length = 0;
    r = await post('/api/cmd', { receiver: id3, action: 'identify', value: true });
    await sleep(200);
    ok(r.j.ok && slx.log.includes('SET FLASH ON'), 'Identify sends SET FLASH ON');
    r = await post('/api/cmd', { receiver: id3, action: 'devname', value: 'Rack 1' });
    await sleep(500); s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].deviceId === 'Rack 1', 'the receiver\'s own name can be set');
    r = await post('/api/cmd', { receiver: id3, action: 'devname', value: '{}<>' });
    ok(!r.j.ok, 'a device name with only bad characters is refused');
    r = await post('/api/cmd', { receiver: id3, channel: 1, action: 'group', value: '6,100' });
    await sleep(500); s = await get('/api/state');
    ok(r.j.ok && slx.ch[0].group === '6,100' && s.receivers[0].channels[0].group === '6,100', 'group/channel is set and read back');
    r = await post('/api/cmd', { receiver: id3, channel: 1, action: 'group', value: 'abc' });
    ok(!r.j.ok, 'a bad group/channel is refused');
    slx.log.length = 0;
    r = await post('/api/cmd', { receiver: id3, channel: 2, action: 'output', value: 'MIC' });
    await sleep(500); s = await get('/api/state');
    ok(r.j.ok && s.receivers[0].channels[1].out === 'MIC' && slx.log.includes('GET 2 AUDIO_OUT_LVL_SWITCH'), 'output level change is read back from the receiver');
    r = await post('/api/receivers', { action: 'remove', id: id3 });

    // ---- update notice ----
    let served = '{"version":"99.0.0"}', code = 200;
    const gh = require('http').createServer((q, w) => { w.writeHead(code); w.end(served); });
    await new Promise((res) => gh.listen(18095, '127.0.0.1', res));
    const upSrv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CONFIG: path.join(dir, 'up', 'config.json'), PORT: '18096', LIVEMIC_UPDATE_URL: 'http://127.0.0.1:18095/package.json' }, stdio: 'ignore' });
    await sleep(1000);
    const upGet = async () => (await (await fetch('http://127.0.0.1:18096/api/state')).json()).update;
    const upCheck = async () => (await (await fetch('http://127.0.0.1:18096/api/update-check', { method: 'POST', body: '{}' })).json());
    r = await upCheck(); let u = await upGet();
    ok(r.ok && u.available && u.latest === '99.0.0' && /livemic:99\.0\.0$/.test(u.image), 'a newer version on GitHub is reported, with the image name to use');
    served = '{"version":"0.0.1"}'; await upCheck(); u = await upGet();
    ok(!u.available && !u.failed, 'an older or equal version is not an update');
    served = '{"version":"0.10.0"}'; await upCheck(); u = await upGet();
    ok(u.available, 'versions compare as numbers (0.10.0 is newer than 0.6.2)');
    served = 'not json'; r = await upCheck(); u = await upGet();
    ok(!r.ok && u.failed && u.latest === '0.10.0', 'a bad answer is reported and the last good answer is kept');
    code = 500; r = await upCheck();
    ok(!r.ok, 'a server error from GitHub is reported as a failed check');
    upSrv.kill(); gh.close();
    ulx2.server.close();
  } catch (e) { ok(false, 'test error: ' + e.stack); }
  srv.kill(); slx.server.close();
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})();
