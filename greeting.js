// greeting.js — the DevTools console greeting from magikh0e.pl: a green banner, a
// self-XSS warning, and where to say hi. Shown on every page of the app.
(function () {
  try {
      var bigStyle = 'color:#8fb65f;font-family:monospace;font-size:12px;line-height:1.1;';
      var warnStyle = 'color:#ff6b6b;font-weight:bold;font-size:14px;';
      var dimStyle = 'color:#888;font-family:monospace;font-size:11px;';
      // Banner is monospaced — every row must be exactly the same column
      // count or the right border drifts. Inner width here = 66 columns;
      // each row pads to that with spaces. If you edit the title or the
      // uptime line, count chars and re-pad both rows to 66 wide before
      // you call it done. (The em-dash and en-dash are each 1 column.)
      console.log(
          '%c\n' +
          '  ╔══════════════════════════════════════════════════════════════════╗\n' +
          '  ║                                                                  ║\n' +
          '  ║    m a g i k h 0 e . p l   —   h a c k   t h e   p l a n e t     ║\n' +
          '  ║                                                                  ║\n' +
          '  ║    uptime: 1990–present.    curious? `cat` the source.           ║\n' +
          '  ║                                                                  ║\n' +
          '  ╚══════════════════════════════════════════════════════════════════╝\n',
          bigStyle
      );
      console.log('%cSTOP', warnStyle,
          '— If someone told you to paste something here, it is almost\n' +
          'certainly an attempt to compromise your account (self-XSS).\n' +
          "Don't paste code into this console unless you wrote it yourself."
      );
      console.log('%c# talk story? @magikh0e@infosec.exchange', dimStyle);
  } catch (e) { /* no styled console — silent */ }
})();
