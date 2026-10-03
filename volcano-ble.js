// volcano-ble.js — Web Bluetooth control for the Storz & Bickel Volcano Hybrid.
//
// The browser is the BLE central: it talks to the Volcano's GATT directly, with
// no backend and no Home Assistant in the loop. Works in Chromium desktop
// (Chrome / Edge / Opera) and Android Chrome, on a device within BLE range of
// the Volcano. Not iOS, not Firefox/Safari, not remote.
//
// GATT protocol reverse-engineered by the Home Assistant integration
// SavageNL/home-assistant-volcano-hybrid. The service-UUID tail
// "5354-4f52-5a26-4249434b454c" is "STORZ&BICKEL" in ASCII.
//
// by magikh0e -- 07.2026  (tested on a real Volcano Hybrid)

(() => {
  "use strict";

  const SVC      = "10110000-5354-4f52-5a26-4249434b454c"; // main control service
  const SVC3     = "10100000-5354-4f52-5a26-4249434b454c"; // status / register service
  const CUR_TEMP = "10110001-5354-4f52-5a26-4249434b454c"; // read/notify  uint16 LE / 10
  const SET_TEMP = "10110003-5354-4f52-5a26-4249434b454c"; // write        (temp*10) uint16 LE
  const HEAT_ON  = "1011000f-5354-4f52-5a26-4249434b454c"; // write [1]
  const HEAT_OFF = "10110010-5354-4f52-5a26-4249434b454c"; // write [0]
  const FAN_ON   = "10110013-5354-4f52-5a26-4249434b454c"; // write [1]
  const FAN_OFF  = "10110014-5354-4f52-5a26-4249434b454c"; // write [0]
  const PRJ1     = "1010000c-5354-4f52-5a26-4249434b454c"; // PRJSTAT1 register, uint32 LE
  const SERIAL   = "10100008-5354-4f52-5a26-4249434b454c"; // svc3, UTF-8 string
  const FW_VER   = "10100005-5354-4f52-5a26-4249434b454c"; // svc3, Volcano firmware
  const FW_BLE   = "10100004-5354-4f52-5a26-4249434b454c"; // svc3, Bluetooth firmware
  const HEAT_HRS = "10110015-5354-4f52-5a26-4249434b454c"; // main svc, heat hours (uint LE)
  const HEAT_MIN = "10110016-5354-4f52-5a26-4249434b454c"; // main svc, heat minutes (uint LE)
  const SHUT_OFF = "1011000d-5354-4f52-5a26-4249434b454c"; // main svc, auto-off (seconds LE; set = min*60)
  const AUTO_OFF = "1011000c-5354-4f52-5a26-4249434b454c"; // main svc, live auto-off remaining (seconds LE)
  const LED_BRIGHT = "10110005-5354-4f52-5a26-4249434b454c"; // main svc, LED brightness (LE)
  const PRJ2     = "1010000d-5354-4f52-5a26-4249434b454c"; // svc3 PRJSTAT2: units, cooling-display
  const PRJ3     = "1010000e-5354-4f52-5a26-4249434b454c"; // svc3 PRJSTAT3: vibration
  const MASK_HEAT = 32;    // PRJSTAT1: heater enabled
  const MASK_PUMP = 8192;  // PRJSTAT1: pump / fan enabled
  // PRJSTAT2/3 flags are active-low: the feature is ON when the bit is CLEAR.
  const MASK_FAHRENHEIT   = 0x0200; // PRJSTAT2: set = device shows °F  (clear = °C)
  const MASK_DISPLAY_COOL = 0x1000; // PRJSTAT2: clear = show temp while cooling
  const MASK_VIBRATION    = 0x0400; // PRJSTAT3: clear = vibration alert on
  const MASK_ERR1 = 16408; // PRJSTAT1 error bits (HA prv1_error)
  const MASK_ERR2 = 59;    // PRJSTAT2 error bits (HA prv2_error)
  // Register write convention (4-byte LE): write the mask alone to CLEAR the
  // bit; write (REG_SET | mask) to SET it. Matches the HA integration exactly.
  const REG_SET = 0x10000;

  // App version: bump it with a CHANGELOG.md entry on each release (see deploy/README.md).
  const APP_VERSION = "1.1.0";
  const CHANGELOG_URL = "https://github.com/magikh0e/volcano-hybrid-control/blob/main/CHANGELOG.md";

  const MIN_T = 40, MAX_T = 230, STEP = 1;
  const FILL_SECS = 41;     // standard S&B Easy Valve bag fill (matches the HA script)
  const LADDER = [179, 185, 191, 199, 205, 211, 217, 230]; // Vapesuvius rungs (°C)
  const LADDER_STEP_SECS = 300;   // 5 min per rung, per the HA auto-progress automation
  const LADDER_FILL_TOL = 2;      // auto-fill: fill a rung's bag once current temp is within 2 °C of it
  const DEFAULT_PRESETS = [179, 185, 191, 199, 205, 211, 217, 230]; // editable quick-set presets (°C)

  let device = null, server = null, svc = null, svc3 = null;
  let curTempChar = null, setTempChar = null, prj1Char = null, prj2Char = null;
  let pollTimer = null, fillTimer = null, fillLeft = 0;
  let ladderTimer = null, ladderElapsed = 0, ladderIdx = -1;
  let ladderRungFilled = false, ladderFilling = false, ladderFillLeft = 0;
  let curTemp = null;             // last-seen current temp (°C); gates the ladder auto-fill
  let target = 190;         // pending target shown in the UI
  let heatOn = false, fanOn = false;
  let shutOffMin = null;    // last-known auto-off setting (min), used by the session timer
  let presets = [];         // user-editable quick-set presets (°C), persisted in localStorage
  let presetEditMode = false;

  const $ = (id) => document.getElementById(id);

  function status(msg, kind) {
    // Mirror every status message to the terminal, if one is listening
    // (console.js sets window.volcanoEcho). No-op on the site build.
    if (window.volcanoEcho) { try { window.volcanoEcho(msg, kind); } catch (e) {} }
    const el = $("v-status");
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = kind || "";
  }

  function setConnected(on) {
    document.body.classList.toggle("v-connected", on);
    const c = $("v-connect"), d = $("v-disconnect"), rc = $("v-reconnect");
    if (c) c.hidden = on;
    if (d) d.hidden = !on;
    if (rc) rc.hidden = on || !device;   // offer Reconnect only when disconnected with a known device
    ["v-tminus", "v-tplus", "v-setbtn", "v-heat", "v-fan", "v-fill", "v-ladder",
     "v-shutoff-in", "v-shutoff-set", "v-led-in", "v-led-set",
     "v-cooldisp", "v-vibrate"].forEach((id) => {
      const el = $(id); if (el) el.disabled = !on;
    });
    document.querySelectorAll(".v-segbtn").forEach((el) => { el.disabled = !on; });
    renderPresets();     // preset buttons follow connection state (unless editing)
    renderWorkflows();   // workflow Run buttons follow connection state (and the drawing's picker)
    ["v-dev-minus", "v-dev-plus", "v-dev-heat", "v-dev-air"].forEach((id) => {
      const n = $(id); if (n) n.setAttribute("aria-disabled", on ? "false" : "true");
    });
    const ds = $("v-dev-state"); if (ds) ds.textContent = on ? (device && device.name ? device.name : "connected") : "not connected";
    if (!on) {
      setLed("v-heatled", false); setLed("v-fanled", false);
      const cur = $("v-cur"); if (cur) cur.textContent = "---";
      const sess = $("v-session"); if (sess) sess.textContent = "—";
      const err = $("v-error"); if (err) { err.hidden = true; err.textContent = ""; }
    }
  }

  const DEV_LIGHTS = { "v-heatled": ["v-dev-heat", "v-dev-heatdot"], "v-fanled": ["v-dev-air"] };
  function setLed(id, on) {
    const el = $(id);
    if (el) el.classList.toggle("on", !!on);
    (DEV_LIGHTS[id] || []).forEach((d) => { const n = $(d); if (n) n.classList.toggle("on", !!on); });
  }

  // The device works in °C; the app can show °F. Only what's displayed is
  // converted: values are stored and written in °C.
  let appF = false;
  try { appF = localStorage.getItem("volcano-app-units") === "F"; } catch (e) { /* ignore */ }
  const cToF = (c) => Math.round(c * 9 / 5 + 32);
  const fToC = (f) => Math.round((f - 32) * 5 / 9);
  function fmtT(c) { return appF ? cToF(c) + " °F" : c + " °C"; }
  function fmtDeg(c) { return (appF ? cToF(c) : c) + "°"; }

  function showTarget() {
    const el = $("v-set");
    if (el) el.textContent = fmtT(target);
  }
  function showCurrent() {
    const c = $("v-cur");
    if (c) c.textContent = curTemp == null ? "---" : fmtT(curTemp);
  }
  function setAppUnits(f) {
    appF = !!f;
    try { localStorage.setItem("volcano-app-units", appF ? "F" : "C"); } catch (e) { /* ignore */ }
    document.querySelectorAll("#v-appunits .v-segbtn").forEach((b) => {
      const active = (b.dataset.unit === "F") === appF;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const pu = $("v-preset-unit"); if (pu) pu.textContent = appF ? "°F" : "°C";
    const pin = $("v-preset-add-in");
    if (pin) {
      pin.min = appF ? cToF(MIN_T) : MIN_T; pin.max = appF ? cToF(MAX_T) : MAX_T;
      pin.placeholder = appF ? "383" : "195";
      pin.setAttribute("aria-label", "New preset temperature in " + (appF ? "Fahrenheit" : "Celsius"));
    }
    showTarget(); showCurrent(); renderPresets();
  }

  async function write(uuid, bytes) {
    const ch = await svc.getCharacteristic(uuid);
    const buf = new Uint8Array(bytes);
    if (ch.writeValueWithResponse) return ch.writeValueWithResponse(buf);
    return ch.writeValue(buf);
  }

  function parseTemp(dv) { return dv.getUint16(0, true) / 10; }
  function decodeStr(dv) {
    const s = new TextDecoder("utf-8").decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    return s.replace(/\0+$/, "").trim() || "—";
  }
  function leUint(dv) {
    let v = 0;
    for (let i = dv.byteLength - 1; i >= 0; i--) v = v * 256 + dv.getUint8(i);
    return v;
  }

  async function readDeviceInfo() {
    const el = $("v-device");
    if (!el) return;
    const rd = async (service, uuid, fn) => {
      try { return fn(await (await service.getCharacteristic(uuid)).readValue()); }
      catch (e) { return "—"; }
    };
    const serial = svc3 ? await rd(svc3, SERIAL, decodeStr) : "—";
    const fw     = svc3 ? await rd(svc3, FW_VER, decodeStr) : "—";
    const bleFw  = svc3 ? await rd(svc3, FW_BLE, decodeStr) : "—";
    const hrs    = await rd(svc, HEAT_HRS, leUint);
    const mins   = await rd(svc, HEAT_MIN, leUint);
    const pad = (s) => (s + "                      ").slice(0, 22);
    const oper = (hrs === "—") ? "—" : (hrs + " h" + (mins === "—" ? "" : " " + mins + " min"));
    el.textContent =
      pad("Serial number") + serial + "\n" +
      pad("Volcano firmware") + fw + "\n" +
      pad("Bluetooth firmware") + bleFw + "\n" +
      pad("Hours of operation") + oper;
  }

  async function pollStatus() {
    try {
      let reg = null, p2 = null;
      if (prj1Char) {
        const dv = await prj1Char.readValue();
        reg = dv.getUint32(0, true);
        heatOn = (reg & MASK_HEAT) !== 0;
        fanOn = (reg & MASK_PUMP) !== 0;
        setLed("v-heatled", heatOn);
        setLed("v-fanled", fanOn);
        const hb = $("v-heat"), fb = $("v-fan");
        if (hb) hb.textContent = heatOn ? "⏻ Heat OFF" : "⏻ Heat ON";
        if (fb) fb.textContent = fanOn ? "⬚ Fan OFF" : "⬚ Fan ON";
      }
      if (prj2Char) {
        try { p2 = leUint(await prj2Char.readValue()); } catch (e) { /* keep null */ }
      }
      updateErrors(reg, p2);
      if (curTempChar) {
        const dv = await curTempChar.readValue();
        curTemp = Math.round(parseTemp(dv));
        showCurrent();
      }
      await updateTimers();
    } catch (e) { /* transient read errors are fine between polls */ }
  }

  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? (h + ":" + pad(m) + ":" + pad(sec)) : (m + ":" + pad(sec));
  }

  // Surface the device's error flags (HA prv1_error / prv2_error).
  function updateErrors(reg, p2) {
    const el = $("v-error"); if (!el) return;
    const e1 = reg != null && (reg & MASK_ERR1) !== 0;
    const e2 = p2 != null && (p2 & MASK_ERR2) !== 0;
    if (e1 || e2) {
      el.hidden = false;
      el.textContent = "⚠ Device error flag set" +
        (e1 && e2 ? " (PRJSTAT1 & 2)" : e1 ? " (PRJSTAT1)" : " (PRJSTAT2)");
    } else {
      el.hidden = true; el.textContent = "";
    }
  }

  // Session runtime + live auto-off countdown, only meaningful while heating.
  // The device's auto-off characteristic holds the seconds remaining; on-time
  // is the configured duration minus that, exactly as the HA integration derives it.
  async function updateTimers() {
    const el = $("v-session"); if (!el) return;
    if (!heatOn || !svc) { el.textContent = "idle"; return; }
    try {
      const remain = leUint(await (await svc.getCharacteristic(AUTO_OFF)).readValue());
      if (remain > 0 && shutOffMin != null) {
        const on = Math.max(0, shutOffMin * 60 - remain);
        el.textContent = "running " + fmtDur(on) + " · auto-off in " + fmtDur(remain);
      } else {
        el.textContent = "running";
      }
    } catch (e) { /* leave the last value on a transient read error */ }
  }

  async function writeU16(uuid, value) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, true);
    const ch = await svc.getCharacteristic(uuid);
    if (ch.writeValueWithResponse) return ch.writeValueWithResponse(buf);
    return ch.writeValue(buf);
  }

  // Write a 4-byte LE value to a PRJSTAT2/3 register on the status service.
  async function writeReg(uuid, value) {
    if (!svc3) throw new Error("register service unavailable");
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0, true);
    const ch = await svc3.getCharacteristic(uuid);
    if (ch.writeValueWithResponse) return ch.writeValueWithResponse(buf);
    return ch.writeValue(buf);
  }

  function setUnitUI(celsius) {
    document.querySelectorAll("#v-units .v-segbtn").forEach((b) => {
      const active = (b.dataset.unit === "C") === celsius;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const cur = $("v-units-cur");
    if (cur) cur.textContent = "device shows °" + (celsius ? "C" : "F");
  }

  async function setUnits(celsius) {
    try {
      // Clear the Fahrenheit bit for °C; set it for °F.
      await writeReg(PRJ2, celsius ? MASK_FAHRENHEIT : (REG_SET | MASK_FAHRENHEIT));
      setUnitUI(celsius);
      status("Device display set to °" + (celsius ? "C" : "F") + ".", "ok");
    } catch (e) { status("Units change failed: " + (e.message || e), "err"); }
  }

  async function setCoolDisplay(on) {
    try {
      // Active-low: clear the bit to show the temperature while cooling.
      await writeReg(PRJ2, on ? MASK_DISPLAY_COOL : (REG_SET | MASK_DISPLAY_COOL));
      status("Show temperature while cooling " + (on ? "on" : "off") + ".", "ok");
    } catch (e) {
      const cd = $("v-cooldisp"); if (cd) cd.checked = !on;   // revert on failure
      status("Setting failed: " + (e.message || e), "err");
    }
  }

  async function setVibration(on) {
    try {
      await writeReg(PRJ3, on ? MASK_VIBRATION : (REG_SET | MASK_VIBRATION));
      status("Vibration alert " + (on ? "on" : "off") + ".", "ok");
    } catch (e) {
      const vb = $("v-vibrate"); if (vb) vb.checked = !on;    // revert on failure
      status("Vibration change failed: " + (e.message || e), "err");
    }
  }

  async function readSettings() {
    const rd = async (uuid, fn) => {
      try { return fn(await (await svc.getCharacteristic(uuid)).readValue()); }
      catch (e) { return null; }
    };
    const off = await rd(SHUT_OFF, (dv) => Math.round(leUint(dv) / 60));
    const led = await rd(LED_BRIGHT, leUint);
    if (off != null) shutOffMin = off;   // cache for the session timer
    const oi = $("v-shutoff-in"), oc = $("v-shutoff-cur");
    if (oi && off != null) oi.value = off;
    if (oc) oc.textContent = off != null ? "now " + off + " min" : "";
    const li = $("v-led-in"), lc = $("v-led-cur");
    if (li && led != null) li.value = led;
    if (lc) lc.textContent = led != null ? "now " + led + "%" : "";
    // Register-backed toggles (units / cooling display / vibration) live on svc3.
    const rd3 = async (uuid) => {
      if (!svc3) return null;
      try { return leUint(await (await svc3.getCharacteristic(uuid)).readValue()); }
      catch (e) { return null; }
    };
    const p2 = await rd3(PRJ2), p3 = await rd3(PRJ3);
    if (p2 != null) {
      setUnitUI((p2 & MASK_FAHRENHEIT) === 0);
      const cd = $("v-cooldisp"); if (cd) cd.checked = (p2 & MASK_DISPLAY_COOL) === 0;
    }
    if (p3 != null) {
      const vb = $("v-vibrate"); if (vb) vb.checked = (p3 & MASK_VIBRATION) === 0;
    }
  }

  async function commitShutOff() {
    const inp = $("v-shutoff-in"); if (!inp) return;
    let mins = parseInt(inp.value, 10);
    if (!Number.isFinite(mins)) { status("Enter auto-off minutes.", "warn"); return; }
    mins = Math.min(480, Math.max(1, mins)); inp.value = mins;
    try {
      await writeU16(SHUT_OFF, mins * 60);
      shutOffMin = mins;   // keep the session timer in sync
      const oc = $("v-shutoff-cur"); if (oc) oc.textContent = "now " + mins + " min";
      status("Auto-off set to " + mins + " min.", "ok");
    } catch (e) { status("Auto-off set failed: " + (e.message || e), "err"); }
  }

  async function commitBrightness() {
    const inp = $("v-led-in"); if (!inp) return;
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v)) { status("Enter LED brightness 0–100.", "warn"); return; }
    v = Math.min(100, Math.max(0, v)); inp.value = v;
    try {
      await writeU16(LED_BRIGHT, v);
      const lc = $("v-led-cur"); if (lc) lc.textContent = "now " + v + "%";
      status("LED brightness set to " + v + "%.", "ok");
    } catch (e) { status("LED set failed: " + (e.message || e), "err"); }
  }

  function onDisconnected() {
    wfStop = true;   // stop any running workflow
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (fillTimer) { clearInterval(fillTimer); fillTimer = null; }
    if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; }
    ladderIdx = -1;
    resetFillButton();
    resetLadderButton();
    const dev = $("v-device");
    if (dev) dev.textContent = "Connect to read serial number, firmware versions, and hours of operation.";
    ["v-shutoff-cur", "v-led-cur", "v-units-cur"].forEach((id) => { const el = $(id); if (el) el.textContent = ""; });
    document.querySelectorAll("#v-units .v-segbtn").forEach((b) => {
      b.classList.remove("active"); b.setAttribute("aria-pressed", "false");
    });
    server = svc = svc3 = curTempChar = setTempChar = prj1Char = prj2Char = null;
    shutOffMin = null;
    setConnected(false);
    status("Disconnected.", "warn");
  }

  async function connect() {
    if (!navigator.bluetooth) { status("Web Bluetooth not available in this browser.", "err"); return; }
    try {
      status("Requesting your Volcano…");
      // Show only the Volcano: match its control service (if advertised) or a
      // name starting with VOLCANO / S&B / Storz (the advertised name varies).
      // If nothing shows, another central (Home Assistant, the S&B app) is
      // holding the single BLE connection — disconnect that first.
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [SVC] },
          { namePrefix: "VOLCANO" },
          { namePrefix: "S&B" },
          { namePrefix: "Storz" },
        ],
        optionalServices: [SVC, SVC3],
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
      await openDevice();
    } catch (e) {
      if (e && e.name === "NotFoundError")
        status("No Volcano selected. If it isn't listed, disconnect Home Assistant or the S&B app first — the Volcano allows only one connection.", "warn");
      else
        status("Connect failed: " + (e.message || e), "err");
    }
  }

  // Reconnect to the last device without re-opening the chooser (HA's reconnect).
  async function reconnect() {
    if (!device) return connect();   // nothing retained — fall back to the picker
    try { await openDevice(); }
    catch (e) { status("Reconnect failed: " + (e.message || e) + " — try Connect.", "err"); }
  }

  // Open the GATT connection on the already-selected `device` and wire up the UI.
  async function openDevice() {
    status("Connecting…");
    server = await device.gatt.connect();
    svc = await server.getPrimaryService(SVC);
    try { svc3 = await server.getPrimaryService(SVC3); } catch (e) { svc3 = null; }

    curTempChar = await svc.getCharacteristic(CUR_TEMP);
    setTempChar = await svc.getCharacteristic(SET_TEMP);
    if (svc3) {
      try { prj1Char = await svc3.getCharacteristic(PRJ1); } catch (e) { prj1Char = null; }
      try { prj2Char = await svc3.getCharacteristic(PRJ2); } catch (e) { prj2Char = null; }
    }

    // Live current-temperature via notifications.
    try {
      await curTempChar.startNotifications();
      curTempChar.addEventListener("characteristicvaluechanged", (ev) => {
        curTemp = Math.round(parseTemp(ev.target.value));
        showCurrent();
      });
    } catch (e) { /* fall back to polling below */ }

    // Seed the target from the device's current set-point.
    try {
      const dv = await setTempChar.readValue();
      target = Math.min(MAX_T, Math.max(MIN_T, Math.round(parseTemp(dv))));
      showTarget();
    } catch (e) { /* keep the default */ }

    setConnected(true);
    status("Connected to " + (device.name || "Volcano") + ".", "ok");
    await pollStatus();
    readDeviceInfo();      // fills the Device section (serial / firmware / hours)
    readSettings();        // fills the Settings section (auto-off / LED)
    const ah = $("v-autoheat");
    if (ah && ah.checked) {
      // Opt-in only: the user ticked "heat on connect", so no confirm here.
      try {
        await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
        status("Connected — heater on (auto).", "ok");
      } catch (e) { /* leave heat off on error */ }
    }
    pollTimer = setInterval(pollStatus, 2000);
  }

  async function disconnect() {
    try { if (device && device.gatt.connected) device.gatt.disconnect(); }
    finally { onDisconnected(); }
  }

  function bumpTarget(delta) {
    target = Math.min(MAX_T, Math.max(MIN_T, target + delta));
    showTarget();
  }

  async function commitTarget() {
    try {
      const buf = new Uint8Array(2);
      new DataView(buf.buffer).setUint16(0, Math.round(target * 10), true);
      const ch = setTempChar || await svc.getCharacteristic(SET_TEMP);
      if (ch.writeValueWithResponse) await ch.writeValueWithResponse(buf);
      else await ch.writeValue(buf);
      status("Target set to " + fmtT(target) + ".", "ok");
    } catch (e) { status("Set failed: " + (e.message || e), "err"); }
  }

  async function applyPreset(t) {
    // Quick-set preset — set the target and write it (presets are only
    // clickable while connected, so setTempChar / svc are available).
    target = Math.min(MAX_T, Math.max(MIN_T, t));
    showTarget();
    await commitTarget();
  }

  // ---- editable presets -----------------------------------------------------

  function sanitizePresets(arr) {
    // Round to whole °C, drop anything out of range or non-numeric, dedupe, sort.
    return [...new Set(arr
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n >= MIN_T && n <= MAX_T))]
      .sort((a, b) => a - b);
  }

  function loadPresets() {
    try {
      const raw = localStorage.getItem("volcano-presets");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) { const s = sanitizePresets(arr); if (s.length) return s; }
      }
    } catch (e) { /* fall through to defaults */ }
    return DEFAULT_PRESETS.slice();
  }

  function savePresets() {
    try { localStorage.setItem("volcano-presets", JSON.stringify(presets)); } catch (e) { /* ignore */ }
  }

  function renderPresets() {
    const box = $("v-presets");
    if (!box) return;
    const connected = document.body.classList.contains("v-connected");
    box.textContent = "";
    presets.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "v-preset" + (presetEditMode ? " v-preset-editing" : "");
      b.dataset.temp = String(t);
      b.textContent = presetEditMode ? (fmtDeg(t) + " ×") : fmtDeg(t);
      b.disabled = presetEditMode ? false : !connected;
      b.setAttribute("aria-label",
        presetEditMode ? ("Remove " + fmtT(t) + " preset") : ("Set target " + fmtT(t)));
      box.appendChild(b);
    });
    if (presetEditMode && !presets.length) {
      const span = document.createElement("span");
      span.className = "v-hint";
      span.textContent = "no presets — add one below";
      box.appendChild(span);
    }
  }

  function togglePresetEdit() {
    presetEditMode = !presetEditMode;
    const ed = $("v-preset-editor"); if (ed) ed.hidden = !presetEditMode;
    const btn = $("v-preset-edit");
    if (btn) {
      btn.classList.toggle("active", presetEditMode);
      btn.setAttribute("aria-pressed", presetEditMode ? "true" : "false");
    }
    renderPresets();
  }

  function removePreset(t) {
    presets = presets.filter((x) => x !== t);
    savePresets();
    renderPresets();
  }

  function addPreset() {
    const inp = $("v-preset-add-in"); if (!inp) return;
    const raw = Math.round(Number(inp.value));
    const v = appF ? fToC(raw) : raw;   // typed in the app's unit, stored in °C
    if (!inp.value.trim() || !Number.isFinite(v) || v < MIN_T || v > MAX_T) {
      status("Preset must be " + fmtT(MIN_T) + "–" + fmtT(MAX_T) + ".", "warn"); return;
    }
    if (presets.includes(v)) { status(fmtT(v) + " is already a preset.", "warn"); inp.value = ""; return; }
    presets = sanitizePresets([...presets, v]);
    savePresets();
    renderPresets();
    inp.value = "";
    status("Added " + fmtT(v) + " preset.", "ok");
  }

  function resetPresets() {
    presets = DEFAULT_PRESETS.slice();
    savePresets();
    renderPresets();
    status("Presets reset to Vapesuvius defaults.", "ok");
  }

  async function toggleHeat() {
    try {
      const next = !heatOn;
      if (next && !confirm("Turn the heater ON? It will ramp to " + fmtT(target) + ".")) return;
      await write(next ? HEAT_ON : HEAT_OFF, [next ? 1 : 0]);
      status("Heater " + (next ? "ON" : "OFF") + ".", "ok");
      setTimeout(pollStatus, 400);
    } catch (e) { status("Heat toggle failed: " + (e.message || e), "err"); }
  }

  async function toggleFan() {
    try {
      const next = !fanOn;
      await write(next ? FAN_ON : FAN_OFF, [next ? 1 : 0]);
      status("Fan " + (next ? "ON" : "OFF") + ".", "ok");
      setTimeout(pollStatus, 400);
    } catch (e) { status("Fan toggle failed: " + (e.message || e), "err"); }
  }

  function resetFillButton() {
    const b = $("v-fill");
    if (b) b.textContent = "⏱ Fill bag (" + FILL_SECS + "s)";
  }

  async function stopFill(msg, kind) {
    if (fillTimer) { clearInterval(fillTimer); fillTimer = null; }
    try { await write(FAN_OFF, [0]); } catch (e) { /* best effort */ }
    fanOn = false; setLed("v-fanled", false);
    resetFillButton();
    if (msg) status(msg, kind);
  }

  async function fillBag() {
    if (fillTimer) { await stopFill("Fill cancelled.", "warn"); return; }
    try {
      await write(FAN_ON, [1]);
      fanOn = true; setLed("v-fanled", true);
      fillLeft = FILL_SECS;
      const b = $("v-fill");
      const render = () => {
        if (b) b.textContent = "■ Stop (" + fillLeft + "s)";
        status("Filling bag… " + fillLeft + "s", "ok");
      };
      render();
      fillTimer = setInterval(() => {
        fillLeft -= 1;
        if (fillLeft <= 0) stopFill("Bag filled.", "ok");
        else render();
      }, 1000);
    } catch (e) { status("Fill failed: " + (e.message || e), "err"); }
  }

  function resetLadderButton() {
    const b = $("v-ladder");
    if (b) b.textContent = "▶ Run ladder";
  }

  function stopLadder(msg, kind) {
    if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; }
    if (ladderFilling) {                 // a bag was mid-fill — stop the pump
      write(FAN_OFF, [0]).catch(() => {});
      fanOn = false; setLed("v-fanled", false);
    }
    ladderIdx = -1; ladderFilling = false; ladderRungFilled = false;
    resetLadderButton();
    if (msg) status(msg, kind);
  }

  async function tickLadder() {
    const idx = Math.min(LADDER.length - 1, Math.floor(ladderElapsed / LADDER_STEP_SECS));
    const last = idx >= LADDER.length - 1;
    const fillOn = !!($("v-ladder-fill") && $("v-ladder-fill").checked);
    const rungLabel = "Ladder rung " + (idx + 1) + "/" + LADDER.length;
    const b = $("v-ladder");
    let msg = null;

    if (idx !== ladderIdx) {              // entered a new rung — set its target
      ladderIdx = idx;
      target = LADDER[idx]; showTarget();
      try { await commitTarget(); } catch (e) { /* keep walking */ }
      ladderRungFilled = false;          // this rung's bag hasn't been filled yet
    }

    if (ladderFilling) {                  // pump running — count the bag down
      ladderFillLeft -= 1;
      if (ladderFillLeft <= 0) {
        try {
          await write(FAN_OFF, [0]);
          fanOn = false; setLed("v-fanled", false);
          ladderFilling = false;
        } catch (e) {                     // stop failed (GATT busy) — retry next tick
          ladderFillLeft = 1; msg = rungLabel + " — stopping pump…";
        }
      }
      if (ladderFilling) msg = msg || (rungLabel + " — filling bag… " + ladderFillLeft + "s");
    } else if (fillOn && !ladderRungFilled) {   // wait until it reaches temp, then fill once
      if (curTemp != null && curTemp >= LADDER[idx] - LADDER_FILL_TOL) {
        try {
          await write(FAN_ON, [1]);
          fanOn = true; setLed("v-fanled", true);
          ladderRungFilled = true; ladderFilling = true; ladderFillLeft = FILL_SECS;
          msg = rungLabel + " — filling bag… " + ladderFillLeft + "s";
        } catch (e) { msg = rungLabel + " — reached temp, starting fill…"; }   // retry next tick
      } else {
        msg = rungLabel + " — heating to " + fmtT(LADDER[idx]) + "…";
      }
    }

    // complete only once the final rung's bag (if any) has finished
    if (last && !ladderFilling && (!fillOn || ladderRungFilled)) {
      if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; }
      resetLadderButton();
      status("Ladder complete — holding at " + fmtT(LADDER[idx]) + ".", "ok");
      return;
    }

    if (b) b.textContent = "■ Stop ladder (" + (idx + 1) + "/" + LADDER.length + ")";
    if (msg == null) {                    // default: countdown to the next rung
      const rem = LADDER_STEP_SECS - (ladderElapsed % LADDER_STEP_SECS);
      const mm = Math.floor(rem / 60), ss = String(rem % 60).padStart(2, "0");
      msg = rungLabel + " — " + fmtT(LADDER[idx]) + " · next in " + mm + ":" + ss;
    }
    status(msg, "ok");
    ladderElapsed += 1;
  }

  async function runLadder() {
    if (ladderTimer) { stopLadder("Ladder stopped.", "warn"); return; }
    const fillOn = !!($("v-ladder-fill") && $("v-ladder-fill").checked);
    if (!confirm("Start the Vapesuvius ladder? Heat turns on and the target walks " +
                 fmtT(LADDER[0]) + "→" + fmtT(LADDER[LADDER.length - 1]) + ", one rung every 5 min (~35 min)." +
                 (fillOn ? " A bag is filled automatically once each rung reaches temp." : ""))) return;
    try {
      await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
      ladderElapsed = 0; ladderIdx = -1;
      ladderFilling = false; ladderRungFilled = false;
      await tickLadder();          // apply the first rung immediately
      ladderTimer = setInterval(tickLadder, 1000);
    } catch (e) { status("Ladder failed: " + (e.message || e), "err"); }
  }

  // ===== Workflows ===========================================================
  // A workflow is { id, name, actions: [ {type, ...params} ] }, saved in
  // localStorage. Action types mirror Project Onyx:
  //   heatOn {temp?}  heatOff  fanOn {secs}  fanOnGlobal {secs}  wait {secs}
  //   setLED {pct}  exitWhenTemp {temp, by?: "target"|"chamber"}  loop
  //   conditionalTemp { def:{temp,wait}, conditions:[{ifTemp,thenSet,wait}] }

  const WF_TYPES = [
    { v: "heatOn",          label: "🔥 Heat On" },
    { v: "heatOff",         label: "❄ Heat Off" },
    { v: "fanOn",           label: "💨 Fan On" },
    { v: "fanOnGlobal",     label: "🌀 Fan On (background)" },
    { v: "wait",            label: "⏸ Wait" },
    { v: "setLED",          label: "💡 Set LED Brightness" },
    { v: "conditionalTemp", label: "🎯 Conditional Temp Set" },
    { v: "exitWhenTemp",    label: "🚪 Exit When Temp Reached" },
    { v: "loop",            label: "🔁 Loop From Beginning" },
  ];

  const WF_HEAT_TIMEOUT_MS = 15 * 60 * 1000;
  const WF_COOL_TIMEOUT_MS = 30 * 60 * 1000;
  const WF_COOL_TOL = 3;   // °C above a rung that still counts as "at" it (heat-up overshoot)

  // ---- templates ------------------------------------------------------------
  // Ready-made workflows, modelled on Project Onyx's premade set (step temps
  // from Vapesuvius' chart). Adding one copies it into your own list, where
  // it's an ordinary, editable workflow.

  // A conditionalTemp that walks `temps` in order: from rung i go to rung i+1;
  // from anywhere else start at temps[0]. Reverse the array to step down.
  function wfLadder(temps, wait) {
    return {
      type: "conditionalTemp",
      def: { temp: temps[0], wait: wait },
      conditions: temps.slice(0, -1).map((t, i) => ({ ifTemp: t, thenSet: temps[i + 1], wait: wait })),
    };
  }
  const VAPESUVIUS = [179, 185, 191, 199, 205, 211, 217, 230];
  const CAPSULE = [185, 197, 211, 230];
  const DEV_SPECIAL = [180, 185, 190, 195, 200];
  const EVEN_RUNGS = [185, 199, 211, 230];          // Vapesuvius rungs 2 / 4 / 6 / 8
  const FLAVOR = [170, 175, 180];                   // terpene range, see Help's boiling-point table
  const FINISHER = [215, 220, 225, 230];
  const BALLOON = [170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220];
  const LOW_SLOW = [180, 190, 200];
  const TERP_TOUR = [169, 180, 187, 202, 215, 222, 230];   // boiling-point landmarks + 1–2 °C
  const ODD_RUNGS = [179, 191, 205, 217];                  // Vapesuvius rungs 1 / 3 / 5 / 7
  const EXPRESS = [185, 205, 225];
  const WF_BAG_FIT = 30;     // s at each rung to fit a fresh bag before it fills
  const WF_BAG_FILL = 34;    // s for a full bag
  const WF_WHIP_HOLD = 180;  // s per rung in whip mode, unless a template sets whipSecs
  const PARTY_ROUNDS = 8;    // Party Rounds: capped so the heater can't run on forever
  const PARTY_GAP = 150;     // s between Party Rounds bags (pass it round, fit the next)
  const fill = (secs) => ({ type: "fanOn", secs: secs || WF_BAG_FILL });   // blocks until the bag is full
  // n on/off LED flashes, one second each.
  const wfBlink = (n) => Array.from({ length: n }, () => [
    { type: "setLED", pct: 100 }, { type: "wait", secs: 1 }, { type: "setLED", pct: 0 }, { type: "wait", secs: 1 },
  ]).flat();

  // Ladder templates ({temps}) run hands-free, always from the first rung, in
  // one of two modes, and turn the heat off at the end:
  //   bag  - at each rung: heat/cool until reached, WF_BAG_FIT s to fit a bag,
  //          then the fill (default one full bag).
  //   whip - at each rung: heat/cool until reached, then hold whipSecs.
  // Other templates are a fixed {actions} list.
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  // How many bags a template (in a mode) fills: a bag-mode ladder fills one
  // per rung; fixed templates declare {bags}. Shown on the row, the button and
  // the added workflow's name, so multi-bag runs are obvious up front.
  function tplBags(t, mode) { return t.temps ? (mode === "bag" ? t.temps.length : 0) : (t.bags || 0); }
  const WF_MODES = {
    bag:  { btn: (t) => "+ " + plural(tplBags(t, "bag"), "bag"), suffix: (t) => " (" + plural(tplBags(t, "bag"), "bag") + ")" },
    whip: { btn: () => "+ Whip", suffix: (t) => /whip/i.test(t.name) ? "" : " (whip)" },
  };
  function tplBadges(t, modes) {
    return (modes || tplModes(t)).map((m) => {
      if (m === "whip") return "💨 whip · " + plural(t.temps.length, "rung") + " × " + fmtDur(t.whipSecs || WF_WHIP_HOLD);
      if (!t.temps && tplKind(t) === "whip" && t.whipSecs) return "💨 whip · " + fmtDur(t.whipSecs);
      const n = tplBags(t, m);
      return n ? "🛍 " + plural(n, "bag") : null;
    }).filter(Boolean);
  }
  function tplModes(t) { return t.temps ? (t.modes || ["bag", "whip"]) : [null]; }
  function tplActions(t, mode) {
    if (!t.temps) return t.actions;
    const rungs = mode === "whip"
      ? t.temps.map((x) => wfLadder([x], t.whipSecs || WF_WHIP_HOLD))
      : t.temps.flatMap((x) => [wfLadder([x], t.fitSecs != null ? t.fitSecs : WF_BAG_FIT)].concat(t.fill || [fill()]));
    return (t.pre || []).concat(rungs, [{ type: "heatOff" }], t.post || []);
  }
  function tplModeNote(t, modes) {
    if (!t.temps) return null;
    return (modes || tplModes(t)).map((m) => m === "whip"
      ? "Whip: holds each rung " + fmtDur(t.whipSecs || WF_WHIP_HOLD) + "."
      : "Bags: " + (t.fitSecs != null ? t.fitSecs : WF_BAG_FIT) + " s to fit a fresh bag at each rung, then it fills.").join(" ");
  }

  const WF_TEMPLATES = [
    { name: "Vapesuvius Temp Step", temps: VAPESUVIUS, whipSecs: 200,
      desc: "The full-spectrum Vapesuvius ladder: 179 → 185 → 191 → 199 → 205 → 211 → 217 → 230 °C." },
    { name: "Vapesuvius Temp Step ⏪", temps: VAPESUVIUS.slice().reverse(), whipSecs: 200,
      desc: "The same ladder from the top down, 230 → 179 °C. Each step down waits for the chamber to cool to the next rung." },
    { name: "Dosing Capsule Step", temps: CAPSULE, whipSecs: 200,
      desc: "Four rungs sized for a dosing capsule: 185 → 197 → 211 → 230 °C." },
    { name: "Dosing Capsule Step ⏪", temps: CAPSULE.slice().reverse(), whipSecs: 200,
      desc: "The capsule ladder from the top down, 230 → 185 °C, cooling between rungs." },
    { name: "Developer's Special", temps: DEV_SPECIAL, modes: ["bag"],
      pre: [{ type: "setLED", pct: 70 }], post: [{ type: "setLED", pct: 0 }],
      fill: [fill(4), fill(1), fill(1), fill(1), fill()],
      desc: "Onyx's signature. It steps 180 → 200 °C in 5° rungs. At each one it gives a 4 s priming puff and three short bursts, then fills the bag. The LED dims at the end." },
    { name: "Really Off",
      desc: "Heat off and LED off. It's dark and quiet.",
      actions: [{ type: "heatOff" }, { type: "setLED", pct: 0 }] },
    { name: "Really On",
      desc: "Heat on at the current target, LED back to 70%.",
      actions: [{ type: "heatOn", temp: "" }, { type: "setLED", pct: 70 }] },

    { group: "magikh0e created", name: "Terpene Tour", temps: TERP_TOUR,
      desc: "Walks the landmarks in Help's boiling-point table: myrcene, limonene, CBN, linalool, borneol, CBC and geraniol (169 → 230 °C). Each rung sits 1–2 °C above the listed point, because the Volcano reads a touch low." },
    { group: "magikh0e created", name: "Flavor Chaser", temps: FLAVOR,
      desc: "Low temperatures for taste: 170 → 175 → 180 °C. This is the range where the lighter terpenes (pinene, myrcene, limonene) boil." },
    { group: "magikh0e created", name: "Even Steps (edible saver)", temps: EVEN_RUNGS,
      desc: "Only the even Vapesuvius rungs, 185 / 199 / 211 / 230 °C. Per the guide's dosing tip, this leaves more behind in already-vaped bud for edibles." },
    { group: "magikh0e created", name: "Odd Steps", temps: ODD_RUNGS,
      desc: "The other half of Even Steps: Vapesuvius rungs 1 / 3 / 5 / 7 (179 / 191 / 205 / 217 °C)." },
    { group: "magikh0e created", name: "Balloon Climb", temps: BALLOON, whipSecs: 120,
      desc: "Eleven small 5° steps from 170 to 220 °C, in the style of the Storz & Bickel app's Balloon workflow." },
    { group: "magikh0e created", name: "Express 185 / 205 / 225", temps: EXPRESS,
      desc: "A short session in three big steps." },
    { group: "magikh0e created", name: "Low & Slow", temps: LOW_SLOW, whipSecs: 300,
      desc: "A gentle session in three steps: 180, 190 and 200 °C." },
    { group: "magikh0e created", name: "Hot Finisher", temps: FINISHER,
      desc: "Squeezes the last out of a used load: 215 → 220 → 225 → 230 °C. The vapor is warm up here, so a waterpipe helps." },
    { group: "magikh0e created", name: "Quick Bag 185 °C",
      desc: "One bag at a middle-of-the-road 185 °C. It heats up, fills a 34 s bag and turns the heat off.",
      bags: 1, actions: [wfLadder([185], 5), fill(), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Microdose Bag",
      desc: "A small, light bag: 175 °C and a 20 s fill (about half the usual), then the heat turns off.",
      bags: 1, actions: [wfLadder([175], 5), fill(20), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Half Bag @ 190 °C",
      desc: "A 17 s half-bag at 190 °C, for a top-up without a full bag. Then the heat turns off.",
      bags: 1, actions: [wfLadder([190], 5), fill(17), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Lights-Out Bag",
      desc: "Quick Bag with the LED off, for a dark room. It heats to 185 °C, fills one bag and turns the heat off. The LED stays off; Really On brings it back.",
      bags: 1, actions: [{ type: "setLED", pct: 0 }, wfLadder([185], 5), fill(), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Four Bags @ 190 °C",
      desc: "A round for sharing. It heats to 190 °C, fills four bags with 30 s to swap between each, then turns the heat off.",
      bags: 4, actions: [wfLadder([190], WF_BAG_FIT), fill(),
        { type: "wait", secs: WF_BAG_FIT }, fill(),
        { type: "wait", secs: WF_BAG_FIT }, fill(),
        { type: "wait", secs: WF_BAG_FIT }, fill(), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Party Rounds",
      desc: "A bag every few minutes for a group. It heats to 190 °C, then fills a bag, waits 2½ minutes while it's passed round, and fills the next. It stops after 8 rounds (about 25 minutes) and turns the heat off, so it can't run on unattended. Press Stop to end sooner.",
      bags: PARTY_ROUNDS, actions: [wfLadder([190], WF_BAG_FIT), fill()]
        .concat(Array.from({ length: PARTY_ROUNDS - 1 }, () => [{ type: "wait", secs: PARTY_GAP }, fill()]).flat(),
          [{ type: "heatOff" }]) },
    { group: "magikh0e created", name: "Layered Bag",
      desc: "Two temperatures in one bag. It fills half at 180 °C, heats to 200 °C and fills the rest. You get 15 s to fit the bag before it starts. Keep it on while it reheats.",
      bags: 1, actions: [wfLadder([180], 15), fill(17), wfLadder([200], 0), fill(17), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Sampler",
      desc: "Three half-bags at 180, 195 and 210 °C, to compare how a load tastes across the range. Hands-free, with 30 s to fit each bag.",
      bags: 3, actions: [180, 195, 210].flatMap((x) => [wfLadder([x], WF_BAG_FIT), fill(17)]).concat([{ type: "heatOff" }]) },
    { group: "magikh0e created", name: "Whip @ 195 °C",
      desc: "Holds 195 °C for 15 minutes of whip use, then turns the heat off, so a session can't run on forever.",
      kind: "whip", whipSecs: 900, actions: [wfLadder([195], 900), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Whip @ 185 °C",
      desc: "A long, gentle hold: 185 °C for 20 minutes of whip use, then the heat turns off.",
      kind: "whip", whipSecs: 1200, actions: [wfLadder([185], 1200), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Whip @ 205 °C",
      desc: "A hotter, shorter hold: 205 °C for 10 minutes of whip use, then the heat turns off. The vapor is warm up here, so a waterpipe helps.",
      kind: "whip", whipSecs: 600, actions: [wfLadder([205], 600), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Two-Stage Whip", temps: [190, 205], modes: ["whip"], whipSecs: 480,
      desc: "Flavor first, then strength: 190 °C for 8 minutes, then 205 °C for 8 more. The heat turns off at the end." },
    { group: "magikh0e created", name: "Whip Ramp", temps: [175, 180, 185, 190, 195, 200, 205, 210, 215], modes: ["whip"], whipSecs: 90,
      desc: "Creeps up 5° every 90 seconds, 175 → 215 °C, so each pull is a little warmer than the last. About 15 minutes with heat-up." },
    { group: "magikh0e created", name: "Long Whip Session", temps: [185, 195, 205, 215], modes: ["whip"], whipSecs: 360,
      desc: "A full whip session in four steps, 185 → 215 °C, 6 minutes each (about 25 minutes)." },
    { group: "magikh0e created", name: "Whip Wind-Down", temps: [215, 200, 185], modes: ["whip"], whipSecs: 300,
      desc: "Starts hot and eases off: 215 → 200 → 185 °C, 5 minutes each. Each step down waits for the chamber to cool to the next rung." },
    { group: "magikh0e created", name: "Warm-up Hold",
      desc: "Heats to 185 °C and keeps it there for 10 minutes while you use the controls by hand, then turns the heat off.",
      actions: [wfLadder([185], 600), { type: "heatOff" }] },
    { group: "magikh0e created", name: "Ready Signal",
      desc: "Heats to 185 °C, then blinks the LED three times when it's ready. The heat stays on, for when you're across the room.",
      actions: [wfLadder([185], 0)].concat(wfBlink(3), [{ type: "setLED", pct: 70 }]) },
    { group: "magikh0e created", name: "Chamber Purge",
      desc: "Heat off, then 20 s of air to clear leftover vapor before you empty the chamber.",
      actions: [{ type: "heatOff" }, fill(20)] },
    { group: "magikh0e created", name: "Clean Cycle (empty chamber)",
      desc: "Burns off residue in an EMPTY filling chamber. It holds 230 °C for 5 minutes, runs the air for 60 s, then turns the heat off. Don't run it with a load in.",
      actions: [wfLadder([230], 300), fill(60), { type: "heatOff" }] },
  ];

  let wfTplOpen = false;

  // ---- template filters -------------------------------------------------------
  // Ladders match Bags / Whip per mode (and the row then shows only that mode's
  // button). Fixed templates have a kind: several bags, a single bag, whip, or
  // a utility, inferred from {bags} unless set explicitly.
  const WF_FILTERS = [
    { k: "all",     label: "All" },
    { k: "bag",     label: "🛍 Bags" },
    { k: "whip",    label: "💨 Whip" },
    { k: "single",  label: "Single bag" },
    { k: "utility", label: "Utility" },
  ];
  function tplKind(t) { return t.kind || (t.bags > 1 ? "bag" : t.bags === 1 ? "single" : "utility"); }
  // The modes a template shows under filter f; empty = hidden.
  function tplVisibleModes(t, f) {
    if (f === "all") return tplModes(t);
    if (t.temps) return tplModes(t).filter((m) => m === f);
    return tplKind(t) === f ? [null] : [];
  }
  let wfTplFilter = "all";
  try { const f = localStorage.getItem("volcano-tpl-filter"); if (WF_FILTERS.some((x) => x.k === f)) wfTplFilter = f; } catch (e) { /* ignore */ }

  // ---- ladder builder ---------------------------------------------------------
  // Your own start / end / step ladder, in either mode, turned into a workflow
  // through the same tplActions() the ready-made ladders use.
  const LADDER_MAX_RUNGS = 30;
  let ladderCfg = { start: 180, end: 220, step: 10, mode: "bag", fit: WF_BAG_FIT, fill: WF_BAG_FILL, hold: WF_WHIP_HOLD };
  let ladderOpen = false;
  try {
    const raw = JSON.parse(localStorage.getItem("volcano-ladder-builder") || "null");
    if (raw && typeof raw === "object") ladderCfg = Object.assign(ladderCfg, raw);
  } catch (e) { /* ignore */ }
  function saveLadderCfg() { try { localStorage.setItem("volcano-ladder-builder", JSON.stringify(ladderCfg)); } catch (e) { /* ignore */ } }

  // Rungs from start to end in `step` °C steps (either direction). The end is
  // always the last rung, even when the step doesn't land on it exactly.
  // Returns { temps } or { error }.
  function ladderTemps(c) {
    const a = Math.round(Number(c.start)), b = Math.round(Number(c.end)), st = Math.round(Number(c.step));
    if (![a, b].every((v) => Number.isFinite(v) && v >= MIN_T && v <= MAX_T)) return { error: "Start and end must be " + MIN_T + "–" + MAX_T + " °C." };
    if (!Number.isFinite(st) || st < 1) return { error: "Step must be at least 1 °C." };
    const dir = b >= a ? 1 : -1, temps = [];
    for (let t = a; dir > 0 ? t < b : t > b; t += dir * st) {
      temps.push(t);
      if (temps.length > LADDER_MAX_RUNGS) return { error: "That's over " + LADDER_MAX_RUNGS + " rungs. Use a bigger step." };
    }
    temps.push(b);
    return { temps: temps };
  }
  function ladderTemplate(c, temps) {
    return { temps: temps, whipSecs: clampSecs(c.hold) || WF_WHIP_HOLD, fitSecs: clampSecs(c.fit),
      fill: [fill(clampSecs(c.fill) || WF_BAG_FILL)] };
  }
  function ladderPreview(c) {
    const r = ladderTemps(c);
    if (r.error) return { ok: false, text: r.error };
    const n = r.temps.length, list = r.temps.join(" → ") + " °C";
    const down = r.temps.length > 1 && r.temps[1] < r.temps[0];
    const what = c.mode === "whip"
      ? "💨 whip, holds each " + fmtDur(clampSecs(c.hold) || WF_WHIP_HOLD) + " (" + fmtDur(n * (clampSecs(c.hold) || WF_WHIP_HOLD)) + " of holds)"
      : "🛍 " + plural(n, "bag");
    return { ok: true, text: plural(n, "rung") + ": " + list + " · " + what + (down ? " · steps down, cooling between rungs" : "") };
  }
  // The builder's current ladder as a one-off template, or null if invalid.
  function ladderAsTemplate() {
    const r = ladderTemps(ladderCfg);
    if (r.error) { status(r.error, "warn"); return null; }
    const t = r.temps, mode = ladderCfg.mode === "whip" ? "whip" : "bag";
    const base = "Ladder " + t[0] + "→" + t[t.length - 1] + " °C" + (t.length > 2 ? " by " + Math.round(Number(ladderCfg.step)) : "");
    return { tpl: Object.assign(ladderTemplate(ladderCfg, t), { name: base }), mode: mode };
  }
  function wfAddLadder() { const l = ladderAsTemplate(); if (l) wfAddTemplate(l.tpl, l.mode, "__ladder"); }
  function wfRunLadder() { const l = ladderAsTemplate(); if (l) wfRunTemplate(l.tpl, l.mode); }

  function renderLadderBuilder() {
    const c = ladderCfg;
    const preview = el("p", { class: "v-wf-ladprev" });
    const connected = document.body.classList.contains("v-connected");
    const runBtn = el("button", { class: "v-btn", type: "button", onClick: wfRunLadder,
      title: connected ? "Run this ladder now, without saving it" : "Connect to run" }, "▶ Run ladder");
    const addBtn = el("button", { class: "v-btn", type: "button", onClick: wfAddLadder,
      title: "Save a copy to My workflows, to edit or reuse" }, "+ Save ladder");
    const saved = wfSavedLink("__ladder");
    const refresh = () => {
      const pv = ladderPreview(c);
      preview.textContent = pv.text;
      preview.classList.toggle("v-wf-laderr", !pv.ok);
      runBtn.disabled = wfRunning || !pv.ok || !connected;
      addBtn.disabled = wfRunning || !pv.ok;
      saveLadderCfg();
    };
    const num = (key, attrs) => wfNum(c[key], (e) => { c[key] = e.target.value; refresh(); }, attrs);
    const field = (label, input, unit) => el("label", { class: "v-wf-ladfield" },
      el("span", { class: "v-wf-plabel" }, label), input, el("span", { class: "v-unit" }, unit));
    const modeBtn = (m, label) => el("button", { class: "v-wf-chip" + (c.mode === m ? " active" : ""), type: "button",
      "aria-pressed": c.mode === m ? "true" : "false", onClick: () => { c.mode = m; saveLadderCfg(); renderWorkflows(); } }, label);
    const tRange = { min: MIN_T, max: MAX_T };
    const box = el("details", { class: "v-wf-builder" },
      el("summary", null, "🪜 Build your own ladder"),
      el("p", { class: "v-hint" }, "Pick a start, an end and a step. It runs hands-free from the start rung and turns the heat off at the end. Start above the end to step down; it waits for the chamber to cool between rungs."),
      el("div", { class: "v-wf-ladrow" },
        field("start", num("start", tRange), "°C"),
        field("end", num("end", tRange), "°C"),
        field("step", num("step", { min: 1, max: 50 }), "°C")),
      el("div", { class: "v-wf-ladrow" },
        el("span", { class: "v-wf-chips", role: "group", "aria-label": "Ladder mode" },
          modeBtn("bag", "🛍 Bags"), modeBtn("whip", "💨 Whip")),
        c.mode === "whip"
          ? field("hold", num("hold", { min: 0 }), "s each")
          : [field("time to fit bag", num("fit", { min: 0 }), "s"), field("fill", num("fill", { min: 1 }), "s")]),
      preview,
      el("div", { class: "v-wf-ladbtns" }, runBtn, addBtn, saved));
    box.open = ladderOpen;
    box.addEventListener("toggle", () => { ladderOpen = box.open; });
    refresh();
    return box;
  }

  // What Exit When Temp Reached compares against. "" = unset (older saves).
  const WF_EXIT_BY = {
    target:  { label: "target",             short: "target" },
    chamber: { label: "chamber",            short: "chamber" },
    "":      { label: "target or chamber",  short: "target/chamber" },
  };

  function tplName(t, mode) {
    const multi = !mode && tplBags(t) > 1 && !/bags/i.test(t.name);   // e.g. "Sampler (3 bags)"
    return t.name + (mode ? WF_MODES[mode].suffix(t) : multi ? " (" + plural(tplBags(t), "bag") + ")" : "");
  }
  // Templates saved this visit (row key -> workflow id), so their rows say "✓ Saved · Show".
  const wfSaved = new Map();
  function wfAddTemplate(t, mode, key) {
    const name = tplName(t, mode), id = wfNewId();
    workflows.push({ id: id, name: name, actions: sanitizeActions(tplActions(t, mode)) });
    wfSaved.set(key || (t.name + "|" + (mode || "")), id);
    saveWorkflows(); renderWorkflows();
    status('Saved "' + name + '" to My workflows.', "ok");
  }
  // Run a template as-is, without saving a copy.
  function wfRunTemplate(t, mode) {
    const name = tplName(t, mode);
    runWorkflow({ id: "tpl:" + name, name: name, actions: sanitizeActions(tplActions(t, mode)) });
  }
  // Scroll to a saved workflow's card and flash it.
  function wfShowSaved(id) {
    const card = document.querySelector('.v-wf-card[data-wf-id="' + CSS.escape(id) + '"]');
    if (!card) { renderWorkflows(); return; }   // deleted since: the row falls back to "+ Save"
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("v-wf-flash"); void card.offsetWidth; card.classList.add("v-wf-flash");
  }
  function wfSavedLink(key) {
    const id = wfSaved.get(key);
    if (!id || !workflows.some((w) => w.id === id)) return null;
    return el("button", { class: "v-mini v-wf-saved", type: "button", title: "Show it in My workflows",
      onClick: () => wfShowSaved(id) }, "✓ Saved · Show ↓");
  }

  function renderTemplates() {
    const box = el("div", { class: "v-wf-tpls" },
      el("p", { class: "v-hint" }, "Ready-made workflows. ▶ runs one straight away; + Save keeps an editable copy in My workflows below."),
      renderLadderBuilder());
    const count = (f) => WF_TEMPLATES.filter((t) => tplVisibleModes(t, f).length).length;
    box.append(el("div", { class: "v-wf-chips v-wf-filters", role: "group", "aria-label": "Filter templates" },
      WF_FILTERS.map((f) => el("button", { class: "v-wf-chip" + (wfTplFilter === f.k ? " active" : ""), type: "button",
        "aria-pressed": wfTplFilter === f.k ? "true" : "false",
        onClick: () => { wfTplFilter = f.k; try { localStorage.setItem("volcano-tpl-filter", f.k); } catch (e) { /* ignore */ } renderWorkflows(); } },
        f.label + " (" + count(f.k) + ")"))));
    const connected = document.body.classList.contains("v-connected");
    let group = null;
    WF_TEMPLATES.forEach((t) => {
      const modes = tplVisibleModes(t, wfTplFilter);
      if (!modes.length) return;
      const g = t.group || "From Project Onyx";
      if (g !== group) { group = g; box.append(el("h3", { class: "v-wf-tplgroup" }, g)); }
      const note = tplModeNote(t, modes);
      box.append(el("div", { class: "v-wf-tpl" },
        el("div", { class: "v-wf-tpltext" },
          el("strong", null, t.name),
          el("span", { class: "v-wf-tplbadges" }, tplBadges(t, modes).map((b) => el("span", { class: "v-wf-badge" }, b))),
          el("span", { class: "v-wf-tpldesc" }, t.desc),
          note && el("span", { class: "v-wf-tpldesc v-wf-tplmodes" }, note)),
        el("div", { class: "v-wf-tplbtns" }, modes.map((m) => {
          const key = t.name + "|" + (m || ""), n = tplBags(t, m);
          const label = m === "whip" ? "Whip" : n > 1 ? plural(n, "bag") : "Run";
          return el("div", { class: "v-wf-tplact" },
            el("button", { class: "v-btn", type: "button", disabled: wfRunning || !connected,
              title: connected ? "Run now, without saving a copy" : "Connect to run", onClick: () => wfRunTemplate(t, m) }, "▶ " + label),
            wfSavedLink(key) || el("button", { class: "v-mini", type: "button", disabled: wfRunning,
              title: "Save a copy to My workflows, to edit or reuse", onClick: () => wfAddTemplate(t, m, key) }, "+ Save"));
        }))));
    });
    return box;
  }

  let workflows = [];
  let wfSeq = 1;
  let wfRunning = false, wfStop = false, wfRunId = null;
  let wfRunName = "", wfRunText = "";   // shown in the running banner
  let wfStopHeat = false;               // "Stop & heat off" was pressed

  function loadWorkflows() {
    try {
      const raw = localStorage.getItem("volcano-workflows");
      if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
    } catch (e) { /* ignore */ }
    return [];
  }
  function saveWorkflows() {
    try { localStorage.setItem("volcano-workflows", JSON.stringify(workflows)); } catch (e) { /* ignore */ }
  }
  function wfNewId() { return "wf" + (wfSeq++) + "_" + Math.max(0, workflows.length); }

  function clampT(v) { v = Math.round(Number(v)); if (!Number.isFinite(v)) return MIN_T; return Math.min(MAX_T, Math.max(MIN_T, v)); }
  function clampSecs(v) { v = Math.round(Number(v)); return Number.isFinite(v) && v > 0 ? v : 0; }
  function clampPct(v) { v = Math.round(Number(v)); if (!Number.isFinite(v)) return 0; return Math.min(100, Math.max(0, v)); }

  function defaultAction(type) {
    switch (type) {
      case "heatOn": return { type, temp: "" };
      case "fanOn": case "fanOnGlobal": return { type, secs: 41 };
      case "wait": return { type, secs: 30 };
      case "setLED": return { type, pct: 70 };
      case "exitWhenTemp": return { type, temp: 200, by: "target" };
      case "conditionalTemp": return { type, def: { temp: 179, wait: 30 }, conditions: [{ ifTemp: 179, thenSet: 185, wait: 30 }] };
      default: return { type };  // heatOff, loop
    }
  }

  function wfDesc(a) {
    switch (a.type) {
      case "heatOn": return "Heat on" + (a.temp != null && a.temp !== "" ? " → " + a.temp + " °C" : "");
      case "heatOff": return "Heat off";
      case "fanOn": return "Fan " + (a.secs || 0) + "s";
      case "fanOnGlobal": return "Fan " + (a.secs || 0) + "s (bg)";
      case "wait": return "Wait " + (a.secs || 0) + "s";
      case "setLED": return "LED " + (a.pct || 0) + "%";
      case "exitWhenTemp": return "Exit when " + (WF_EXIT_BY[a.by] || WF_EXIT_BY[""]).short + " ≥ " + (a.temp || 0) + " °C";
      case "conditionalTemp": return "Conditional temp set";
      case "loop": return "Loop from beginning";
      default: return a.type;
    }
  }

  // ---- executor -------------------------------------------------------------

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
  function wfSetRun(txt) {
    wfRunText = txt;
    ["v-wf-run", "v-dev-runtext"].forEach((id) => { const el = $(id); if (el) el.textContent = txt; });
  }

  // ---- run helpers: keep the screen awake, bag cues ---------------------------
  // A phone that sleeps mid-run can suspend the page and drop the BLE link, so a
  // running workflow holds a screen wake lock (re-taken when the tab returns).
  let wfWakeLock = null;
  async function wfKeepAwake(on) {
    try {
      if (on) {
        if (!wfWakeLock && navigator.wakeLock && document.visibilityState === "visible") {
          wfWakeLock = await navigator.wakeLock.request("screen");
          wfWakeLock.addEventListener("release", () => { wfWakeLock = null; });
        }
      } else if (wfWakeLock) {
        const lock = wfWakeLock; wfWakeLock = null; await lock.release();
      }
    } catch (e) { wfWakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (wfRunning && document.visibilityState === "visible") wfKeepAwake(true);
  });

  // Beep (and vibrate where supported) when it's time to fit a bag and when it's full.
  let wfCuesOn = true;
  try { wfCuesOn = localStorage.getItem("volcano-cues") !== "0"; } catch (e) { /* ignore */ }
  let wfAudio = null;
  function wfPrepareAudio() {   // called from the Run click, so the browser allows sound
    if (!wfCuesOn) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !wfAudio) wfAudio = new AC();
      if (wfAudio && wfAudio.state === "suspended") wfAudio.resume();
    } catch (e) { wfAudio = null; }
  }
  function wfBeep(times, ms) {
    if (!wfCuesOn) return;
    try {
      const tapped = !navigator.userActivation || navigator.userActivation.hasBeenActive;   // vibrate needs a prior tap
      if (navigator.vibrate && tapped) navigator.vibrate(times > 1 ? [150, 100, 150] : [400]);
      if (!wfAudio) return;
      const t0 = wfAudio.currentTime;
      for (let k = 0; k < times; k++) {
        const o = wfAudio.createOscillator(), g = wfAudio.createGain();
        const at = t0 + k * (ms + 120) / 1000;
        o.frequency.value = 880; o.connect(g); g.connect(wfAudio.destination);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
        o.start(at); o.stop(at + ms / 1000 + 0.02);
      }
    } catch (e) { /* no sound is fine */ }
  }
  const WF_FILL_MIN = 10;   // a blocking fan step this long is a bag fill
  function wfIsFill(a) { return !!a && a.type === "fanOn" && (a.secs || 0) >= WF_FILL_MIN; }
  // Is the pause at step i the window for fitting a bag? Yes if a fill follows
  // before the next pause (short priming puffs in between are fine).
  function wfFitsBag(actions, i) {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[j];
      if (wfIsFill(a)) return true;
      if (a.type !== "fanOn" && a.type !== "setLED") return false;
    }
    return false;
  }

  async function wfSleep(secs, label) {
    secs = Math.max(0, Math.round(secs));
    for (let r = secs; r > 0; r--) {
      if (wfStop) return;
      wfSetRun(label + " — " + fmtDur(r));
      await sleep(1000);
    }
  }
  // Block until the chamber is at t (°C), give or take WF_COOL_TOL above, or
  // Stop is pressed. Below t it heats; well above t (stepping a ladder down,
  // or starting with a still-hot chamber) it waits for the chamber to cool, so
  // the rung really is that temperature. The Volcano climbs roughly 1 °C/s
  // but cools slowly, hence the separate ceilings.
  async function wfHeatTo(t) {
    const started = Date.now();
    while (!wfStop) {
      const cur = await readCurrentTemp();
      if (cur != null) curTemp = cur;
      if (cur != null && cur >= t && cur <= t + WF_COOL_TOL) return;
      const cooling = cur != null && cur > t + WF_COOL_TOL;
      const limit = cooling ? WF_COOL_TIMEOUT_MS : WF_HEAT_TIMEOUT_MS;
      if (Date.now() - started > limit)
        throw new Error("didn't " + (cooling ? "cool" : "heat") + " to " + t + " °C within " + Math.round(limit / 60000) + " min");
      wfSetRun((cooling ? "Cooling to " : "Heating to ") + fmtT(t) + (cur != null ? " — now " + fmtT(cur) : ""));
      await sleep(1000);
    }
  }
  async function readTargetTemp()  { try { return Math.round(parseTemp(await setTempChar.readValue())); } catch (e) { return null; } }
  async function readCurrentTemp() { try { return Math.round(parseTemp(await curTempChar.readValue())); } catch (e) { return null; } }
  async function setTargetTemp(t) {
    target = Math.min(MAX_T, Math.max(MIN_T, Math.round(t))); showTarget();
    const buf = new Uint8Array(2); new DataView(buf.buffer).setUint16(0, target * 10, true);
    const ch = setTempChar || await svc.getCharacteristic(SET_TEMP);
    if (ch.writeValueWithResponse) await ch.writeValueWithResponse(buf); else await ch.writeValue(buf);
  }

  async function runWorkflow(wf) {
    if (!svc) { status("Connect first to run a workflow.", "warn"); return; }
    if (wfRunning) return;
    if (!wf.actions || !wf.actions.length) { status("This workflow has no actions.", "warn"); return; }
    if (!confirm('Run "' + (wf.name || "workflow") + '"? It drives the heater and pump — don’t leave it unattended.')) return;
    wfRunning = true; wfStop = false; wfStopHeat = false; wfRunId = wf.id;
    wfRunName = wf.name || "workflow"; wfRunText = "Starting…";
    wfPrepareAudio();
    wfKeepAwake(true);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }   // avoid GATT contention during the run
    renderWorkflows();
    let i = 0, guard = 0, paused = false;
    try {
      while (i < wf.actions.length && !wfStop) {
        if (++guard > 100000) throw new Error("step limit exceeded");
        const a = wf.actions[i];
        wfSetRun("Step " + (i + 1) + "/" + wf.actions.length + " — " + wfDesc(a));
        switch (a.type) {
          case "heatOn":
            await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
            if (a.temp != null && a.temp !== "") await setTargetTemp(a.temp);
            i++; break;
          case "heatOff":
            await write(HEAT_OFF, [0]); heatOn = false; setLed("v-heatled", false); i++; break;
          case "fanOn":
            await write(FAN_ON, [1]); fanOn = true; setLed("v-fanled", true);
            await wfSleep(a.secs, wfIsFill(a) ? "Filling bag" : "Fan");
            await write(FAN_OFF, [0]); fanOn = false; setLed("v-fanled", false);
            if (wfIsFill(a) && !wfStop) wfBeep(1, 450);   // bag full
            paused = true; i++; break;
          case "fanOnGlobal":
            await write(FAN_ON, [1]); fanOn = true; setLed("v-fanled", true);
            if (a.secs > 0) setTimeout(() => { write(FAN_OFF, [0]).catch(() => {}); fanOn = false; setLed("v-fanled", false); }, a.secs * 1000);
            i++; break;
          case "wait": {
            const fit = wfFitsBag(wf.actions, i) && a.secs > 0;
            if (fit) wfBeep(2, 150);
            await wfSleep(a.secs, fit ? "Fit a fresh bag" : "Wait"); paused = true; i++; break;
          }
          case "setLED":
            await writeU16(LED_BRIGHT, clampPct(a.pct)); i++; break;
          case "exitWhenTemp": {
            // "target" (Onyx's rule) ignores the chamber, so a hot start or a
            // bag fill dragging the reading down can't trip or miss the exit.
            // "chamber" waits on the real temperature. Unset (older saves) = either.
            const lim = clampT(a.temp);
            const cur = a.by === "target" ? null : await readCurrentTemp();
            const set = a.by === "chamber" ? null : await readTargetTemp();
            if ((cur != null && cur >= lim) || (set != null && set >= lim)) {
              wfSetRun("Exit — reached " + fmtT(lim)); i = wf.actions.length;
            } else i++;
            break;
          }
          case "conditionalTemp": {
            const cur = await readTargetTemp();
            const cond = (a.conditions || []).find((c) => clampT(c.ifTemp) === cur);
            const set = cond ? clampT(cond.thenSet) : (a.def ? clampT(a.def.temp) : null);
            const w = cond ? cond.wait : (a.def ? a.def.wait : 0);
            await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
            if (set != null) {
              await setTargetTemp(set);
              await wfHeatTo(set);   // like Onyx: the hold starts once the rung is reached
            }
            const fit = wfFitsBag(wf.actions, i) && w > 0;
            if (fit && !wfStop) wfBeep(2, 150);
            await wfSleep(w, fit ? "Fit a fresh bag" + (set != null ? " (" + fmtT(set) + ")" : "")
              : "Hold " + (set != null ? fmtT(set) : "")); paused = true; i++; break;
          }
          case "loop":
            if (!paused) throw new Error("a Loop with no Wait/Fan step would run forever — add a Wait");
            paused = false; i = 0; await sleep(50); break;
          default: i++;
        }
      }
      wfSetRun(wfStop ? "Stopped." : "Workflow complete.");
      status(wfStop ? (wfStopHeat ? "Workflow stopped. Heater and fan off." : "Workflow stopped.") : "Workflow complete.", "ok");
    } catch (e) {
      wfSetRun("Error: " + (e.message || e));
      status("Workflow error: " + (e.message || e), "err");
    } finally {
      if (wfStopHeat && svc) {
        try {
          await write(HEAT_OFF, [0]); heatOn = false; setLed("v-heatled", false);
          await write(FAN_OFF, [0]); fanOn = false; setLed("v-fanled", false);
        } catch (e) { status("Couldn't turn the heater off: " + (e.message || e), "err"); }
      }
      wfKeepAwake(false);
      wfRunning = false; wfRunId = null;
      if (svc && !pollTimer) pollTimer = setInterval(pollStatus, 2000);   // resume polling
      renderWorkflows();
    }
  }

  // ---- editor ---------------------------------------------------------------

  // Tiny DOM builder: el("div", {class, text, value, onClick, disabled...}, ...kids)
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "value") n.value = v;
      else if (k === "disabled" || k === "selected" || k === "checked") n[k] = !!v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null) n.setAttribute(k, v);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  function wfNum(val, on, attrs) {
    return el("input", Object.assign({ class: "v-num", type: "number", inputmode: "numeric",
      value: (val == null ? "" : val), disabled: wfRunning, onInput: on }, attrs || {}));
  }

  // ---- the Control tab's Volcano drawing ---------------------------------------
  // −/+ change the target at once and send it 0.6 s after the last press, like
  // the device's own buttons; HEAT and AIR toggle the heater and fan.
  let devCommitTimer = null;
  function devBump(delta) {
    bumpTarget(delta);
    clearTimeout(devCommitTimer);
    devCommitTimer = setTimeout(() => { if (svc) commitTarget(); }, 600);
  }
  function bindDeviceButtons() {
    const act = { "v-dev-minus": () => devBump(-STEP), "v-dev-plus": () => devBump(STEP),
      "v-dev-heat": () => toggleHeat(), "v-dev-air": () => toggleFan() };
    Object.keys(act).forEach((id) => {
      const n = $(id); if (!n) return;
      const go = () => { if (n.getAttribute("aria-disabled") !== "true") act[id](); };
      n.addEventListener("click", go);
      n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  // Profile picker under the drawing: saved workflows, then templates, narrowed
  // to Bags, Whip or All.
  let devPick = "";
  let devMode = "bag";
  try { const m = localStorage.getItem("volcano-dev-mode"); if (m === "bag" || m === "whip" || m === "all") devMode = m; } catch (e) { /* ignore */ }
  // What a saved workflow does: fills bags, holds temperatures (whip), or neither.
  function wfKindOf(actions) {
    const a = actions || [];
    if (a.some(wfIsFill)) return "bag";
    if (a.some((x) => (x.type === "conditionalTemp" && x.def && x.def.wait >= 60) || (x.type === "wait" && x.secs >= 60))) return "whip";
    return "other";
  }
  function devTemplateModes(t, mode) {
    if (mode === "all") return tplModes(t);
    if (mode === "whip") return tplVisibleModes(t, "whip");
    return tplVisibleModes(t, "bag").concat(!t.temps && tplKind(t) === "single" ? [null] : []);
  }
  function devProfiles() {
    const list = workflows.filter((w) => devMode === "all" || wfKindOf(w.actions) === devMode)
      .map((w) => ({ key: "wf:" + w.id, group: "My workflows", label: w.name || "Untitled", run: () => runWorkflow(w) }));
    WF_TEMPLATES.forEach((t) => devTemplateModes(t, devMode).forEach((m) => list.push({
      key: "tpl:" + t.name + "|" + (m || ""), group: "Templates · " + (t.group || "From Project Onyx"),
      label: tplName(t, m), run: () => wfRunTemplate(t, m) })));
    return list;
  }
  function renderDevicePicker() {
    const box = $("v-dev-run"); if (!box) return;
    box.textContent = "";
    const connected = document.body.classList.contains("v-connected");
    if (wfRunning) {
      box.append(el("div", { class: "v-dev-running", role: "status" },
        el("strong", null, "▶ " + wfRunName),
        el("span", { class: "v-wf-run", id: "v-dev-runtext" }, wfRunText)),
        el("div", { class: "v-wf-runbtns" },
          el("button", { class: "v-btn v-wf-stop", type: "button", onClick: () => { wfStop = true; } }, "■ Stop"),
          el("button", { class: "v-btn v-wf-stop", type: "button", onClick: () => { wfStop = true; wfStopHeat = true; } }, "■ Stop & heat off")));
      return;
    }
    const profiles = devProfiles();
    if (!profiles.some((p) => p.key === devPick)) devPick = profiles.length ? profiles[0].key : "";
    const sel = el("select", { class: "v-wf-type v-dev-select", "aria-label": "Workflow or template to run",
      onChange: (e) => { devPick = e.target.value; } });
    let group = null, og = null;
    profiles.forEach((p) => {
      if (p.group !== group) { group = p.group; og = el("optgroup", { label: group }); sel.append(og); }
      og.append(el("option", { value: p.key, selected: p.key === devPick }, p.label));
    });
    const modeBtn = (m, label) => el("button", { class: "v-wf-chip" + (devMode === m ? " active" : ""), type: "button",
      "aria-pressed": devMode === m ? "true" : "false",
      onClick: () => { devMode = m; try { localStorage.setItem("volcano-dev-mode", m); } catch (e) { /* ignore */ } renderDevicePicker(); } }, label);
    box.append(el("div", { class: "v-wf-chips v-dev-modes", role: "group", "aria-label": "Show bag or whip sessions" },
      modeBtn("bag", "🛍 Bags"), modeBtn("whip", "💨 Whip"), modeBtn("all", "All")));
    box.append(el("div", { class: "v-dev-pick" }, sel,
      el("button", { class: "v-btn", type: "button", disabled: !connected || !profiles.length,
        title: connected ? "Run the selected workflow or template" : "Connect to run",
        onClick: () => { const p = devProfiles().find((x) => x.key === devPick); if (p) p.run(); } }, "▶ Run")));
  }

  function renderWorkflows() {
    renderDevicePicker();
    const box = $("v-workflows"); if (!box) return;
    box.textContent = "";
    const connected = document.body.classList.contains("v-connected");
    box.append(el("div", { class: "v-wf-bar" },
      el("button", { class: "v-btn", type: "button", disabled: wfRunning, onClick: wfCreate }, "+ New workflow"),
      el("button", { class: "v-btn" + (wfTplOpen ? " active" : ""), type: "button", "aria-expanded": wfTplOpen ? "true" : "false",
        onClick: () => { wfTplOpen = !wfTplOpen; renderWorkflows(); } }, "📋 Templates"),
      el("button", { class: "v-btn", type: "button", disabled: wfRunning, onClick: wfImport,
        title: "Paste a share link or a workflow's JSON" }, "Import"),
      el("button", { class: "v-btn", type: "button", disabled: !workflows.length && !presets.length, onClick: wfBackup,
        title: "Download every saved workflow and your presets as one file" }, "⤓ Backup"),
      el("button", { class: "v-btn", type: "button", disabled: wfRunning, onClick: wfRestorePick,
        title: "Add the workflows (and presets) from a backup file" }, "⤒ Restore"),
      el("label", { class: "v-check v-wf-cues", title: "Beep (and vibrate on phones) when it's time to fit a bag, and when it's full" },
        el("input", { type: "checkbox", checked: wfCuesOn, onChange: (e) => {
          wfCuesOn = e.target.checked;
          try { localStorage.setItem("volcano-cues", wfCuesOn ? "1" : "0"); } catch (err) { /* ignore */ }
          if (wfCuesOn) { wfPrepareAudio(); wfBeep(1, 120); }   // a sample beep
        } }), " 🔔 Sound & vibration cues")));
    // Whatever is running (a saved workflow or a template) shows here, with Stop.
    if (wfRunning) box.append(el("div", { class: "v-wf-runbar", role: "status" },
      el("div", { class: "v-wf-runtext" },
        el("strong", null, "▶ Running: " + wfRunName),
        el("span", { class: "v-wf-run", id: "v-wf-run" }, wfRunText)),
      el("div", { class: "v-wf-runbtns" },
        el("button", { class: "v-btn v-wf-stop", type: "button", title: "Stop here; leave the heater as it is",
          onClick: () => { wfStop = true; } }, "■ Stop"),
        el("button", { class: "v-btn v-wf-stop", type: "button", title: "Stop and turn the heater and fan off",
          onClick: () => { wfStop = true; wfStopHeat = true; } }, "■ Stop & heat off"))));
    if (wfTplOpen) box.append(renderTemplates());
    box.append(el("h2", { class: "v-wf-mine" }, "My workflows" + (workflows.length ? " (" + workflows.length + ")" : "")));
    if (!workflows.length)
      box.append(el("p", { class: "v-hint" }, "Nothing saved yet. Run or save a template" + (wfTplOpen ? " above" : " (📋 Templates)") + ", or start a + New workflow."));
    workflows.forEach((wf) => box.append(renderWorkflowCard(wf, connected)));
  }

  function renderWorkflowCard(wf, connected) {
    const running = wfRunning && wfRunId === wf.id;
    const card = el("div", { class: "v-wf-card" + (running ? " running" : ""), "data-wf-id": wf.id });
    card.append(el("div", { class: "v-wf-head" },
      el("input", { class: "v-wf-name", type: "text", value: wf.name || "", "aria-label": "Workflow name",
        disabled: wfRunning, onInput: (e) => { wf.name = e.target.value; saveWorkflows(); } }),
      running
        ? el("button", { class: "v-btn v-wf-stop", type: "button", onClick: () => { wfStop = true; } }, "■ Stop")
        : el("button", { class: "v-btn", type: "button", disabled: !connected || wfRunning,
            title: connected ? "" : "Connect to run", onClick: () => runWorkflow(wf) }, "▶ Run"),
      el("button", { class: "v-mini", type: "button", disabled: wfRunning, title: "Copy share link", onClick: () => wfShare(wf) }, "🔗"),
      el("button", { class: "v-mini", type: "button", disabled: wfRunning, title: "Export JSON", onClick: () => wfExport(wf) }, "⤓"),
      el("button", { class: "v-mini v-wf-del", type: "button", disabled: wfRunning, title: "Delete workflow",
        onClick: () => { if (confirm('Delete workflow "' + (wf.name || "") + '"?')) { workflows = workflows.filter((w) => w !== wf); saveWorkflows(); renderWorkflows(); } } }, "🗑")));
    const list = el("div", { class: "v-wf-actions" });
    (wf.actions || []).forEach((a, ai) => list.append(renderActionRow(wf, a, ai)));
    card.append(list);
    card.append(el("button", { class: "v-btn v-wf-add", type: "button", disabled: wfRunning,
      onClick: () => { wf.actions = wf.actions || []; wf.actions.push(defaultAction("heatOn")); saveWorkflows(); renderWorkflows(); } }, "+ Add action"));
    return card;
  }

  function moveAction(wf, ai, d) {
    const j = ai + d; if (j < 0 || j >= wf.actions.length) return;
    const t = wf.actions[ai]; wf.actions[ai] = wf.actions[j]; wf.actions[j] = t;
    saveWorkflows(); renderWorkflows();
  }

  function renderActionRow(wf, a, ai) {
    const sel = el("select", { class: "v-wf-type", disabled: wfRunning,
      onChange: (e) => { wf.actions[ai] = defaultAction(e.target.value); saveWorkflows(); renderWorkflows(); } },
      WF_TYPES.map((t) => el("option", { value: t.v, selected: t.v === a.type }, t.label)));
    const ctrls = el("div", { class: "v-wf-actctrls" },
      el("button", { class: "v-mini", type: "button", disabled: wfRunning || ai === 0, title: "Move up", onClick: () => moveAction(wf, ai, -1) }, "▲"),
      el("button", { class: "v-mini", type: "button", disabled: wfRunning || ai === wf.actions.length - 1, title: "Move down", onClick: () => moveAction(wf, ai, 1) }, "▼"),
      el("button", { class: "v-mini v-wf-del", type: "button", disabled: wfRunning, title: "Delete action",
        onClick: () => { wf.actions.splice(ai, 1); saveWorkflows(); renderWorkflows(); } }, "🗑"));
    return el("div", { class: "v-wf-action" },
      el("div", { class: "v-wf-acthead" }, el("span", { class: "v-wf-num" }, "Action " + (ai + 1)), ctrls),
      el("div", { class: "v-wf-actbody" }, sel, renderActionParams(wf, a)));
  }

  function renderActionParams(wf, a) {
    const save = () => saveWorkflows();
    switch (a.type) {
      case "heatOn":
        return el("span", { class: "v-wf-params" }, el("span", { class: "v-wf-plabel" }, "target"),
          wfNum(a.temp, (e) => { a.temp = e.target.value === "" ? "" : clampT(e.target.value); save(); }, { min: MIN_T, max: MAX_T, placeholder: "no change" }),
          el("span", { class: "v-unit" }, "°C"));
      case "fanOn": case "fanOnGlobal": case "wait":
        return el("span", { class: "v-wf-params" },
          wfNum(a.secs, (e) => { a.secs = clampSecs(e.target.value); save(); }, { min: 0 }), el("span", { class: "v-unit" }, "s"));
      case "setLED":
        return el("span", { class: "v-wf-params" },
          wfNum(a.pct, (e) => { a.pct = clampPct(e.target.value); save(); }, { min: 0, max: 100 }), el("span", { class: "v-unit" }, "%"));
      case "exitWhenTemp":
        return el("span", { class: "v-wf-params" }, el("span", { class: "v-wf-plabel" }, "when"),
          el("select", { class: "v-wf-type", disabled: wfRunning, "aria-label": "Compare against",
            onChange: (e) => { if (e.target.value) a.by = e.target.value; else delete a.by; save(); } },
            Object.keys(WF_EXIT_BY).map((k) => el("option", { value: k, selected: (a.by || "") === k }, WF_EXIT_BY[k].label))),
          el("span", { class: "v-wf-plabel" }, "≥"),
          wfNum(a.temp, (e) => { a.temp = clampT(e.target.value); save(); }, { min: MIN_T, max: MAX_T }), el("span", { class: "v-unit" }, "°C"));
      case "conditionalTemp":
        return renderConditional(a);
      default:  // heatOff, loop
        return el("span", { class: "v-wf-params v-hint" }, a.type === "heatOff" ? "turns the heater off" : "jumps back to Action 1");
    }
  }

  function renderConditional(a) {
    a.def = a.def || { temp: 179, wait: 30 };
    a.conditions = a.conditions || [];
    const save = () => saveWorkflows();
    const wrap = el("div", { class: "v-wf-cond" });
    wrap.append(el("div", { class: "v-wf-condrow" },
      el("span", { class: "v-wf-plabel" }, "default"),
      wfNum(a.def.temp, (e) => { a.def.temp = clampT(e.target.value); save(); }, { min: MIN_T, max: MAX_T }), el("span", { class: "v-unit" }, "°C"),
      el("span", { class: "v-wf-plabel" }, "wait"),
      wfNum(a.def.wait, (e) => { a.def.wait = clampSecs(e.target.value); save(); }, { min: 0 }), el("span", { class: "v-unit" }, "s")));
    a.conditions.forEach((c, ci) => {
      wrap.append(el("div", { class: "v-wf-condrow" },
        el("span", { class: "v-wf-plabel" }, "if"),
        wfNum(c.ifTemp, (e) => { c.ifTemp = clampT(e.target.value); save(); }, { min: MIN_T, max: MAX_T }),
        el("span", { class: "v-wf-plabel" }, "→ set"),
        wfNum(c.thenSet, (e) => { c.thenSet = clampT(e.target.value); save(); }, { min: MIN_T, max: MAX_T }),
        el("span", { class: "v-wf-plabel" }, "wait"),
        wfNum(c.wait, (e) => { c.wait = clampSecs(e.target.value); save(); }, { min: 0 }),
        el("button", { class: "v-mini v-wf-del", type: "button", disabled: wfRunning, title: "Remove condition",
          onClick: () => { a.conditions.splice(ci, 1); save(); renderWorkflows(); } }, "🗑")));
    });
    wrap.append(el("button", { class: "v-btn v-wf-addcond", type: "button", disabled: wfRunning,
      onClick: () => { a.conditions.push({ ifTemp: 179, thenSet: 185, wait: 30 }); save(); renderWorkflows(); } }, "+ Add condition"));
    return wrap;
  }

  // ---- backup / restore: every saved workflow plus the presets, as one file ----
  const BACKUP_APP = "volcano-hybrid-control";
  function wfBackup() {
    const data = { app: BACKUP_APP, version: APP_VERSION, exported: new Date().toISOString(),
      workflows: workflows.map((w) => ({ name: w.name, actions: w.actions })), presets: presets.slice() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "volcano-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status("Backed up " + plural(workflows.length, "workflow") + " and " + plural(presets.length, "preset") + ".", "ok");
  }
  function wfRestorePick() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.addEventListener("change", () => { if (inp.files && inp.files[0]) wfRestore(inp.files[0]); });
    inp.click();
  }
  async function wfRestore(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { status("That file isn't a valid backup.", "err"); return; }
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.workflows) ? data.workflows : null);
    if (!list) { status("No workflows found in that file.", "warn"); return; }
    const key = (w) => (w.name || "") + "\u0000" + JSON.stringify(w.actions || []);
    const have = new Set(workflows.map(key));
    const incoming = list.filter((w) => w && Array.isArray(w.actions))
      .map((w) => ({ name: w.name || "Restored workflow", actions: sanitizeActions(w.actions) }));
    const fresh = incoming.filter((w) => !have.has(key(w)));
    let newPresets = data && Array.isArray(data.presets) ? sanitizePresets(data.presets) : null;
    if (newPresets && JSON.stringify(newPresets) === JSON.stringify(presets)) newPresets = null;   // already the same
    const msg = "Restore from " + file.name + "?\n\n" +
      "• Add " + plural(fresh.length, "workflow") + (incoming.length > fresh.length ? " (" + (incoming.length - fresh.length) + " already here, skipped)" : "") + "\n" +
      (newPresets && newPresets.length ? "• Replace your presets with the backup's " + newPresets.length + "\n" : "") +
      "\nNothing else is removed.";
    if (!fresh.length && !(newPresets && newPresets.length)) { status("Nothing new in that backup.", "ok"); return; }
    if (!confirm(msg)) return;
    fresh.forEach((w) => workflows.push({ id: wfNewId(), name: w.name, actions: w.actions }));
    saveWorkflows();
    if (newPresets && newPresets.length) { presets = newPresets; savePresets(); renderPresets(); }
    renderWorkflows();
    status("Restored " + plural(fresh.length, "workflow") + (newPresets && newPresets.length ? " and your presets" : "") + ".", "ok");
  }

  function wfCreate() {
    workflows.push({ id: wfNewId(), name: "New workflow " + (workflows.length + 1), actions: [] });
    saveWorkflows(); renderWorkflows();
  }
  function wfExport(wf) {
    const json = JSON.stringify(wf);
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(json).then(() => status("Workflow JSON copied to clipboard.", "ok"), () => prompt("Workflow JSON:", json));
    else prompt("Workflow JSON:", json);
  }
  // ---- sharing (URL fragment) ----

  // Base64url, UTF-8 safe.
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // Keep only known action types with clamped values — shared links are untrusted.
  function sanitizeActions(arr) {
    const known = { heatOn: 1, heatOff: 1, fanOn: 1, fanOnGlobal: 1, wait: 1, setLED: 1, exitWhenTemp: 1, conditionalTemp: 1, loop: 1 };
    return (Array.isArray(arr) ? arr : []).filter((a) => a && known[a.type]).map((a) => {
      switch (a.type) {
        case "heatOn": return { type: "heatOn", temp: (a.temp === "" || a.temp == null) ? "" : clampT(a.temp) };
        case "fanOn": case "fanOnGlobal": case "wait": return { type: a.type, secs: clampSecs(a.secs) };
        case "setLED": return { type: "setLED", pct: clampPct(a.pct) };
        case "exitWhenTemp": return Object.assign({ type: "exitWhenTemp", temp: clampT(a.temp) },
          a.by === "target" || a.by === "chamber" ? { by: a.by } : {});
        case "conditionalTemp": return {
          type: "conditionalTemp",
          def: { temp: clampT(a.def && a.def.temp), wait: clampSecs(a.def && a.def.wait) },
          conditions: (Array.isArray(a.conditions) ? a.conditions : []).map((c) => ({
            ifTemp: clampT(c && c.ifTemp), thenSet: clampT(c && c.thenSet), wait: clampSecs(c && c.wait),
          })),
        };
        default: return { type: a.type };   // heatOff, loop
      }
    });
  }

  function wfShare(wf) {
    try {
      const payload = { name: wf.name, actions: wf.actions };
      const url = location.origin + location.pathname + "#wf=" + b64urlEncode(JSON.stringify(payload));
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(url).then(
          () => status("Share link copied to clipboard.", "ok"),
          () => prompt("Share link:", url));
      else prompt("Share link:", url);
    } catch (e) { status("Share failed: " + (e.message || e), "err"); }
  }

  function wfImport() {
    const txt = prompt("Paste a workflow's JSON or a share link:");
    if (!txt) return;
    let raw = txt.trim();
    const m = /[#&?]wf=([^&\s]+)/.exec(raw);              // a share link?
    if (m) { try { raw = b64urlDecode(m[1]); } catch (e) { status("Invalid share link.", "err"); return; } }
    try {
      const obj = JSON.parse(raw);
      const arr = Array.isArray(obj) ? obj : [obj];
      let n = 0;
      arr.forEach((w) => {
        if (w && Array.isArray(w.actions)) {
          workflows.push({ id: wfNewId(), name: w.name || "Imported workflow", actions: sanitizeActions(w.actions) });
          n++;
        }
      });
      if (!n) { status("No valid workflow found.", "warn"); return; }
      saveWorkflows(); renderWorkflows();
      status("Imported " + n + " workflow(s).", "ok");
    } catch (e) { status("Import failed: invalid JSON / link.", "err"); }
  }

  // If the page was opened with a #wf=… share link, offer to import it.
  function importSharedWorkflow() {
    const m = /[#&]wf=([^&]+)/.exec(location.hash || "");
    if (!m) return;
    try { history.replaceState(null, "", location.pathname + location.search); }
    catch (e) { try { location.hash = ""; } catch (e2) {} }
    let wf;
    try {
      const obj = JSON.parse(b64urlDecode(m[1]));
      if (!obj || !Array.isArray(obj.actions)) throw new Error("no actions");
      wf = { id: wfNewId(), name: obj.name || "Shared workflow", actions: sanitizeActions(obj.actions) };
    } catch (e) { status("Couldn't read the shared workflow link.", "err"); return; }
    if (!wf.actions.length) { status("Shared link had no valid actions.", "warn"); return; }
    if (!confirm('Import shared workflow "' + wf.name + '" (' + wf.actions.length + ' actions)?')) return;
    workflows.push(wf); saveWorkflows(); renderWorkflows();
    status('Imported shared workflow "' + wf.name + '".', "ok");
    const wtab = document.querySelector('.v-tab[data-tab="workflows"]');
    if (wtab) wtab.click();
  }

  function init() {
    if (!navigator.bluetooth) {
      const u = $("v-unsupported"); if (u) u.hidden = false;
      const p = $("v-panel"); if (p) p.hidden = true;
      return;
    }
    const ver = $("v-version");
    if (ver) { ver.textContent = "v" + APP_VERSION; ver.title = "What's new in each version"; }
    showTarget();
    presets = loadPresets();
    workflows = loadWorkflows();
    if (!workflows.length) wfTplOpen = true;   // nothing saved yet: templates are the place to start
    setConnected(false);   // also renders the presets + workflows
    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bindDeviceButtons();
    bind("v-connect", "click", connect);
    bind("v-reconnect", "click", reconnect);
    bind("v-disconnect", "click", disconnect);
    bind("v-tminus", "click", () => bumpTarget(-STEP));
    bind("v-tplus", "click", () => bumpTarget(STEP));
    bind("v-setbtn", "click", commitTarget);
    bind("v-heat", "click", toggleHeat);
    bind("v-fan", "click", toggleFan);
    bind("v-fill", "click", fillBag);
    bind("v-ladder", "click", runLadder);
    bind("v-shutoff-set", "click", commitShutOff);
    bind("v-led-set", "click", commitBrightness);
    bind("v-cooldisp", "change", (e) => setCoolDisplay(e.target.checked));
    bind("v-vibrate", "change", (e) => setVibration(e.target.checked));
    const presetsBox = $("v-presets");
    if (presetsBox) presetsBox.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-temp]");
      if (!b) return;
      const t = parseInt(b.dataset.temp, 10);
      if (presetEditMode) removePreset(t);
      else if (!b.disabled) applyPreset(t);
    });
    bind("v-preset-edit", "click", togglePresetEdit);
    bind("v-preset-add", "click", addPreset);
    bind("v-preset-reset", "click", resetPresets);
    const presetAddIn = $("v-preset-add-in");
    if (presetAddIn) presetAddIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addPreset(); }
    });
    const appUnits = $("v-appunits");
    if (appUnits) appUnits.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-unit]");
      if (b) setAppUnits(b.dataset.unit === "F");
    });
    setAppUnits(appF);
    const units = $("v-units");
    if (units) units.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-unit]");
      if (b && !b.disabled) setUnits(b.dataset.unit === "C");
    });
    try {
      const ah = $("v-autoheat");
      if (ah) {
        ah.checked = localStorage.getItem("volcano-autoheat") === "1";
        ah.addEventListener("change", () => {
          try { localStorage.setItem("volcano-autoheat", ah.checked ? "1" : "0"); } catch (e) {}
        });
      }
      const lf = $("v-ladder-fill");
      if (lf) {
        lf.checked = localStorage.getItem("volcano-ladder-fill") === "1";
        lf.addEventListener("change", () => {
          try { localStorage.setItem("volcano-ladder-fill", lf.checked ? "1" : "0"); } catch (e) {}
        });
      }
    } catch (e) { /* localStorage may be unavailable */ }
    status("Ready. Click Connect and pick your Volcano.");
    setTimeout(importSharedWorkflow, 0);   // offer to import a #wf=… share link, if present
  }

  // Command API for the standalone terminal (console.js). Only exposed when a
  // console input is present in the page, so the site build (no terminal) never
  // sees it. Methods read live closure state at call time.
  if (typeof document !== "undefined" && document.getElementById("v-term-in")) {
    window.VolcanoConsole = {
      version: APP_VERSION,
      connected: function () { return !!svc; },
      connect: connect,
      disconnect: disconnect,
      setTarget: setTargetTemp,                 // async(°C)
      getTarget: function () { return target; },
      readCurrent: readCurrentTemp,             // async -> °C or null
      heat: function (on) { return write(on ? HEAT_ON : HEAT_OFF, [on ? 1 : 0]); },
      fan: function (on) { return write(on ? FAN_ON : FAN_OFF, [on ? 1 : 0]); },
      led: function (pct) { return writeU16(LED_BRIGHT, clampPct(pct)); },
      bag: fillBag,
      ladder: runLadder,
      units: function (celsius) { return setUnits(celsius); },
      listWorkflows: function () { return workflows.slice(); },
      runWorkflow: function (wf) { return runWorkflow(wf); },
      state: function () {
        return { connected: !!svc, heat: heatOn, fan: fanOn, target: target,
                 name: device && device.name };
      },
      MIN_T: MIN_T, MAX_T: MAX_T,
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
