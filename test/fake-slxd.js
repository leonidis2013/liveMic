/*
 * Minimal fake SLX-D4D that speaks the Shure command-string format,
 * for testing the bridge without hardware. Replies are deliberately
 * split into odd-sized chunks to exercise the parser's buffering.
 */
'use strict';
const net = require('net');

function createFake(port, opts = {}) {
  const model = opts.model || 'SLXD4D';
  const ch = [
    { name: 'Pastor', gain: 30, out: 'MIC', freq: 606025, bars: 4, mins: 312, rssiA: 68, rssiB: 64 },
    { name: 'Vocal 1', gain: 28, out: 'LINE', freq: 610450, bars: 1, mins: 25, rssiA: 30, rssiB: 28 }
  ];
  const log = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('ascii');
    let buf = '', timer = null;
    const out = (s) => {                       // split into random chunks
      let i = 0;
      while (i < s.length) { const n = 1 + Math.floor(Math.random() * 9); sock.write(s.slice(i, i + n)); i += n; }
    };
    const p3 = (n) => String(n).padStart(3, '0');
    const dump = (i) => {
      const c = ch[i - 1];
      return `< REP ${i} CHAN_NAME {${c.name.padEnd(31)}} >< REP ${i} AUDIO_GAIN ${p3(c.gain)} >` +
        `< REP ${i} AUDIO_OUT_LVL_SWITCH ${c.out} >< REP ${i} FREQUENCY ${String(c.freq).padStart(7, '0')} >` +
        `< REP ${i} GROUP_CHANNEL 01,0${i} >`;
    };
    sock.on('data', (d) => {
      buf += d;
      let m;
      const re = /<\s*(GET|SET)\s+([^>]*)>/;
      while ((m = re.exec(buf))) {
        buf = buf.slice(m.index + m[0].length);
        const t = m[2].trim().split(/\s+/);
        const kind = m[1];
        log.push(`${kind} ${t.join(' ')}`);
        let n = /^\d+$/.test(t[0]) ? Number(t.shift()) : null;
        const key = (t.shift() || '').toUpperCase();
        const rest = t.join(' ');
        if (kind === 'GET') {
          if (n == null) {
            if (key === 'MODEL') out(`< REP MODEL {${model}} >`);
            if (key === 'DEVICE_ID') out('< REP DEVICE_ID {Church Rack               } >');
            if (key === 'FW_VER') out('< REP FW_VER {2.1.4} >');
            if (key === 'LOCK_STATUS') out('< REP LOCK_STATUS OFF >');
            continue;
          }
          const list = n === 0 ? [1, 2] : [n];
          list.forEach((i) => {
            const c = ch[i - 1]; if (!c) return;
            if (key === 'ALL') out(dump(i));
            if (key === 'CHAN_NAME') out(`< REP ${i} CHAN_NAME {${c.name.padEnd(31)}} >`);
            if (key === 'AUDIO_GAIN') out(`< REP ${i} AUDIO_GAIN ${p3(c.gain)} >`);
            if (key === 'AUDIO_OUT_LVL_SWITCH') out(`< REP ${i} AUDIO_OUT_LVL_SWITCH ${c.out} >`);
            if (key === 'FREQUENCY') out(`< REP ${i} FREQUENCY ${String(c.freq).padStart(7, '0')} >`);
            if (key === 'TX_MODEL') out(`< REP ${i} TX_MODEL SLXD2 >`);
            if (key === 'TX_BATT_BARS') out(`< REP ${i} TX_BATT_BARS ${p3(c.bars)} >`);
            if (key === 'TX_BATT_MINS') out(`< REP ${i} TX_BATT_MINS ${String(c.mins).padStart(5, '0')} >`);
          });
        } else {
          if ((n == null || n === 0) && key === 'METER_RATE') {
            clearInterval(timer);
            timer = setInterval(() => {
              // SAMPLE x ALL qual audBitmap audPeak audRms rfAntStats rfBitmapA rfRssiA rfBitmapB rfRssiB
              out(`< SAMPLE 1 ALL 005 000 105 090 BB 31 ${p3(ch[0].rssiA)} 31 ${p3(ch[0].rssiB)} >`);
              out(`< SAMPLE 2 ALL 255 000 000 000 XX 00 000 00 000 >`);
            }, 100);
            continue;
          }
          const c = ch[n - 1]; if (!c) continue;
          if (key === 'AUDIO_GAIN') { c.gain = Number(rest); out(`< REP ${n} AUDIO_GAIN ${p3(c.gain)} >`); }
          if (key === 'CHAN_NAME') { c.name = rest.replace(/[{}]/g, ''); out(`< REP ${n} CHAN_NAME {${c.name.padEnd(31)}} >`); }
          if (key === 'AUDIO_OUT_LVL_SWITCH') { c.out = rest; out(`< REP ${n} AUDIO_OUT_LVL_SWITCH ${c.out} >`); }
          if (key === 'FREQUENCY') { c.freq = Number(rest); out(`< REP ${n} FREQUENCY ${String(c.freq).padStart(7, '0')} >`); }
        }
      }
    });
    sock.on('close', () => clearInterval(timer));
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, ch, log })));
}

module.exports = { createFake };
if (require.main === module) createFake(Number(process.argv[2]) || 2202).then(() => console.log('fake SLX-D listening'));
