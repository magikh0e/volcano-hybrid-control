// tools/fake-volcano.js — a simulated Volcano Hybrid for development.
//
// Loaded only on localhost with ?fake in the URL (see the loader near the top of
// volcano-ble.js); tools/ is never deployed. It replaces
// navigator.bluetooth.requestDevice with a device that answers on the real
// GATT UUIDs, heats toward its target, runs the pump, keeps the status
// registers and auto-off timer, and can drop its link on demand.
//
//   ?fake          real-time simulation
//   ?fake=50       app timers run 50x faster (holds, fills, countdowns)
//
// From the browser console:
//   fakeVolcano.state            current simulated state
//   fakeVolcano.log              every write the app made, newest last
//   fakeVolcano.drop()           drop the Bluetooth link now
//   fakeVolcano.failReconnects(n)  refuse the next n reconnect attempts

(function () {
  "use strict";
  var BASE = "-5354-4f52-5a26-4249434b454c";
  var U = function (s) { return s + BASE; };
  var C = {
    svc: U("10110000"), svc3: U("10100000"),
    cur: U("10110001"), set: U("10110003"), heatOn: U("1011000f"), heatOff: U("10110010"),
    fanOn: U("10110013"), fanOff: U("10110014"), led: U("10110005"), shutOff: U("1011000d"),
    autoOff: U("1011000c"), heatHrs: U("10110015"), heatMin: U("10110016"),
    prj1: U("1010000c"), prj2: U("1010000d"), prj3: U("1010000e"),
    serial: U("10100008"), fw: U("10100005"), fwBle: U("10100004"),
  };

  var speed = (function () {
    var m = /[?&]fake=(\d+)/.exec(location.search);
    return m ? Math.max(1, Number(m[1])) : 1;
  })();
  if (speed > 1) {
    var realTimeout = window.setTimeout.bind(window);
    window.setTimeout = function (fn, ms) {
      var rest = Array.prototype.slice.call(arguments, 2);
      return realTimeout.apply(window, [fn, Math.max(0, (ms || 0) / speed)].concat(rest));
    };
  }

  var S = { cur: 40, set: 185, heat: false, fan: false, led: 70, shutOff: 1800, autoOff: 0,
    heatSecs: 512 * 3600 + 17 * 60, connected: false, failNext: 0 };
  var log = [];
  var listeners = [];
  var notify = null;   // current-temperature notification handler

  function u16(v) { var b = new DataView(new ArrayBuffer(2)); b.setUint16(0, v, true); return b; }
  function u32(v) { var b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v >>> 0, true); return b; }
  function str(s) { return new DataView(new TextEncoder().encode(s).buffer); }
  function lost() { var e = new Error("GATT Server is disconnected."); e.name = "NetworkError"; return e; }

  // Physics: ~1 °C/s up while heating, slow drift down otherwise; auto-off counts down.
  setInterval(function () {
    if (S.heat) {
      var d = S.set - S.cur; S.cur += Math.sign(d) * Math.min(1, Math.abs(d));
      if (S.autoOff > 0 && --S.autoOff === 0) { S.heat = false; S.fan = false; }
      S.heatSecs++;
    } else if (S.cur > 25) S.cur -= 0.2;
    if (S.fan && S.heat) S.cur -= 0.3;   // air flow pulls the chamber down a touch
    if (notify && S.connected) notify(u16(Math.round(S.cur * 10)));
  }, 1000 / Math.min(speed, 20));

  function read(uuid) {
    if (!S.connected) return Promise.reject(lost());
    switch (uuid) {
      case C.cur: return Promise.resolve(u16(Math.round(S.cur * 10)));
      case C.set: return Promise.resolve(u16(Math.round(S.set * 10)));
      case C.led: return Promise.resolve(u16(S.led));
      case C.shutOff: return Promise.resolve(u16(S.shutOff));
      case C.autoOff: return Promise.resolve(u16(S.heat ? S.autoOff : 0));
      case C.heatHrs: return Promise.resolve(u16(Math.floor(S.heatSecs / 3600)));
      case C.heatMin: return Promise.resolve(u16(Math.floor(S.heatSecs / 60) % 60));
      case C.prj1: return Promise.resolve(u32((S.heat ? 32 : 0) | (S.fan ? 8192 : 0)));
      case C.prj2: case C.prj3: return Promise.resolve(u32(0));
      case C.serial: return Promise.resolve(str("FAKE0000001"));
      case C.fw: return Promise.resolve(str("V01.03.00.00"));
      case C.fwBle: return Promise.resolve(str("V01.00.00.00"));
      default: return Promise.resolve(u32(0));
    }
  }
  function write(uuid, buf) {
    if (!S.connected) return Promise.reject(lost());
    var b = new Uint8Array(buf.buffer || buf);
    var v = b[0] | (b[1] << 8);
    var name = Object.keys(C).find(function (k) { return C[k] === uuid; }) || uuid.slice(0, 8);
    if (uuid === C.set) S.set = v / 10;
    else if (uuid === C.heatOn) { S.heat = true; S.autoOff = S.shutOff; }
    else if (uuid === C.heatOff) { S.heat = false; S.fan = false; }
    else if (uuid === C.fanOn) S.fan = true;
    else if (uuid === C.fanOff) S.fan = false;
    else if (uuid === C.led) S.led = v;
    else if (uuid === C.shutOff) S.shutOff = v;
    log.push(new Date().toISOString().slice(11, 19) + " " + name + (uuid === C.set ? " " + v / 10 : ""));
    return Promise.resolve();
  }
  function characteristic(uuid) {
    return {
      uuid: uuid, properties: { read: true, write: true, notify: uuid === C.cur },
      readValue: function () { return read(uuid); },
      writeValue: function (b) { return write(uuid, b); },
      writeValueWithResponse: function (b) { return write(uuid, b); },
      startNotifications: function () { return S.connected ? Promise.resolve(this) : Promise.reject(lost()); },
      stopNotifications: function () { return Promise.resolve(this); },
      addEventListener: function (type, fn) {
        if (uuid === C.cur && type === "characteristicvaluechanged")
          notify = function (dv) { fn({ target: { value: dv } }); };
      },
      removeEventListener: function () {},
    };
  }
  function service(uuid) {
    return { uuid: uuid, getCharacteristic: function (c) {
      return S.connected ? Promise.resolve(characteristic(c)) : Promise.reject(lost());
    } };
  }
  var server = {
    get connected() { return S.connected; },
    getPrimaryService: function (u) { return S.connected ? Promise.resolve(service(u)) : Promise.reject(lost()); },
    disconnect: function () { S.connected = false; },
  };
  var device = {
    id: "fake-volcano", name: "S&B VOLCANO H (fake)",
    gatt: {
      get connected() { return S.connected; },
      connect: function () {
        if (S.failNext > 0) { S.failNext--; return Promise.reject(new Error("Connection attempt failed.")); }
        S.connected = true; return Promise.resolve(server);
      },
      disconnect: function () { S.connected = false; },
    },
    addEventListener: function (type, fn) { if (type === "gattserverdisconnected") listeners.push(fn); },
    removeEventListener: function () {},
  };

  // navigator.bluetooth is a read-only getter; patch the object it returns, or
  // define one where the browser has no Web Bluetooth at all.
  var fakeRequest = function () { return Promise.resolve(device); };
  if (navigator.bluetooth) navigator.bluetooth.requestDevice = fakeRequest;
  else Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: fakeRequest } });

  window.fakeVolcano = {
    state: S, log: log, speed: speed,
    drop: function () {
      S.connected = false; notify = null;
      listeners.forEach(function (fn) { fn({ target: device }); });
      return "dropped";
    },
    failReconnects: function (n) { S.failNext = n; return "next " + n + " reconnects will fail"; },
  };
  console.info("[fake-volcano] simulated Volcano active" + (speed > 1 ? ", timers x" + speed : "") +
    ". Try fakeVolcano.drop() during a run.");
})();
