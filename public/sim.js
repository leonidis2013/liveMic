/*
 * Simulated SLX-D receivers + shared command validation.
 * Used by the bridge in demo mode, and by the web page itself as a
 * preview when no bridge is reachable. Works in Node and in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SlxSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GAIN_MIN = -18, GAIN_MAX = 42;      // SLX-D range, 1 dB steps
  var FREQ_MIN_KHZ = 470000, FREQ_MAX_KHZ = 960000;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /** Validate a control request. Returns {ok, value} or {ok:false, error}. */
  function normalize(action, value) {
    if (action === 'gain') {
      var g = Number(value);
      if (!Number.isInteger(g) || g < GAIN_MIN || g > GAIN_MAX)
        return { ok: false, error: 'Gain must be a whole number from ' + GAIN_MIN + ' to ' + GAIN_MAX + ' dB' };
      return { ok: true, value: g };
    }
    if (action === 'name') {
      var n = String(value == null ? '' : value).replace(/[{}<>\r\n]/g, '').trim().slice(0, 8);
      if (!n) return { ok: false, error: 'Name cannot be empty' };
      return { ok: true, value: n };
    }
    if (action === 'output') {
      var o = String(value).toUpperCase();
      if (o !== 'MIC' && o !== 'LINE') return { ok: false, error: 'Output must be MIC or LINE' };
      return { ok: true, value: o };
    }
    if (action === 'freq') {            // value in MHz, result in kHz (integer)
      var f = Number(value);
      if (!isFinite(f)) return { ok: false, error: 'Frequency must be a number in MHz' };
      var khz = Math.round(f * 1000);
      if (khz < FREQ_MIN_KHZ || khz > FREQ_MAX_KHZ)
        return { ok: false, error: 'Frequency must be between 470.000 and 960.000 MHz' };
      return { ok: true, value: khz };
    }
    if (action === 'group') {           // "6,100": group and channel from the receiver's table
      var g = String(value == null ? '' : value).replace(/\s+/g, '');
      if (!/^\d{1,3},\d{1,3}$/.test(g)) return { ok: false, error: 'Group and channel look like 6,100' };
      return { ok: true, value: g };
    }
    if (action === 'devname') {         // the receiver's own 8-character Device ID
      var d = String(value == null ? '' : value).replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 8);
      if (!d) return { ok: false, error: 'The name needs 1 to 8 letters, numbers, spaces or - _ .' };
      return { ok: true, value: d };
    }
    if (action === 'identify') return { ok: true, value: true };
    return { ok: false, error: 'Unknown action' };
  }

  function batteryBarsFromMins(m) {
    return m > 180 ? 5 : m > 120 ? 4 : m > 60 ? 3 : m > 30 ? 2 : m > 0 ? 1 : 0;
  }

  function mkChannel(ch, name, o) {
    var c = {
      ch: ch, name: name, gain: 12, out: 'MIC', freq: 606.025, group: '--,--',
      txModel: 'SLXD2', battBars: 4, battMins: 300, peak: -120, rms: -120,
      rssiA: -128, rssiB: -128, quality: 0, tx: false,
      _active: true, _speak: false, _t: 0, _base: -26, _rfA: -58, _rfB: -64, _ph: Math.random() * 6
    };
    for (var k in o) c[k] = o[k];
    return c;
  }

  function create() {
    var receivers = [
      { id: 'rx1', name: 'Stage Left', host: 'demo-1', model: 'SLXD4D', fw: '2.1.4', lock: 'OFF', channels: [
        mkChannel(1, 'Pastor', { freq: 606.025, group: '01,03', battMins: 312, _base: -24, _rfA: -52, _rfB: -61 }),
        mkChannel(2, 'Vocal 1', { freq: 610.450, group: '01,05', battMins: 245, _base: -27, _rfA: -57, _rfB: -55 })
      ] },
      { id: 'rx2', name: 'Stage Right', host: 'demo-2', model: 'SLXD4D', fw: '2.1.4', lock: 'OFF', channels: [
        mkChannel(1, 'Vocal 2', { freq: 614.275, group: '01,07', battMins: 28, _base: -25, _rfA: -66, _rfB: -60 }),
        mkChannel(2, 'Guitar', { freq: 618.900, group: '01,09', _active: false })
      ] },
      { id: 'rx3', name: 'Choir', host: 'demo-3', model: 'SLXD4', fw: '2.1.4', lock: 'OFF', channels: [
        mkChannel(1, 'Choir', { freq: 622.150, group: '02,01', battMins: 140, _base: -30, _rfA: -89, _rfB: -91 })
      ] }
    ];
    var clock = 0;

    function tick(dt) {
      clock += dt;
      receivers.forEach(function (rx) {
        rx.channels.forEach(function (c) {
          if (!c._active) {
            c.tx = false; c.quality = 0; c.peak = -120; c.rms = -120;
            c.rssiA = -125 + Math.round(Math.random() * 3); c.rssiB = -125 + Math.round(Math.random() * 3);
            c.battBars = null; c.battMins = null; c.txModel = '';
            return;
          }
          c.tx = true; c.txModel = 'SLXD2';
          c._t -= dt;
          if (c._t <= 0) { c._speak = Math.random() < 0.7; c._t = 0.4 + Math.random() * 2.5; }
          var rms, peak;
          if (c._speak) {
            rms = clamp(c._base + (c.gain - 12) + (Math.random() * 10 - 5) - 6, -70, -3);
            peak = Math.min(0, rms + 6 + Math.random() * 5);
          } else {
            rms = -78 + Math.random() * 6; peak = rms + 4;
          }
          c.rms = Math.round(c.rms * 0.5 + rms * 0.5);
          c.peak = Math.round(peak);
          c.rssiA = Math.round(c._rfA + Math.sin(clock * 0.6 + c._ph) * 3 + (Math.random() - 0.5) * 2);
          c.rssiB = Math.round(c._rfB + Math.sin(clock * 0.45 + c._ph * 2) * 3 + (Math.random() - 0.5) * 2);
          var best = Math.max(c.rssiA, c.rssiB);
          c.quality = best > -70 ? 5 : best > -80 ? 4 : best > -88 ? 3 : best > -95 ? 2 : 1;
          c.battMins = Math.max(0, c.battMins - dt / 60);
          c.battBars = batteryBarsFromMins(c.battMins);
        });
      });
    }

    function snapshot() {
      return {
        demo: true,
        receivers: receivers.map(function (rx) {
          return {
            id: rx.id, name: rx.name, host: rx.host, model: rx.model, fw: rx.fw, lock: rx.lock, band: 'G55', deviceId: rx.devId || rx.name.slice(0, 8),
            status: 'ok', online: true,
            channels: rx.channels.map(function (c) {
              var out = {};
              for (var k in c) if (k.charAt(0) !== '_') out[k] = c[k];
              if (out.battMins != null) out.battMins = Math.round(out.battMins);
              return out;
            })
          };
        })
      };
    }

    function command(rxId, ch, action, value) {
      var rx = receivers.filter(function (r) { return r.id === rxId; })[0];
      if (!rx) return { ok: false, error: 'Unknown receiver' };
      if (action === 'identify' || action === 'devname') {
        var dv = normalize(action, value); if (!dv.ok) return dv;
        if (action === 'devname') rx.devId = dv.value;
        return { ok: true };
      }
      var c = rx.channels.filter(function (x) { return x.ch === Number(ch); })[0];
      if (!c) return { ok: false, error: 'Unknown channel' };
      var v = normalize(action, value);
      if (!v.ok) return v;
      if (action === 'gain') c.gain = v.value;
      else if (action === 'name') c.name = v.value;
      else if (action === 'output') c.out = v.value;
      else if (action === 'freq') { c.freq = v.value / 1000; c.group = '--,--'; }
      else if (action === 'group') c.group = v.value;
      return { ok: true };
    }

    return { tick: tick, snapshot: snapshot, command: command };
  }

  return { create: create, normalize: normalize, GAIN_MIN: GAIN_MIN, GAIN_MAX: GAIN_MAX };
});
