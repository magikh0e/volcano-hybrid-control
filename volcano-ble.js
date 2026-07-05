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
  const LED_BRIGHT = "10110005-5354-4f52-5a26-4249434b454c"; // main svc, LED brightness (LE)
  const PRJ2     = "1010000d-5354-4f52-5a26-4249434b454c"; // svc3 PRJSTAT2: units, cooling-display
  const PRJ3     = "1010000e-5354-4f52-5a26-4249434b454c"; // svc3 PRJSTAT3: vibration
  const MASK_HEAT = 32;    // PRJSTAT1: heater enabled
  const MASK_PUMP = 8192;  // PRJSTAT1: pump / fan enabled
  // PRJSTAT2/3 flags are active-low: the feature is ON when the bit is CLEAR.
  const MASK_FAHRENHEIT   = 0x0200; // PRJSTAT2: set = device shows °F  (clear = °C)
  const MASK_DISPLAY_COOL = 0x1000; // PRJSTAT2: clear = show temp while cooling
  const MASK_VIBRATION    = 0x0400; // PRJSTAT3: clear = vibration alert on
  // Register write convention (4-byte LE): write the mask alone to CLEAR the
  // bit; write (REG_SET | mask) to SET it. Matches the HA integration exactly.
  const REG_SET = 0x10000;

  const MIN_T = 40, MAX_T = 230, STEP = 1;
  const FILL_SECS = 41;     // standard S&B Easy Valve bag fill (matches the HA script)
  const LADDER = [179, 185, 191, 199, 205, 211, 217, 230]; // Vapesuvius rungs (°C)
  const LADDER_STEP_SECS = 300;   // 5 min per rung, per the HA auto-progress automation
  const DEFAULT_PRESETS = [179, 185, 191, 199, 205, 211, 217, 230]; // editable quick-set presets (°C)

  let device = null, server = null, svc = null, svc3 = null;
  let curTempChar = null, setTempChar = null, prj1Char = null;
  let pollTimer = null, fillTimer = null, fillLeft = 0;
  let ladderTimer = null, ladderElapsed = 0, ladderIdx = -1;
  let target = 190;         // pending target shown in the UI
  let heatOn = false, fanOn = false;
  let presets = [];         // user-editable quick-set presets (°C), persisted in localStorage
  let presetEditMode = false;

  const $ = (id) => document.getElementById(id);

  function status(msg, kind) {
    const el = $("v-status");
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = kind || "";
  }

  function setConnected(on) {
    document.body.classList.toggle("v-connected", on);
    const c = $("v-connect"), d = $("v-disconnect");
    if (c) c.hidden = on;
    if (d) d.hidden = !on;
    ["v-tminus", "v-tplus", "v-setbtn", "v-heat", "v-fan", "v-fill", "v-ladder",
     "v-shutoff-in", "v-shutoff-set", "v-led-in", "v-led-set",
     "v-cooldisp", "v-vibrate"].forEach((id) => {
      const el = $(id); if (el) el.disabled = !on;
    });
    document.querySelectorAll(".v-segbtn").forEach((el) => { el.disabled = !on; });
    renderPresets();   // preset buttons follow connection state (unless editing)
    if (!on) {
      setLed("v-heatled", false); setLed("v-fanled", false);
      const cur = $("v-cur"); if (cur) cur.textContent = "---";
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
      if (prj1Char) {
        const dv = await prj1Char.readValue();
        const reg = dv.getUint32(0, true);
        heatOn = (reg & MASK_HEAT) !== 0;
        fanOn = (reg & MASK_PUMP) !== 0;
        setLed("v-heatled", heatOn);
        setLed("v-fanled", fanOn);
        const hb = $("v-heat"), fb = $("v-fan");
        if (hb) hb.textContent = heatOn ? "⏻ Heat OFF" : "⏻ Heat ON";
        if (fb) fb.textContent = fanOn ? "⬚ Fan OFF" : "⬚ Fan ON";
      }
      if (curTempChar) {
        const dv = await curTempChar.readValue();
        const c = $("v-cur"); if (c) c.textContent = Math.round(parseTemp(dv)) + " °C";
      }
    } catch (e) { /* transient read errors are fine between polls */ }
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
    server = svc = svc3 = curTempChar = setTempChar = prj1Char = null;
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
      status("Connecting…");
      server = await device.gatt.connect();
      svc = await server.getPrimaryService(SVC);
      try { svc3 = await server.getPrimaryService(SVC3); } catch (e) { svc3 = null; }

      curTempChar = await svc.getCharacteristic(CUR_TEMP);
      setTempChar = await svc.getCharacteristic(SET_TEMP);
      if (svc3) { try { prj1Char = await svc3.getCharacteristic(PRJ1); } catch (e) { prj1Char = null; } }

      // Live current-temperature via notifications.
      try {
        await curTempChar.startNotifications();
        curTempChar.addEventListener("characteristicvaluechanged", (ev) => {
          const c = $("v-cur");
          if (c) c.textContent = Math.round(parseTemp(ev.target.value)) + " °C";
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
    } catch (e) {
      if (e && e.name === "NotFoundError")
        status("No Volcano selected. If it isn't listed, disconnect Home Assistant or the S&B app first — the Volcano allows only one connection.", "warn");
      else
        status("Connect failed: " + (e.message || e), "err");
    }
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
    ladderIdx = -1;
    resetLadderButton();
    if (msg) status(msg, kind);
  }

  async function tickLadder() {
    const idx = Math.min(LADDER.length - 1, Math.floor(ladderElapsed / LADDER_STEP_SECS));
    if (idx !== ladderIdx) {
      ladderIdx = idx;
      target = LADDER[idx]; showTarget();
      try { await commitTarget(); } catch (e) { /* keep walking */ }
    }
    const b = $("v-ladder");
    if (idx >= LADDER.length - 1) {
      if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; }
      resetLadderButton();
      status("Ladder complete — holding at " + LADDER[idx] + " °C.", "ok");
      return;
    }
    const rem = LADDER_STEP_SECS - (ladderElapsed % LADDER_STEP_SECS);
    const mm = Math.floor(rem / 60), ss = String(rem % 60).padStart(2, "0");
    if (b) b.textContent = "■ Stop ladder (" + (idx + 1) + "/" + LADDER.length + ")";
    status("Ladder rung " + (idx + 1) + "/" + LADDER.length + " — " + LADDER[idx] +
           " °C · next in " + mm + ":" + ss, "ok");
    ladderElapsed += 1;
  }

  async function runLadder() {
    if (ladderTimer) { stopLadder("Ladder stopped.", "warn"); return; }
    if (!confirm("Start the Vapesuvius ladder? Heat turns on and the target walks " +
                 LADDER[0] + "→" + LADDER[LADDER.length - 1] + " °C, one rung every 5 min (~35 min).")) return;
    try {
      await write(HEAT_ON, [1]); heatOn = true; setLed("v-heatled", true);
      ladderElapsed = 0; ladderIdx = -1;
      await tickLadder();          // apply the first rung immediately
      ladderTimer = setInterval(tickLadder, 1000);
    } catch (e) { status("Ladder failed: " + (e.message || e), "err"); }
  }

  function init() {
    if (!navigator.bluetooth) {
      const u = $("v-unsupported"); if (u) u.hidden = false;
      const p = $("v-panel"); if (p) p.hidden = true;
      return;
    }
    showTarget();
    presets = loadPresets();
    setConnected(false);   // also renders the presets
    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("v-connect", "click", connect);
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
    } catch (e) { /* localStorage may be unavailable */ }
    status("Ready. Click Connect and pick your Volcano.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
