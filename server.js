#!/usr/bin/env node
/*
 * LiveMic bridge
 * Talks to Shure SLX-D receivers over TCP (port 2202, Shure command strings)
 * and serves the dashboard + a live event stream to any browser on the network.
 * No dependencies: needs Node 18 or newer.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require('./public/sim.js');
const pkg = require('./package.json');

// ---------- config ----------
const args = process.argv.slice(2);
let cfg = {};
const cfgPath = process.env.CONFIG || path.join(__dirname, 'config.json');
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(cfgPath + ' is not valid JSON: ' + e.message); process.exit(1); }
} else {
  console.log('No config file at ' + cfgPath + '.');
}
const PORT = Number(process.env.PORT || cfg.port || 8080);
const READ_ONLY = !!cfg.readOnly;
const PIN = cfg.controlPin ? String(cfg.controlPin) : '';
const METER_MS = Math.max(100, Number(cfg.meterMs) || 250);
const DEMO = args.includes('--demo') || cfg.demo === true || !(cfg.receivers && cfg.receivers.length);

// ---------- Shure command string parsing helpers ----------
const unbrace = (s) => String(s == null ? '' : s).replace(/^\{/, '').replace(/\}$/, '').trim();
const toInt = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };

class Receiver {
  constructor(conf) {
    this.id = conf.id || ('rx' + Math.random().toString(36).slice(2, 6));
    this.name = conf.name || conf.host;
    this.host = conf.host;
    this.port = conf.port || 2202;
    this.nCh = Math.max(1, Math.min(2, Number(conf.channels) || 2));
    this.model = ''; this.fw = ''; this.lock = '';
    this.channels = [];
    for (let i = 1; i <= this.nCh; i++) {
      this.channels.push({
        ch: i, name: 'Ch ' + i, gain: 0, out: 'MIC', freq: 0, group: '', txModel: '',
        battBars: null, battMins: null, peak: -120, rms: -120, rssiA: -128, rssiB: -128,
        quality: 0, tx: false
      });
    }
    this.sock = null; this.connected = false; this.everConnected = false;
    this.lastData = 0; this.buf = ''; this.backoff = 1000;
    this.connect();
  }

  status() {
    if (!this.connected) return this.everConnected ? 'offline' : 'connecting';
    if (Date.now() - this.lastData > 8000) return 'no-data';
    return 'ok';
  }

  connect() {
    const s = net.createConnection({ host: this.host, port: this.port });
    this.sock = s;
    s.setEncoding('ascii');
    s.setKeepAlive(true, 10000);
    s.setNoDelay(true);
    s.setTimeout(20000);
    s.on('connect', () => {
      this.connected = true; this.everConnected = true; this.buf = ''; this.backoff = 1000;
      this.lastData = 0;
      console.log(`[${this.name}] connected to ${this.host}:${this.port}`);
      this.poll();
      this.send(`< SET 0 METER_RATE ${String(METER_MS).padStart(5, '0')} >`);
      this.pollTimer = setInterval(() => this.poll(), 30000);
    });
    s.on('data', (d) => this.onData(d));
    s.on('timeout', () => s.destroy());     // nothing at all for 20 s: reconnect
    s.on('error', () => { /* handled by close */ });
    s.on('close', () => {
      if (this.connected) console.log(`[${this.name}] connection lost`);
      this.connected = false;
      clearInterval(this.pollTimer);
      this.channels.forEach((c) => { c.tx = false; c.peak = -120; c.rms = -120; });
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });
  }

  send(cmd) {
    if (this.sock && this.connected && this.sock.writable) this.sock.write(cmd);
  }

  poll() {
    ['MODEL', 'FW_VER', 'LOCK_STATUS'].forEach((k) => this.send(`< GET ${k} >`));
    this.send('< GET 0 ALL >');
    for (let c = 1; c <= this.nCh; c++) {
      ['CHAN_NAME', 'AUDIO_GAIN', 'AUDIO_OUT_LVL_SWITCH', 'GROUP_CHANNEL', 'FREQUENCY',
        'TX_MODEL', 'TX_BATT_BARS', 'TX_BATT_MINS'].forEach((k) => this.send(`< GET ${c} ${k} >`));
    }
  }

  onData(chunk) {
    this.buf += chunk;
    const re = /<\s*(REP|SAMPLE|ERR)\b((?:\{[^}]*\}|[^>{])*)>/g;
    let m, last = 0;
    while ((m = re.exec(this.buf))) { last = re.lastIndex; this.handle(m[1], m[2].trim()); }
    this.buf = this.buf.slice(last);
    if (this.buf.length > 8192) this.buf = this.buf.slice(-1024);
  }

  handle(kind, body) {
    if (kind === 'ERR') return;
    this.lastData = Date.now();
    const tok = body.match(/\{[^}]*\}|\S+/g) || [];
    if (!tok.length) return;

    if (kind === 'SAMPLE') {
      const c = this.chan(toInt(tok[0]));
      if (!c || tok[1] !== 'ALL' || tok.length < 11) return;
      const v = tok.slice(2);
      const q = toInt(v[0]);
      c.quality = (q == null || q > 5) ? 0 : q;
      c.peak = (toInt(v[2]) ?? 0) - 120;
      c.rms = (toInt(v[3]) ?? 0) - 120;
      c.rssiA = (toInt(v[6]) ?? 0) - 128;
      c.rssiB = (toInt(v[8]) ?? 0) - 128;
      c.tx = c.quality > 0;
      return;
    }

    // REP: either "<REP key value>" (device level) or "<REP ch key value>"
    let c = null;
    if (/^\d+$/.test(tok[0])) { c = this.chan(toInt(tok.shift())); }
    const key = (tok.shift() || '').toUpperCase();
    const val = tok.join(' ');
    if (!c) {
      if (key === 'MODEL') this.model = unbrace(val);
      else if (key === 'FW_VER') this.fw = unbrace(val);
      else if (key === 'LOCK_STATUS') this.lock = unbrace(val);
      return;
    }
    switch (key) {
      case 'CHAN_NAME': c.name = unbrace(val); break;
      case 'AUDIO_GAIN': { const n = toInt(val); if (n != null) c.gain = n - 18; break; }
      case 'AUDIO_OUT_LVL_SWITCH': c.out = unbrace(val).toUpperCase(); break;
      case 'FREQUENCY': { const n = toInt(val); if (n != null) c.freq = n / 1000; break; }
      case 'GROUP_CHANNEL': c.group = unbrace(val); break;
      case 'TX_MODEL': c.txModel = unbrace(val); break;
      case 'TX_BATT_BARS': { const n = toInt(val); c.battBars = (n == null || n > 5) ? null : n; break; }
      case 'TX_BATT_MINS': { const n = toInt(val); c.battMins = (n == null || n >= 65534) ? null : n; break; }
      default: break;
    }
  }

  chan(n) { return this.channels.find((c) => c.ch === n) || null; }

  /** Validated control request -> command string. */
  command(ch, action, value) {
    const c = this.chan(Number(ch));
    if (!c) return { ok: false, error: 'Unknown channel' };
    if (!this.connected) return { ok: false, error: 'Receiver is not connected' };
    const v = Sim.normalize(action, value);
    if (!v.ok) return v;
    let cmd;
    if (action === 'gain') cmd = `< SET ${c.ch} AUDIO_GAIN ${v.value + 18} >`;
    else if (action === 'name') cmd = `< SET ${c.ch} CHAN_NAME {${v.value}} >`;
    else if (action === 'output') cmd = `< SET ${c.ch} AUDIO_OUT_LVL_SWITCH ${v.value} >`;
    else if (action === 'freq') cmd = `< SET ${c.ch} FREQUENCY ${String(v.value).padStart(7, '0')} >`;
    else return { ok: false, error: 'Unknown action' };
    this.send(cmd);
    return { ok: true };
  }

  snapshot() {
    const st = this.status();
    return {
      id: this.id, name: this.name, host: this.host, model: this.model, fw: this.fw, lock: this.lock,
      status: st, online: st === 'ok',
      channels: this.channels.map((c) => Object.assign({}, c))
    };
  }
}

// ---------- state sources ----------
let receivers = [];
let sim = null;
if (DEMO) {
  sim = Sim.create();
  setInterval(() => sim.tick(0.1), 100);
  console.log('Demo mode: showing simulated receivers. Add receivers to config.json to go live.');
} else {
  receivers = cfg.receivers.map((r) => new Receiver(r));
}

function snapshot() {
  const base = DEMO ? sim.snapshot() : { demo: false, receivers: receivers.map((r) => r.snapshot()) };
  base.version = pkg.version;
  base.canControl = !READ_ONLY;
  base.pinRequired = !!PIN;
  base.ts = Date.now();
  return base;
}

function runCommand(body) {
  if (READ_ONLY) return { ok: false, status: 403, error: 'Dashboard is read-only' };
  const { receiver, channel, action, value } = body || {};
  if (DEMO) return sim.command(receiver, channel, action, value);
  const rx = receivers.find((r) => r.id === receiver);
  if (!rx) return { ok: false, error: 'Unknown receiver' };
  return rx.command(channel, action, value);
}

function pinOk(given) {
  if (!PIN) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sim.js': ['sim.js', 'text/javascript; charset=utf-8']
};
const clients = new Set();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && FILES[url]) {
    const [file, type] = FILES[url];
    return fs.readFile(path.join(PUBLIC, file), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Missing ' + file); }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(data);
    });
  }

  if (req.method === 'GET' && url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no'
    });
    res.write('retry: 1500\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url === '/api/cmd') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 2048) req.destroy(); });
    req.on('end', () => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!pinOk(req.headers['x-pin'])) {
        return setTimeout(() => reply(401, { ok: false, error: 'Wrong or missing PIN' }), 500);
      }
      let body;
      try { body = JSON.parse(raw); } catch (e) { return reply(400, { ok: false, error: 'Bad JSON' }); }
      const r = runCommand(body);
      reply(r.ok ? 200 : (r.status || 400), { ok: r.ok, error: r.error });
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

setInterval(() => {
  if (!clients.size) return;
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const c of clients) c.write(msg);
}, METER_MS);

// let `docker stop` / Ctrl-C end the process right away
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => process.exit(0)));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LiveMic v${pkg.version} on http://localhost:${PORT}`);
  if (!READ_ONLY && !PIN) console.log('Note: control is open to anyone on this network. Set "controlPin" in config.json to require a PIN.');
});
