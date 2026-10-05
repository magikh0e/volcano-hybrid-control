// greeting.js — the DevTools console greeting, after the one on magikh0e.pl: a green
// banner, a warning about pasting code here (self-XSS), and where to say hi or report
// a bug. Shown on every page of the app. The banner is monospaced: every row is padded
// to the same 66 columns inside the box, or the right border drifts.
(function () {
  try {
    var bigStyle = 'color:#8fb65f;font-family:monospace;font-size:12px;line-height:1.1;';
    var warnStyle = 'color:#ff6b6b;font-weight:bold;font-size:14px;';
    var dimStyle = 'color:#888;font-family:monospace;font-size:11px;';
    console.log(
      '%c' +
      "\n" +
      "  ╔══════════════════════════════════════════════════════════════════╗\n" +
      "  ║                                                                  ║\n" +
      "  ║    v o l c a n o   —   h e a t   t h e   p l a n e t             ║\n" +
      "  ║                                                                  ║\n" +
      "  ║    no app. no backend.    curious? ?demo has fakeVolcano.        ║\n" +
      "  ║    source: github.com/magikh0e/volcano-hybrid-control            ║\n" +
      "  ║                                                                  ║\n" +
      "  ╚══════════════════════════════════════════════════════════════════╝\n",
      bigStyle
    );
    console.log('%cSTOP', warnStyle,
      "— If someone told you to paste something here, it could take over this page," + "\n" +
      "including the heater on your Volcano. Don't paste code into this console" + "\n" +
      "unless you wrote it yourself."
    );
    console.log('%c# talk story? @magikh0e@infosec.exchange\n# found a bug? "Report a problem" at the bottom of the app', dimStyle);
  } catch (e) { /* no styled console: silent */ }
})();
