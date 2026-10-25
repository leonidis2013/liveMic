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
const https = require('https');
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
const METER_MS = Math.max(100, Number(cfg.meterMs) || 100);
const DEMO = args.includes('--demo') || cfg.demo === true;
const SCAN_PORT = Number(process.env.LIVEMIC_SCAN_PORT) || 2202;
const IN_DOCKER = fs.existsSync('/.dockerenv');
const photosDir = path.join(path.dirname(path.resolve(cfgPath)), 'photos');

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
    this.photos = conf.photos || {};
    this.model = ''; this.fw = ''; this.lock = ''; this.band = ''; this.devId = '';
    this.channels = [];
    for (let i = 1; i <= this.nCh; i++) {
      this.channels.push({
        ch: i, name: 'Ch ' + i, gain: 0, out: 'MIC', freq: 0, group: '', txModel: '',
        battBars: null, battMins: null, peak: -120, rms: -120, rssiA: -128, rssiB: -128,
        quality: 0, tx: false
      });
    }
    this.antAt = {}; this.badSample = false;
    this.sock = null; this.connected = false; this.everConnected = false; this.dead = false;
    this.lastData = 0; this.buf = ''; this.backoff = 1000;
    this.connect();
  }

  destroy() {
    this.dead = true;
    clearInterval(this.pollTimer); clearInterval(this.fastTimer); clearTimeout(this.reconnTimer);
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
      for (let n = 1; n <= this.nCh; n++) this.send(`< SET ${n} METER_RATE ${String(METER_MS).padStart(5, '0')} >`);   // in case the receiver wants it per channel
      this.pollTimer = setInterval(() => this.poll(), 30000);
      this.fastTimer = setInterval(() => {              // transmitter present? and signal per antenna
        for (let n = 1; n <= this.nCh; n++) { this.send(`< GET ${n} TX_MODEL >`); this.send(`< GET ${n} RSSI 0 >`); }
      }, 1500);
    });
    s.on('data', (d) => this.onData(d));
    s.on('timeout', () => s.destroy());     // nothing at all for 20 s: reconnect
    s.on('error', () => { /* handled by close */ });
    s.on('close', () => {
      if (this.connected && !this.dead) console.log(`[${this.name}] connection lost`);
      this.connected = false;
      clearInterval(this.pollTimer); clearInterval(this.fastTimer);
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
    ['MODEL', 'FW_VER', 'LOCK_STATUS', 'RF_BAND', 'DEVICE_ID'].forEach((k) => this.send(`< GET ${k} >`));
    this.send('< GET 0 ALL >');
    for (let c = 1; c <= this.nCh; c++) {
      ['CHAN_NAME', 'AUDIO_GAIN', 'AUDIO_OUT_LVL_SWITCH', 'GROUP_CHANNEL', 'FREQUENCY',
        'TX_MODEL', 'RSSI 0', 'TX_BATT_BARS', 'TX_BATT_MINS'].forEach((k) => this.send(`< GET ${c} ${k} >`));
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
    if (kind === 'ERR') {                              // the receiver refused or did not understand something: keep a note in the log
      this.errs = this.errs || new Set();
      if (this.errs.size < 10 && !this.errs.has(body)) { this.errs.add(body); console.log(`[${this.name}] receiver answered: < ERR ${body} >`); }
      return;
    }
    this.lastData = Date.now();
    const tok = body.match(/\{[^}]*\}|\S+/g) || [];
    if (!tok.length) return;

    if (kind === 'SAMPLE') {
      // SLX-D: < SAMPLE ch ALL peak rms rssi >   (each value minus 120 = dBFS / dBm)
      const c = this.chan(toInt(tok[0]));
      if (!c || tok[1] !== 'ALL' || tok.length < 5) {
        if (!this.badSample) { this.badSample = true; console.log(`[${this.name}] meter message in an unexpected format: < SAMPLE ${body} >`); }
        return;
      }
      c.peak = (toInt(tok[2]) ?? 0) - 120;
      c.rms = (toInt(tok[3]) ?? 0) - 120;
      const rssi = (toInt(tok[4]) ?? 0) - 120;
      if (Date.now() - (this.antAt[c.ch] || 0) > 4000) { c.rssiA = rssi; c.rssiB = rssi; }   // no per-antenna reading lately
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
      else if (key === 'RF_BAND') this.band = unbrace(val);
      else if (key === 'DEVICE_ID') this.devId = unbrace(val);
      return;
    }
    switch (key) {
      case 'CHAN_NAME': c.name = unbrace(val); break;
      case 'AUDIO_GAIN': { const n = toInt(val); if (n != null) c.gain = n - 18; break; }
      case 'AUDIO_OUT_LVL_SWITCH': c.out = unbrace(val).toUpperCase(); break;
      case 'FREQUENCY': { const n = toInt(val); if (n != null) c.freq = n / 1000; break; }
      case 'GROUP_CHANNEL': c.group = unbrace(val); break;
      case 'TX_MODEL': { c.txModel = unbrace(val).toUpperCase(); c.tx = !!c.txModel && c.txModel !== 'UNKNOWN'; break; }   // a transmitter is linked when the model is known
      case 'RSSI': {                                   // "1 083" = antenna 1, per-antenna signal strength
        const m = String(val).match(/^(\d)\s+(\d+)/);
        if (m) { const dbm = Number(m[2]) - 120; if (m[1] === '1') c.rssiA = dbm; else if (m[1] === '2') c.rssiB = dbm; this.antAt[c.ch] = Date.now(); }
        break;
      }
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
    else if (action === 'group') cmd = `< SET ${c.ch} GROUP_CHANNEL {${v.value}} >`;
    else return { ok: false, error: 'Unknown action' };
    this.send(cmd);
    // ask what the receiver ended up with, so the page shows the truth (it may refuse a change)
    const back = { output: ['AUDIO_OUT_LVL_SWITCH'], freq: ['FREQUENCY', 'GROUP_CHANNEL'], group: ['GROUP_CHANNEL', 'FREQUENCY'] }[action];
    if (back) back.forEach((k) => this.send(`< GET ${c.ch} ${k} >`));
    return { ok: true };
  }

  /** Receiver-wide actions: flash the front panel, or set the receiver's own Device ID. */
  deviceCommand(action, value) {
    if (!this.connected) return { ok: false, error: 'Receiver is not connected' };
    const v = Sim.normalize(action, value);
    if (!v.ok) return v;
    if (action === 'identify') this.send('< SET FLASH ON >');
    else if (action === 'devname') { this.send(`< SET DEVICE_ID {${v.value}} >`); this.send('< GET DEVICE_ID >'); }
    else return { ok: false, error: 'Unknown action' };
    return { ok: true };
  }

  snapshot() {
    const st = this.status();
    return {
      id: this.id, name: this.name, host: this.host + (this.port !== 2202 ? ':' + this.port : ''),
      model: this.model, fw: this.fw, lock: this.lock, band: this.band, deviceId: this.devId,
      status: st, online: st === 'ok',
      channels: this.channels.map((c) => Object.assign({}, c, { photo: this.photos[c.ch] || null }))
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
      cur.photos = conf.photos || {};
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
  base.inDocker = IN_DOCKER;
  base.update = { latest: upd.latest, available: !!upd.latest && newer(upd.latest, pkg.version), checkedAt: upd.checkedAt, failed: upd.failed, enabled: UPDATE_CHECK && !DEMO, image: IMAGE + ':' + upd.latest };
  base.presets = DEMO ? [] : (cfg.presets || []).map((p) => Object.assign({}, p));
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
  if (action === 'identify' || action === 'devname') return rx.deviceCommand(action, value);
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

/**
 * Save the change, then bring the live connections in step with it.
 * Adding without a channel count (or "auto") asks the receiver for its model and uses that.
 */
async function applyReceivers(body) {
  body = body || {};
  const auto = (body.action === 'add' && (body.channels === undefined || body.channels === 'auto')) ||
               (body.action === 'update' && body.channels === 'auto');
  if (auto) {
    let host, port;
    if (body.action === 'add') {
      const a = parseAddress(body.host);
      if (a.error) return { ok: false, error: a.error };
      host = a.host; port = a.port;
    } else {
      const rec = (cfg.receivers || []).find((r) => r.id === body.id);
      if (!rec) return { ok: false, error: 'Unknown receiver' };
      host = rec.host; port = rec.port || 2202;
    }
    const info = Discover.describe(await Discover.identify(host, port, 1500));
    if (info.kind === 'silent') return { ok: false, error: 'Could not read the model from that address, so the channels cannot be detected. Check the address and that Advanced Settings > Controller Access is set to Allow on the receiver, or choose the number of channels yourself.' };
    if (info.kind !== 'slxd') return { ok: false, error: 'That device is not an SLX-D receiver (' + (info.model || 'unknown model') + ')' };
    body = Object.assign({}, body, { channels: info.channels });
    if (body.action === 'add' && !String(body.name || '').trim() && info.deviceId) body.name = info.deviceId;
  }
  const r = changeReceivers(body);
  if (r.ok) { reconcile(); gcPhotos(); }
  return r;
}

// ---------- photos (one per channel, and one per preset) ----------
function gcPhotos() {                                  // delete picture files nothing refers to any more
  let files; try { files = fs.readdirSync(photosDir); } catch (e) { return; }
  const used = new Set();
  (cfg.receivers || []).forEach((r) => Object.keys(r.photos || {}).forEach((k) => used.add(r.photos[k])));
  (cfg.presets || []).forEach((p) => { if (p.photo) used.add(p.photo); });
  files.forEach((f) => {
    const m = /^([a-f0-9]{12})\.jpg$/.exec(f);
    if (m && !used.has(m[1])) { try { fs.unlinkSync(path.join(photosDir, f)); } catch (e) { /* leave it */ } }
  });
}

function storePhoto(data) {                            // data URL from the page (already resized to a small JPEG)
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return { error: 'That picture could not be read' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 300000) return { error: 'That picture is too large' };
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return { error: 'That is not a JPEG picture' };
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(photosDir, { recursive: true });
  fs.writeFileSync(path.join(photosDir, id + '.jpg'), buf);
  return { id };
}

/** { receiver, channel } or { preset }, plus data (a picture) or null (remove it). */
function setPhoto(body) {
  body = body || {};
  let id = null;
  if (body.data) {
    let st;
    try { st = storePhoto(body.data); } catch (e) { return { ok: false, status: 500, error: 'Could not save the picture (' + (e.code || e.message) + '). Is ' + photosDir + ' writable?' }; }
    if (st.error) return { ok: false, error: st.error };
    id = st.id;
  }
  const r = changeConfig((c) => {
    if (body.preset) {
      const p = (c.presets || []).find((x) => x.id === body.preset);
      if (!p) return 'Unknown preset';
      if (id) p.photo = id; else delete p.photo;
    } else {
      const rec = (c.receivers || []).find((x) => x.id === body.receiver);
      if (!rec) return 'Unknown receiver';
      const ch = Number(body.channel);
      if (!(ch >= 1 && ch <= 4)) return 'Unknown channel';
      rec.photos = rec.photos || {};
      if (id) rec.photos[ch] = id; else delete rec.photos[ch];
      if (!Object.keys(rec.photos).length) delete rec.photos;
    }
    return null;
  });
  if (!r.ok) { if (id) { try { fs.unlinkSync(path.join(photosDir, id + '.jpg')); } catch (e) { /* none */ } } return r; }
  reconcile(); gcPhotos();
  return { ok: true, id };
}

// ---------- presets: a saved mic (name, picture, gain, output level, frequency) ----------
const MAX_PRESETS = 100;
function presetFields(p, body) {                        // validate and copy the fields that are present
  if (body.name !== undefined) {
    const v = Sim.normalize('name', body.name); if (!v.ok) return v.error;
    p.name = v.value;
  }
  if (body.gain !== undefined) {
    const v = Sim.normalize('gain', body.gain); if (!v.ok) return v.error;
    p.gain = v.value;
  }
  if (body.output !== undefined) {
    const v = Sim.normalize('output', body.output); if (!v.ok) return v.error;
    p.output = v.value;
  }
  if (body.freq !== undefined) {                         // MHz; null or '' means "leave the frequency alone"
    if (body.freq === null || body.freq === '') delete p.freq;
    else { const v = Sim.normalize('freq', body.freq); if (!v.ok) return v.error; p.freq = v.value / 1000; }
  }
  return null;
}

function changePresets(body) {
  body = body || {};
  const { action } = body;
  if (action === 'create' || action === 'update') {
    return changeConfig((c) => {
      c.presets = Array.isArray(c.presets) ? c.presets : [];
      let p;
      if (action === 'create') {
        if (c.presets.length >= MAX_PRESETS) return 'That is the most presets you can keep (' + MAX_PRESETS + ')';
        p = { id: 'pr' + crypto.randomBytes(3).toString('hex'), name: 'New mic', gain: 0, output: 'MIC' };
      } else {
        p = c.presets.find((x) => x.id === body.id);
        if (!p) return 'Unknown preset';
      }
      const err = presetFields(p, body); if (err) return err;
      if (action === 'create') c.presets.push(p);
      return null;
    });
  }
  if (action === 'save') {                               // from what a channel is doing right now
    const rx = receivers.find((r) => r.id === body.receiver);
    const ch = rx && rx.chan(Number(body.channel));
    if (!ch) return { ok: false, error: 'Unknown channel' };
    if (!rx.connected || !rx.everConnected) return { ok: false, error: 'Receiver is not connected' };
    const name = body.name !== undefined ? body.name : ch.name;
    const nm = Sim.normalize('name', name); if (!nm.ok) return nm;
    const photo = rx.photos[ch.ch] || null;
    const r = changeConfig((c) => {
      c.presets = Array.isArray(c.presets) ? c.presets : [];
      let p = c.presets.find((x) => String(x.name).toLowerCase() === nm.value.toLowerCase());
      if (!p) {
        if (c.presets.length >= MAX_PRESETS) return 'That is the most presets you can keep (' + MAX_PRESETS + ')';
        p = { id: 'pr' + crypto.randomBytes(3).toString('hex') };
        c.presets.push(p);
      }
      p.name = nm.value; p.gain = ch.gain; p.output = ch.out === 'LINE' ? 'LINE' : 'MIC';
      if (ch.freq) p.freq = Math.round(ch.freq * 1000) / 1000; else delete p.freq;
      if (photo) p.photo = photo; else delete p.photo;
      return null;
    });
    if (r.ok) gcPhotos();
    return r;
  }
  if (action === 'remove') {
    const r = changeConfig((c) => {
      const n = (c.presets || []).length;
      c.presets = (c.presets || []).filter((x) => x.id !== body.id);
      return c.presets.length === n ? 'Unknown preset' : null;
    });
    if (r.ok) gcPhotos();
    return r;
  }
  if (action === 'apply') {                              // load onto a channel of a receiver
    if (cfg.readOnly) return { ok: false, status: 403, error: 'Dashboard is read-only' };
    const p = (cfg.presets || []).find((x) => x.id === body.id);
    if (!p) return { ok: false, error: 'Unknown preset' };
    const rx = receivers.find((r) => r.id === body.receiver);
    if (!rx || !rx.chan(Number(body.channel))) return { ok: false, error: 'Unknown channel' };
    if (!rx.connected) return { ok: false, error: 'Receiver is not connected' };
    const steps = [['name', p.name], ['gain', p.gain], ['output', p.output]];
    if (p.freq) steps.push(['freq', p.freq]);            // last: the transmitter drops until it is synced again
    for (const [a, v] of steps) { const n = Sim.normalize(a, v); if (!n.ok) return n; }
    for (const [a, v] of steps) { const r = rx.command(Number(body.channel), a, v); if (!r.ok) return r; }
    const ph = changeConfig((c) => {
      const rec = (c.receivers || []).find((x) => x.id === body.receiver);
      if (!rec) return null;
      rec.photos = rec.photos || {};
      if (p.photo) rec.photos[Number(body.channel)] = p.photo; else delete rec.photos[Number(body.channel)];
      if (!Object.keys(rec.photos).length) delete rec.photos;
      return null;
    });
    if (ph.ok) { reconcile(); gcPhotos(); }
    return { ok: true };
  }
  return { ok: false, error: 'Unknown action' };
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

// ---------- is there a newer version? (reads the version number from GitHub; changes nothing) ----------
const UPDATE_URL = process.env.LIVEMIC_UPDATE_URL || 'https://raw.githubusercontent.com/leonidis2013/LiveMic/main/package.json';
const UPDATE_CHECK = process.env.LIVEMIC_NO_UPDATE_CHECK !== '1';
const IMAGE = 'ghcr.io/leonidis2013/livemic';
let upd = { latest: '', checkedAt: 0, failed: false };

function newer(a, b) {                                  // is version a newer than b?  (major.minor.patch)
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function checkUpdate() {
  return new Promise((resolve) => {
    let done = false;
    const end = (latest) => {
      if (done) return; done = true;
      upd = latest ? { latest, checkedAt: Date.now(), failed: false } : { latest: upd.latest, checkedAt: Date.now(), failed: true };
      resolve(!!latest);
    };
    try {
      const lib = UPDATE_URL.startsWith('https:') ? https : http;
      const req = lib.get(UPDATE_URL, { timeout: 6000, headers: { 'user-agent': 'LiveMic/' + pkg.version } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return end(null); }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        res.on('end', () => {
          try { const v = String(JSON.parse(raw).version || ''); end(/^\d+\.\d+\.\d+$/.test(v) ? v : null); }
          catch (e) { end(null); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => end(null));
    } catch (e) { end(null); }
  });
}
if (UPDATE_CHECK && !DEMO) {
  setTimeout(checkUpdate, 3000).unref();
  setInterval(checkUpdate, 6 * 3600 * 1000).unref();
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

/** Read a JSON body, check the PIN, then hand it to fn(body) -> {ok, error, status, id} (or a promise of one). */
function postJson(req, res, fn, { needPin = true, limit = 4096 } = {}) {
  let raw = '', tooBig = false;
  req.on('data', (d) => { if (tooBig) return; raw += d; if (raw.length > limit) { tooBig = true; raw = ''; } });
  req.on('end', () => {
    if (needPin && !pinOk(req.headers['x-pin'])) {
      return setTimeout(() => json(res, 401, { ok: false, error: 'Wrong or missing PIN' }), 500);
    }
    if (tooBig) return json(res, 413, { ok: false, error: 'That is too large' });
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'Bad JSON' }); }
    Promise.resolve().then(() => fn(body)).then((r) => {
      r = r || { ok: false, error: 'Nothing happened' };
      json(res, r.ok ? 200 : (r.status || 400), { ok: r.ok, error: r.error, id: r.id });
    }).catch((e) => json(res, 500, { ok: false, error: 'Something went wrong: ' + e.message }));
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

  const pm = /^\/photos\/([a-f0-9]{12})\.jpg$/.exec(url);
  if (req.method === 'GET' && pm) {
    return fs.readFile(path.join(photosDir, pm[1] + '.jpg'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
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
  if (req.method === 'POST' && url === '/api/update-check') return postJson(req, res, () => (UPDATE_CHECK && !DEMO) ? checkUpdate().then((ok) => ({ ok, error: ok ? undefined : 'Could not reach GitHub to check. Is this machine online?' })) : { ok: false, error: 'Update checks are turned off' }, { needPin: false });
  if (req.method === 'POST' && url === '/api/presets') return postJson(req, res, (b) => DEMO ? demoMsg : changePresets(b));
  if (req.method === 'POST' && url === '/api/photo') return postJson(req, res, (b) => DEMO ? demoMsg : setPhoto(b), { limit: 400000 });
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
