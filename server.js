#!/usr/bin/env node
/*
 * LiveMic bridge
 * Talks to Shure SLX-D receivers over TCP (port 2202, Shure command strings)
 * and serves the dashboard + a live event stream to any browser on the network.
 * Receivers, PIN and read-only mode are all set up from the web page and saved
 * to the config file. No dependencies: needs Node 18 or newer.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require('./public/sim.js');
const Discover = require('./discover.js');
const pkg = require('./package.json');

// ---------- config (saved from the web page) ----------
const args = process.argv.slice(2);
let cfg = {};
const cfgPath = process.env.CONFIG || path.join(__dirname, 'config.json');
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(cfgPath + ' is not valid JSON: ' + e.message); process.exit(1); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.error(cfgPath + ' must hold a JSON object'); process.exit(1); }
} else {
  console.log('No config file at ' + cfgPath + ' yet. It is created when you add a receiver in the web page.');
}
const PORT = Number(process.env.PORT || cfg.port || 8080);
const METER_MS = Math.max(100, Number(cfg.meterMs) || 250);
const DEMO = args.includes('--demo') || cfg.demo === true;
const SCAN_PORT = Number(process.env.LIVEMIC_SCAN_PORT) || 2202;
const IN_DOCKER = fs.existsSync('/.dockerenv');

let configWritable = true;
function checkWritable() {
  let p = cfgPath;
  try { if (!fs.existsSync(p)) { p = path.dirname(p); while (!fs.existsSync(p) && p !== path.dirname(p)) p = path.dirname(p); } fs.accessSync(p, fs.constants.W_OK); configWritable = true; }
  catch (e) { configWritable = false; }
}
checkWritable();

function writeConfig(obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const tmp = cfgPath + '.tmp';
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, cfgPath); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } fs.writeFileSync(cfgPath, text); }   // e.g. the file itself is a mount
}
/** Change the config: mutator edits a copy, the copy is saved, then becomes live. */
function changeConfig(mutator) {
  const next = JSON.parse(JSON.stringify(cfg));
  try {
    const err = mutator(next);
    if (err) return { ok: false, error: err };
    writeConfig(next);
  } catch (e) {
    checkWritable();
    return { ok: false, status: 500, error: 'Could not save the settings (' + (e.code || e.message) + '). Is ' + cfgPath + ' writable?' };
  }
  cfg = next; checkWritable();
  return { ok: true };
}

// ---------- PIN (stored hashed; a plain "controlPin" typed into the file still works) ----------
const verified = new Set();           // sha256 of PINs that already passed, so dragging a fader doesn't re-hash each time
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pinSet = () => !!(cfg.controlPinHash || cfg.controlPin);
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function pinOk(given) {
  if (!pinSet()) return true;
  given = String(given == null ? '' : given);
  const key = sha(given);
  if (verified.has(key)) return true;
  let good = false;
  if (cfg.controlPinHash) {
    const [alg, salt, hash] = String(cfg.controlPinHash).split(':');
    if (alg === 'scrypt' && salt && hash) {
      const h = crypto.scryptSync(given, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
      good = h.length === b.length && crypto.timingSafeEqual(h, b);
    }
  } else {
    const a = Buffer.from(given), b = Buffer.from(String(cfg.controlPin));
    good = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (good) verified.add(key);
  return good;
}

// ---------- Shure command string parsing helpers ----------
const unbrace = (s) => String(s == null ? '' : s).replace(/^\{/, '').replace(/\}$/, '').trim();
const toInt = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };

class Receiver {
  constructor(conf) {
    this.id = conf.id;
    this.name = conf.name || conf.host;
    this.host = conf.host;
    this.port = conf.port || 2202;
    this.nCh = Math.max(1, Math.min(4, Number(conf.channels) || 2));
    this.model = ''; this.fw = ''; this.lock = '';
    this.channels = [];
    for (let i = 1; i <= this.nCh; i++) {
      this.channels.push({
        ch: i, name: 'Ch ' + i, gain: 0, out: 'MIC', freq: 0, group: '', txModel: '',
        battBars: null, battMins: null, peak: -120, rms: -120, rssiA: -128, rssiB: -128,
        quality: 0, tx: false
      });
    }
    this.sock = null; this.connected = false; this.everConnected = false; this.dead = false;
    this.lastData = 0; this.buf = ''; this.backoff = 1000;
    this.connect();
  }

  destroy() {
    this.dead = true;
    clearInterval(this.pollTimer); clearTimeout(this.reconnTimer);
    if (this.sock) this.sock.destroy();
  }

  status() {
    if (!this.connected) return this.everConnected ? 'offline' : 'connecting';
    if (Date.now() - this.lastData > 8000) return 'no-data';
    return 'ok';
  }

  connect() {
    if (this.dead) return;
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
      if (this.connected && !this.dead) console.log(`[${this.name}] connection lost`);
      this.connected = false;
      clearInterval(this.pollTimer);
      this.channels.forEach((c) => { c.tx = false; c.peak = -120; c.rms = -120; });
      if (this.dead) return;
      this.reconnTimer = setTimeout(() => this.connect(), this.backoff);
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
      id: this.id, name: this.name, host: this.host + (this.port !== 2202 ? ':' + this.port : ''),
      model: this.model, fw: this.fw, lock: this.lock,
      status: st, online: st === 'ok',
      channels: this.channels.map((c) => Object.assign({}, c))
    };
  }
}

// ---------- receivers: built from the config, kept in step with it ----------
let receivers = [];
let sim = null;

function reconcile() {
  const want = Array.isArray(cfg.receivers) ? cfg.receivers : [];
  const old = new Map(receivers.map((r) => [r.id, r]));
  const next = [];
  want.forEach((conf) => {
    const cur = old.get(conf.id);
    const port = conf.port || 2202, ch = Math.max(1, Math.min(4, Number(conf.channels) || 2));
    if (cur && cur.host === conf.host && cur.port === port && cur.nCh === ch) {
      cur.name = conf.name || conf.host;            // a rename keeps the connection
      next.push(cur); old.delete(conf.id);
    } else {
      next.push(new Receiver(conf));
    }
  });
  old.forEach((r) => r.destroy());                    // removed, or moved to another address
  receivers = next;
}

if (DEMO) {
  sim = Sim.create();
  setInterval(() => sim.tick(0.1), 100);
  console.log('Demo mode: showing simulated receivers.');
} else {
  reconcile();
  if (!receivers.length) console.log('No receivers yet. Open the dashboard and use Settings > Receivers to search for them.');
}

function snapshot() {
  const base = DEMO ? sim.snapshot() : { demo: false, receivers: receivers.map((r) => r.snapshot()) };
  base.version = pkg.version;
  base.canControl = !cfg.readOnly;
  base.readOnly = !!cfg.readOnly;
  base.pinRequired = pinSet();
  base.configurable = !DEMO;
  base.configWritable = configWritable;
  base.ts = Date.now();
  return base;
}

function runCommand(body) {
  if (cfg.readOnly) return { ok: false, status: 403, error: 'Dashboard is read-only' };
  const { receiver, channel, action, value } = body || {};
  if (DEMO) return sim.command(receiver, channel, action, value);
  const rx = receivers.find((r) => r.id === receiver);
  if (!rx) return { ok: false, error: 'Unknown receiver' };
  return rx.command(channel, action, value);
}

// ---------- changing receivers and settings from the web page ----------
const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>{}]/g, '').trim().slice(0, 24);

function parseAddress(input) {
  let s = String(input == null ? '' : input).trim(), port = 2202;
  const m = s.match(/^(.*?):(\d{1,5})$/);
  if (m) { s = m[1]; port = Number(m[2]); }
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(s)) return { error: 'Enter an IP address or host name, for example 192.168.1.51' };
  if (Discover.isIPv4(s) && !Discover.isPrivate(s)) return { error: 'Receivers must be on a private network address' };
  if (!(port >= 1 && port <= 65535)) return { error: 'That port is not valid' };
  return { host: s, port };
}

function changeReceivers(body) {
  const { action } = body || {};
  if (action === 'add' || action === 'update') {
    const adding = action === 'add';
    return changeConfig((c) => {
      c.receivers = Array.isArray(c.receivers) ? c.receivers : [];
      let rec;
      if (adding) {
        rec = { id: 'rx' + crypto.randomBytes(3).toString('hex'), name: '', host: '', channels: 2 };
      } else {
        rec = c.receivers.find((r) => r.id === body.id);
        if (!rec) return 'Unknown receiver';
      }
      if (body.name !== undefined) rec.name = cleanName(body.name);
      if (body.host !== undefined) {
        const a = parseAddress(body.host);
        if (a.error) return a.error;
        rec.host = a.host;
        if (a.port !== 2202) rec.port = a.port; else delete rec.port;
      }
      if (body.channels !== undefined) {
        const n = Number(body.channels);
        if (![1, 2, 4].includes(n)) return 'A receiver has 1, 2 or 4 channels';
        rec.channels = n;
      }
      if (!rec.host) return 'Enter the receiver\'s address';
      if (!rec.name) rec.name = rec.host;
      const dup = c.receivers.find((r) => r !== rec && r.host === rec.host && (r.port || 2202) === (rec.port || 2202));
      if (dup) return 'That receiver is already added (' + dup.name + ')';
      if (adding) c.receivers.push(rec);
      return null;
    });
  }
  if (action === 'remove') {
    return changeConfig((c) => {
      const n = (c.receivers || []).length;
      c.receivers = (c.receivers || []).filter((r) => r.id !== body.id);
      return c.receivers.length === n ? 'Unknown receiver' : null;
    });
  }
  return { ok: false, error: 'Unknown action' };
}

/** Save the change, then bring the live connections in step with it. */
function applyReceivers(body) {
  const r = changeReceivers(body);
  if (r.ok) reconcile();
  return r;
}

function changeSettings(body) {
  body = body || {};
  if (body.newPin !== undefined && body.newPin !== null && body.newPin !== '') {
    const p = String(body.newPin);
    if (p.length < 4 || p.length > 64) return { ok: false, error: 'A PIN needs at least 4 characters' };
  }
  const r = changeConfig((c) => {
    if (body.readOnly !== undefined) c.readOnly = !!body.readOnly;
    if (body.newPin !== undefined) {
      delete c.controlPin; delete c.controlPinHash;
      if (body.newPin !== null && body.newPin !== '') c.controlPinHash = hashPin(String(body.newPin));
    }
    return null;
  });
  if (r.ok && body.newPin !== undefined) verified.clear();
  return r;
}

// ---------- searching the network for receivers ----------
let scanState = { id: 0, running: false, total: 0, done: 0, found: [], range: '' };

function startScan(rangeText) {
  if (scanState.running) return { ok: false, error: 'A search is already running' };
  const r = Discover.parseRange(rangeText);
  if (r.error) return { ok: false, error: r.error };
  scanState = { id: scanState.id + 1, running: true, total: r.hosts.length, done: 0, found: [], range: r.label };
  Discover.scan(r.hosts, scanState, { port: SCAN_PORT }).catch(() => { scanState.running = false; });
  return { ok: true };
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sim.js': ['sim.js', 'text/javascript; charset=utf-8']
};
const clients = new Set();

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** Read a JSON body, check the PIN, then hand it to fn(body) -> {ok, error, status}. */
function postJson(req, res, fn, { needPin = true } = {}) {
  let raw = '';
  req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => {
    if (needPin && !pinOk(req.headers['x-pin'])) {
      return setTimeout(() => json(res, 401, { ok: false, error: 'Wrong or missing PIN' }), 500);
    }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'Bad JSON' }); }
    const r = fn(body) || { ok: false, error: 'Nothing happened' };
    json(res, r.ok ? 200 : (r.status || 400), { ok: r.ok, error: r.error });
  });
}

const demoMsg = { ok: false, error: 'Demo mode: these receivers are simulated. Start LiveMic without --demo to set up real ones.' };

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

  if (req.method === 'GET' && url === '/api/state') return json(res, 200, snapshot());

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

  if (req.method === 'GET' && url === '/api/discover') {
    const ranges = Discover.suggestRanges({ clientIp: req.socket.remoteAddress, includeInterfaces: !IN_DOCKER });
    return json(res, 200, Object.assign({}, scanState, { ranges }));
  }

  if (req.method === 'POST' && url === '/api/cmd') return postJson(req, res, runCommand);
  if (req.method === 'POST' && url === '/api/receivers') return postJson(req, res, (b) => DEMO ? demoMsg : applyReceivers(b));
  if (req.method === 'POST' && url === '/api/settings') return postJson(req, res, (b) => DEMO ? demoMsg : changeSettings(b));
  if (req.method === 'POST' && url === '/api/discover') {
    return postJson(req, res, (b) => {
      if (DEMO) return demoMsg;
      if (b.stop) { scanState.running = false; return { ok: true }; }
      return startScan(b.range);
    });
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
  if (!cfg.readOnly && !pinSet()) console.log('Note: anyone on this network can change settings. Set a control PIN in Settings to require one.');
});
