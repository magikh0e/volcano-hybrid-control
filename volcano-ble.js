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
    renderWorkflows();   // workflow Run buttons follow connection state
    if (!on) {
      setLed("v-heatled", false); setLed("v-fanled", false);
      const cur = $("v-cur"); if (cur) cur.textContent = "---";
      const sess = $("v-session"); if (sess) sess.textContent = "—";
      const err = $("v-error"); if (err) { err.hidden = true; err.textContent = ""; }
    }
  }

  function setLed(id, on) {
    const el = $(id);
    if (el) el.classList.toggle("on", !!on);
  }

  function showTarget() {
    const el = $("v-set");
    if (el) el.textContent = target + " °C";
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
        const c = $("v-cur"); if (c) c.textContent = curTemp + " °C";
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
        const c = $("v-cur");
        if (c) c.textContent = curTemp + " °C";
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
      status("Target set to " + target + " °C.", "ok");
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
      b.textContent = presetEditMode ? (t + "° ×") : (t + "°");
      b.disabled = presetEditMode ? false : !connected;
      b.setAttribute("aria-label",
        presetEditMode ? ("Remove " + t + " °C preset") : ("Set target " + t + " °C"));
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
    const v = Math.round(Number(inp.value));
    if (!inp.value.trim() || !Number.isFinite(v) || v < MIN_T || v > MAX_T) {
      status("Preset must be " + MIN_T + "–" + MAX_T + " °C.", "warn"); return;
    }
    if (presets.includes(v)) { status(v + " °C is already a preset.", "warn"); inp.value = ""; return; }
    presets = sanitizePresets([...presets, v]);
    savePresets();
    renderPresets();
    inp.value = "";
    status("Added " + v + " °C preset.", "ok");
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
      if (next && !confirm("Turn the heater ON? It will ramp to " + target + " °C.")) return;
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
        msg = rungLabel + " — heating to " + LADDER[idx] + " °C…";
      }
    }

    // complete only once the final rung's bag (if any) has finished
    if (last && !ladderFilling && (!fillOn || ladderRungFilled)) {
      if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; }
      resetLadderButton();
      status("Ladder complete — holding at " + LADDER[idx] + " °C.", "ok");
      return;
    }

    if (b) b.textContent = "■ Stop ladder (" + (idx + 1) + "/" + LADDER.length + ")";
    if (msg == null) {                    // default: countdown to the next rung
      const rem = LADDER_STEP_SECS - (ladderElapsed % LADDER_STEP_SECS);
      const mm = Math.floor(rem / 60), ss = String(rem % 60).padStart(2, "0");
      msg = rungLabel + " — " + LADDER[idx] + " °C · next in " + mm + ":" + ss;
    }
    status(msg, "ok");
    ladderElapsed += 1;
  }

  async function runLadder() {
    if (ladderTimer) { stopLadder("Ladder stopped.", "warn"); return; }
    const fillOn = !!($("v-ladder-fill") && $("v-ladder-fill").checked);
    if (!confirm("Start the Vapesuvius ladder? Heat turns on and the target walks " +
                 LADDER[0] + "→" + LADDER[LADDER.length - 1] + " °C, one rung every 5 min (~35 min)." +
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
  //   setLED {pct}  exitWhenTemp {temp}  loop
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

  let workflows = [];
  let wfSeq = 1;
  let wfRunning = false, wfStop = false, wfRunId = null;

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
      case "exitWhenTemp": return { type, temp: 200 };
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
      case "exitWhenTemp": return "Exit when ≥ " + (a.temp || 0) + " °C";
      case "conditionalTemp": return "Conditional temp set";
      case "loop": return "Loop from beginning";
      default: return a.type;
    }
  }

  // ---- executor -------------------------------------------------------------

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
  function wfSetRun(txt) { const el = $("v-wf-run"); if (el) el.textContent = txt; }

  async function wfSleep(secs, label) {
    secs = Math.max(0, Math.round(secs));
    for (let r = secs; r > 0; r--) {
      if (wfStop) return;
      wfSetRun(label + " — " + fmtDur(r));
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
    wfRunning = true; wfStop = false; wfRunId = wf.id;
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
            await wfSleep(a.secs, "Fan");
            await write(FAN_OFF, [0]); fanOn = false; setLed("v-fanled", false);
            paused = true; i++; break;
          case "fanOnGlobal":
            await write(FAN_ON, [1]); fanOn = true; setLed("v-fanled", true);
            if (a.secs > 0) setTimeout(() => { write(FAN_OFF, [0]).catch(() => {}); fanOn = false; setLed("v-fanled", false); }, a.secs * 1000);
            i++; break;
          case "wait":
            await wfSleep(a.secs, "Wait"); paused = true; i++; break;
          case "setLED":
            await writeU16(LED_BRIGHT, clampPct(a.pct)); i++; break;
          case "exitWhenTemp": {
            const cur = await readCurrentTemp();
            if (cur != null && cur >= clampT(a.temp)) { wfSetRun("Exit — reached " + cur + " °C"); i = wf.actions.length; }
            else i++;
            break;
          }
          case "conditionalTemp": {
            const cur = await readTargetTemp();
            const cond = (a.conditions || []).find((c) => clampT(c.ifTemp) === cur);
            const set = cond ? clampT(cond.thenSet) : (a.def ? clampT(a.def.temp) : null);
            const w = cond ? cond.wait : (a.def ? a.def.wait : 0);
            await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
            if (set != null) await setTargetTemp(set);
            await wfSleep(w, "Hold " + (set != null ? set + " °C" : "")); paused = true; i++; break;
          }
          case "loop":
            if (!paused) throw new Error("a Loop with no Wait/Fan step would run forever — add a Wait");
            paused = false; i = 0; await sleep(50); break;
          default: i++;
        }
      }
      wfSetRun(wfStop ? "Stopped." : "Workflow complete.");
      status(wfStop ? "Workflow stopped." : "Workflow complete.", "ok");
    } catch (e) {
      wfSetRun("Error: " + (e.message || e));
      status("Workflow error: " + (e.message || e), "err");
    } finally {
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

  function renderWorkflows() {
    const box = $("v-workflows"); if (!box) return;
    box.textContent = "";
    const connected = document.body.classList.contains("v-connected");
    box.append(el("div", { class: "v-wf-bar" },
      el("button", { class: "v-btn", type: "button", disabled: wfRunning, onClick: wfCreate }, "+ New workflow"),
      el("button", { class: "v-btn", type: "button", disabled: wfRunning, onClick: wfImport }, "Import")));
    if (!workflows.length)
      box.append(el("p", { class: "v-hint" }, "No workflows yet — create one to script a heat / fan / wait sequence."));
    workflows.forEach((wf) => box.append(renderWorkflowCard(wf, connected)));
  }

  function renderWorkflowCard(wf, connected) {
    const running = wfRunning && wfRunId === wf.id;
    const card = el("div", { class: "v-wf-card" + (running ? " running" : "") });
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
    if (running) card.append(el("div", { class: "v-wf-run", id: "v-wf-run" }, "Starting…"));
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
        return el("span", { class: "v-wf-params" }, el("span", { class: "v-wf-plabel" }, "when ≥"),
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
        case "exitWhenTemp": return { type: "exitWhenTemp", temp: clampT(a.temp) };
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
    showTarget();
    presets = loadPresets();
    workflows = loadWorkflows();
    setConnected(false);   // also renders the presets + workflows
    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
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
