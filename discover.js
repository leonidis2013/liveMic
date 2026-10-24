/*
 * Network search for Shure receivers.
 *
 * Shure receivers answer command strings on TCP port 2202. The search tries that
 * port on every address in a private range, then asks each device that answers
 * for its model, firmware and device name.
 * No dependencies.
 */
'use strict';

const net = require('net');
const os = require('os');

const MAX_HOSTS = 1024;                 // a /22

const ipToInt = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);

/** Private, link-local or loopback: the only places a receiver (or a scan) may point. */
function isPrivate(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * "192.168.1.0/24", "192.168.1.50" or "192.168.1.10-192.168.1.40" -> { hosts, label }
 * Refuses public addresses and anything over 1024 addresses.
 */
function parseRange(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { error: 'Enter an address range, for example 192.168.1.0/24' };
  let lo, hi, label;
  let m;
  if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/))) {
    if (!isIPv4(m[1])) return { error: 'That is not a valid address' };
    const bits = Number(m[2]);
    if (bits < 22 || bits > 32) return { error: 'Use a range of /22 (1,024 addresses) or smaller, for example /24' };
    const size = 2 ** (32 - bits);
    const base = Math.floor(ipToInt(m[1]) / size) * size;
    lo = base; hi = base + size - 1;
    if (bits <= 30) { lo += 1; hi -= 1; }          // skip network and broadcast
    label = intToIp(base) + '/' + bits;
  } else if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/))) {
    if (!isIPv4(m[1]) || !isIPv4(m[2])) return { error: 'That is not a valid address' };
    lo = ipToInt(m[1]); hi = ipToInt(m[2]); label = m[1] + '-' + m[2];
  } else if (isIPv4(s)) {
    lo = hi = ipToInt(s); label = s;
  } else {
    return { error: 'Use a range like 192.168.1.0/24' };
  }
  if (hi < lo) return { error: 'The range ends before it starts' };
  if (hi - lo + 1 > MAX_HOSTS) return { error: 'That range is too large (at most 1,024 addresses)' };
  if (!isPrivate(intToIp(lo)) || !isPrivate(intToIp(hi))) return { error: 'Only private network addresses can be searched (10.x, 172.16-31.x, 192.168.x)' };
  const hosts = [];
  for (let n = lo; n <= hi; n++) hosts.push(intToIp(n));
  return { hosts, label };
}

/** /24 around an address, as "a.b.c.0/24". */
const cidr24 = (ip) => ip.split('.').slice(0, 3).join('.') + '.0/24';

/** Ranges worth offering: this machine's own networks, then the browser's. */
function suggestRanges({ clientIp, includeInterfaces = true } = {}) {
  const out = [];
  const add = (r) => { if (r && !out.includes(r)) out.push(r); };
  const ip4 = (a) => String(a || '').replace(/^::ffff:/, '');
  const c = ip4(clientIp);
  if (isIPv4(c) && isPrivate(c) && !c.startsWith('127.')) add(cidr24(c));
  if (includeInterfaces) {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((name) => ifs[name].forEach((i) => {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address)) add(cidr24(i.address));
    }));
  }
  return out;
}

/** Is something listening on host:port? */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

const unbrace = (s) => String(s == null ? '' : s).trim().replace(/^\{/, '').replace(/\}$/, '').trim();

/** Ask a device what it is. Resolves with whatever answered (possibly nothing). */
function identify(host, port, waitMs) {
  return new Promise((resolve) => {
    const info = { host, port, answered: false, model: '', fw: '', deviceId: '' };
    const s = net.createConnection({ host, port });
    let buf = '';
    const finish = () => { s.destroy(); resolve(info); };
    const timer = setTimeout(finish, waitMs);
    s.setEncoding('ascii');
    s.on('connect', () => s.write('< GET MODEL >< GET FW_VER >< GET DEVICE_ID >'));
    s.on('data', (d) => {
      buf += d;
      const re = /<\s*REP\s+([A-Z_]+)\s+((?:\{[^}]*\}|[^>{])*)>/g;
      let m;
      while ((m = re.exec(buf))) {
        info.answered = true;
        if (m[1] === 'MODEL') info.model = unbrace(m[2]);
        else if (m[1] === 'FW_VER') info.fw = unbrace(m[2]);
        else if (m[1] === 'DEVICE_ID') info.deviceId = unbrace(m[2]);
      }
      if (info.model && info.fw && info.deviceId) { clearTimeout(timer); finish(); }
    });
    s.on('error', () => { clearTimeout(timer); finish(); });
    s.on('close', () => { clearTimeout(timer); finish(); });
  });
}

/** Number of channels a receiver model has. */
function channelsForModel(model) {
  const m = String(model || '').toUpperCase();
  if (/D4Q/.test(m) || /4Q/.test(m)) return 4;
  if (/D4D/.test(m)) return 2;
  return 1;
}

/** Classify what answered. */
function describe(info) {
  const model = info.model || '';
  let kind = 'silent';                                   // port open, no reply
  if (info.answered) kind = /SLX-?D/i.test(model) ? 'slxd' : 'other';
  return {
    host: info.host, port: info.port, kind, model, fw: info.fw, deviceId: info.deviceId,
    channels: kind === 'slxd' ? channelsForModel(model) : null
  };
}

/**
 * Search `hosts` for receivers. `state` is updated as it goes so a page can poll it:
 * { running, total, done, found: [...] }
 */
async function scan(hosts, state, { port = 2202, concurrency = 64, connectMs = 700, answerMs = 1500 } = {}) {
  state.running = true; state.total = hosts.length; state.done = 0; state.found = [];
  let next = 0;
  async function worker() {
    while (next < hosts.length && state.running) {
      const host = hosts[next++];
      try {
        if (await probe(host, port, connectMs)) {
          const info = await identify(host, port, answerMs);
          state.found.push(describe(info));
        }
      } catch (e) { /* skip this address */ }
      state.done++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  state.found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
  state.running = false;
  return state;
}

module.exports = { parseRange, suggestRanges, probe, identify, describe, scan, isPrivate, isIPv4, channelsForModel, MAX_HOSTS };
