'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFake } = require('./fake-slxd');
const Sim = require('../public/sim.js');

let failed = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(u)).json();
const post = async (u, body, pin) => {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...(pin ? { 'x-pin': pin } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json() };
};

(async () => {
  // validation
  ok(Sim.normalize('gain', 12).ok && !Sim.normalize('gain', 43).ok && !Sim.normalize('gain', 1.5).ok, 'gain validation');
  ok(Sim.normalize('name', ' A{b}<c> toolongname ').value === 'Abc tool', 'name sanitised to 8 chars');
  ok(Sim.normalize('freq', 606.025).value === 606025 && !Sim.normalize('freq', 50).ok, 'frequency validation');

  // real-protocol path against the fake receiver
  const fake = await createFake(12202);
  const cfgFile = path.join(os.tmpdir(), 'slxd-test-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ port: 18080, controlPin: '4321', meterMs: 100,
    receivers: [{ id: 'rx1', name: 'Test RX', host: '127.0.0.1', port: 12202, channels: 2 }] }));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CONFIG: cfgFile }, stdio: 'ignore' });
  await sleep(1500);
  try {
    const s = await get('http://127.0.0.1:18080/api/state');
    const rx = s.receivers[0], c1 = rx.channels[0], c2 = rx.channels[1];
    ok(rx.status === 'ok' && rx.model === 'SLXD4D' && rx.fw === '2.1.4', 'connects, reads model + firmware');
    ok(c1.name === 'Pastor' && c1.gain === 12 && c1.freq === 606.025 && c1.out === 'MIC', 'channel 1 name/gain/freq/output parsed (gain offset 18 removed)');
    ok(c1.battBars === 4 && c1.battMins === 312 && c1.txModel === 'SLXD2', 'battery + transmitter parsed');
    ok(c1.tx && c1.peak === -15 && c1.rms === -30 && c1.rssiA === -60 && c1.rssiB === -64 && c1.quality === 5, 'SAMPLE metering converted to dBFS / dBm');
    ok(c2.tx === false && c2.out === 'LINE' && c2.battBars === 1, 'channel 2 idle, line level, 1 battery bar');
    ok(s.pinRequired === true, 'PIN is required');

    let r = await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 1, action: 'gain', value: 20 });
    ok(r.status === 401, 'control rejected without PIN');
    r = await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 1, action: 'gain', value: 20 }, '4321');
    ok(r.j.ok, 'gain command accepted with PIN');
    await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 2, action: 'name', value: 'Lead' }, '4321');
    await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 1, action: 'output', value: 'LINE' }, '4321');
    await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 1, action: 'freq', value: 607.5 }, '4321');
    r = await post('http://127.0.0.1:18080/api/cmd', { receiver: 'rx1', channel: 1, action: 'gain', value: 99 }, '4321');
    ok(!r.j.ok, 'out-of-range gain refused');
    await sleep(500);
    ok(fake.log.includes('SET 1 AUDIO_GAIN 38'), 'wire command: SET 1 AUDIO_GAIN 38 (20 dB + 18 offset)');
    ok(fake.log.includes('SET 2 CHAN_NAME {Lead}'), 'wire command: SET 2 CHAN_NAME {Lead}');
    ok(fake.log.includes('SET 1 AUDIO_OUT_LVL_SWITCH LINE'), 'wire command: output level');
    ok(fake.log.includes('SET 1 FREQUENCY 0607500'), 'wire command: SET 1 FREQUENCY 0607500');
    const s2 = await get('http://127.0.0.1:18080/api/state');
    const d = s2.receivers[0].channels;
    ok(d[0].gain === 20 && d[1].name === 'Lead' && d[0].out === 'LINE' && d[0].freq === 607.5, 'receiver replies update the dashboard state');

    // SSE
    const ctl = new AbortController();
    const resp = await fetch('http://127.0.0.1:18080/events', { signal: ctl.signal });
    const rd = resp.body.getReader(); let txt = '';
    while (!txt.includes('"receivers"')) { const { value } = await rd.read(); txt += Buffer.from(value).toString(); }
    ctl.abort();
    ok(true, 'event stream delivers state');

    // receiver drops -> offline, then reconnects
    fake.server.close(); // stops new connections; existing socket still open
  } catch (e) { ok(false, 'test error: ' + e.message); }
  srv.kill(); fake.server.close();
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})();
