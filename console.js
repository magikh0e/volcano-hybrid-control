// console.js — a small terminal / scripting REPL for the Volcano app.
//
// Fresh component, styled like the magikh0e.pl shell. It drives the device
// through window.VolcanoConsole (exposed by volcano-ble.js when this terminal
// is present) and mirrors every engine status message via window.volcanoEcho.
// Repo-only: the site build has no terminal and never loads this.
//
// Scripting: chain commands with ';' to run them in order, e.g.
//   heat on; wait 300; temp 220; wait 120; bag

(function () {
  "use strict";
  var out = document.getElementById("v-term-out");
  var form = document.getElementById("v-term-form");
  var input = document.getElementById("v-term-in");
  var box = document.getElementById("v-term");
  if (!out || !form || !input) return;

  function api() { return window.VolcanoConsole || null; }
  function esc(s) { var d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
  function line(html, cls) {
    var d = document.createElement("div");
    d.className = "v-term-line" + (cls ? " " + cls : "");
    d.innerHTML = html;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
    return d;
  }
  function say(text, cls) { return line(esc(text), cls); }

  // engine status messages appear in the log
  window.volcanoEcho = function (msg, kind) {
    var cls = kind === "err" ? "v-term-err" : kind === "warn" ? "v-term-warn"
            : kind === "ok" ? "v-term-ok" : "v-term-dim";
    line('<span class="v-term-sys">&bull;</span> ' + esc(msg), cls);
  };

  var HELP = [
    "commands:",
    "  help                  this list",
    "  status                connection + temperature state",
    "  connect / disconnect  open or close the BLE link",
    "  temp <40-230>         set target temperature (°C)",
    "  heat on | off         heater on / off",
    "  fan on | off | <s>    pump on/off, or run it for <s> seconds",
    "  bag                   fill a bag (41 s)",
    "  led <0-100>           LED brightness",
    "  units c | f           device display units",
    "  ladder                run the Vapesuvius ladder",
    "  wait <s>              pause <s> seconds (for scripts)",
    "  ls                    list saved workflows",
    "  run <name>            run a saved workflow",
    "  stop                  cancel a running script",
    "  clear                 wipe the screen",
    "",
    "scripts — chain with ';' to run in order:",
    "  heat on; wait 300; temp 220; wait 120; bag",
  ];

  var running = false, cancel = false;

  function needConn() {
    var V = api();
    if (!V || !V.connected()) { say("not connected — type `connect` first.", "v-term-err"); return false; }
    return true;
  }

  // live 1 Hz countdown line for wait / timed-fan
  function countdown(secs, label) {
    secs = Math.max(0, Math.round(secs));
    return new Promise(function (resolve) {
      var d = line(label + " …", "v-term-dim");
      var r = secs;
      (function tick() {
        if (cancel) { d.textContent = label + " — stopped."; resolve(); return; }
        if (r <= 0) { d.textContent = label + " done."; out.scrollTop = out.scrollHeight; resolve(); return; }
        d.textContent = label + " " + r + "s…"; out.scrollTop = out.scrollHeight;
        r -= 1; setTimeout(tick, 1000);
      })();
    });
  }

  function exec(cmd, arg) {
    var V = api();
    switch (cmd) {
      case "": return Promise.resolve();
      case "help": case "?": HELP.forEach(function (l) { say(l, "v-term-dim"); }); return Promise.resolve();
      case "clear": out.innerHTML = ""; return Promise.resolve();
      case "echo": say(arg); return Promise.resolve();
      case "stop": if (!running) say("nothing running.", "v-term-dim"); return Promise.resolve();
      case "status": case "state": {
        if (!V) { say("engine unavailable.", "v-term-err"); return Promise.resolve(); }
        var s = V.state();
        say(s.connected ? "connected" + (s.name ? " to " + s.name : "") : "disconnected", s.connected ? "v-term-ok" : "v-term-dim");
        if (s.connected) {
          say("  target " + s.target + " °C · heat " + (s.heat ? "on" : "off") + " · fan " + (s.fan ? "on" : "off"));
          return Promise.resolve(V.readCurrent()).then(function (c) { if (c != null) say("  current " + c + " °C"); });
        }
        return Promise.resolve();
      }
      case "connect": return V ? Promise.resolve(V.connect()) : Promise.resolve();
      case "disconnect": return V ? Promise.resolve(V.disconnect()) : Promise.resolve();
      case "temp": case "set": {
        if (!needConn()) return Promise.resolve();
        var t = parseInt(arg, 10);
        if (!isFinite(t) || t < V.MIN_T || t > V.MAX_T) { say("temp: need " + V.MIN_T + "–" + V.MAX_T, "v-term-err"); return Promise.resolve(); }
        return Promise.resolve(V.setTarget(t)).then(function () { say("target → " + t + " °C", "v-term-ok"); });
      }
      case "heat": {
        if (!needConn()) return Promise.resolve();
        if (!/^(on|off|1|0|true|false)$/i.test(arg)) { say("heat: on | off", "v-term-err"); return Promise.resolve(); }
        var on = /^(on|1|true)$/i.test(arg);
        return Promise.resolve(V.heat(on)).then(function () { say("heat " + (on ? "on" : "off"), "v-term-ok"); });
      }
      case "fan": case "pump": {
        if (!needConn()) return Promise.resolve();
        if (/^on$/i.test(arg)) return Promise.resolve(V.fan(true)).then(function () { say("fan on", "v-term-ok"); });
        if (/^off$/i.test(arg)) return Promise.resolve(V.fan(false)).then(function () { say("fan off", "v-term-ok"); });
        var secs = parseInt(arg, 10);
        if (isFinite(secs) && secs > 0) {
          return Promise.resolve(V.fan(true))
            .then(function () { return countdown(secs, "fan"); })
            .then(function () { return V.fan(false); })
            .then(function () { say("fan off", "v-term-ok"); });
        }
        say("fan: on | off | <seconds>", "v-term-err"); return Promise.resolve();
      }
      case "bag": return needConn() ? Promise.resolve(V.bag()) : Promise.resolve();
      case "ladder": return needConn() ? Promise.resolve(V.ladder()) : Promise.resolve();
      case "led": {
        if (!needConn()) return Promise.resolve();
        var p = parseInt(arg, 10);
        if (!isFinite(p) || p < 0 || p > 100) { say("led: 0–100", "v-term-err"); return Promise.resolve(); }
        return Promise.resolve(V.led(p)).then(function () { say("led → " + p + "%", "v-term-ok"); });
      }
      case "units": {
        if (!needConn()) return Promise.resolve();
        if (/^c/i.test(arg)) return Promise.resolve(V.units(true)).then(function () { say("units → °C", "v-term-ok"); });
        if (/^f/i.test(arg)) return Promise.resolve(V.units(false)).then(function () { say("units → °F", "v-term-ok"); });
        say("units: c | f", "v-term-err"); return Promise.resolve();
      }
      case "wait": case "sleep": {
        var w = parseInt(arg, 10);
        if (!isFinite(w) || w < 0) { say("wait: <seconds>", "v-term-err"); return Promise.resolve(); }
        return countdown(w, "wait");
      }
      case "ls": case "workflows": {
        if (!V) return Promise.resolve();
        var ws = V.listWorkflows();
        if (!ws.length) { say("no saved workflows — build some on the Workflows tab.", "v-term-dim"); return Promise.resolve(); }
        ws.forEach(function (w) { say("  " + (w.name || "(unnamed)") + "  — " + (w.actions ? w.actions.length : 0) + " actions", "v-term-dim"); });
        return Promise.resolve();
      }
      case "run": {
        if (!needConn()) return Promise.resolve();
        if (!arg.trim()) { say("run: <workflow name> (try `ls`)", "v-term-err"); return Promise.resolve(); }
        var name = arg.trim().toLowerCase();
        var wf = V.listWorkflows().filter(function (w) { return (w.name || "").toLowerCase() === name; })[0];
        if (!wf) { say('run: no workflow named "' + arg.trim() + '" (try `ls`)', "v-term-err"); return Promise.resolve(); }
        say('running workflow "' + wf.name + '"… (steps below; Stop on the Workflows tab)', "v-term-ok");
        V.runWorkflow(wf);   // engine-managed; status echoes here. Not awaited.
        return Promise.resolve();
      }
      default:
        say(cmd + ": command not found — try `help`", "v-term-err");
        return Promise.resolve();
    }
  }

  async function runLine(raw) {
    var text = (raw || "").trim();
    if (!text) return;
    line('<span class="v-term-prompt">volcano&nbsp;$</span> ' + esc(text), "v-term-cmd");
    var parts = text.split(";");
    for (var i = 0; i < parts.length; i++) {
      if (cancel) { say("— stopped.", "v-term-warn"); break; }
      var seg = parts[i].trim();
      if (!seg || seg.charAt(0) === "#") continue;
      var sp = seg.indexOf(" ");
      var cmd = (sp === -1 ? seg : seg.slice(0, sp)).toLowerCase();
      var arg = sp === -1 ? "" : seg.slice(sp + 1).trim();
      try { await exec(cmd, arg); }
      catch (e) { say(cmd + ": " + (e && e.message || e), "v-term-err"); }
    }
  }

  // command history
  var hist = [], hi = -1;
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp") {
      if (hist.length) { hi = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1); input.value = hist[hi]; e.preventDefault(); }
    } else if (e.key === "ArrowDown") {
      if (hi >= 0) { hi += 1; if (hi >= hist.length) { hi = -1; input.value = ""; } else input.value = hist[hi]; e.preventDefault(); }
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = input.value; input.value = "";
    if (v.trim()) { hist.push(v); hi = -1; }
    if (running) {
      if (v.trim().toLowerCase() === "stop") { cancel = true; }
      else { line('<span class="v-term-prompt">volcano&nbsp;$</span> ' + esc(v), "v-term-cmd"); say("busy — a script is running. type `stop` to cancel.", "v-term-warn"); }
      return;
    }
    running = true; cancel = false;
    runLine(v).then(function () { running = false; });
  });

  if (box) box.addEventListener("click", function (e) {
    if (e.target && e.target.tagName === "A") return;
    if (document.activeElement !== input) { try { input.focus(); } catch (e2) {} }
  });

  say("volcano web-ble console — type `help`, or e.g. `temp 190; heat on`.", "v-term-dim");
})();
