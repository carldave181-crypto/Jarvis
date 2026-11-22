/* Mars Jarvis plugin: open real Android apps */
(function () {
  const ext = window.MarsJarvisExt; if (!ext) return;
  const APPS = [
    { name: 'Messenger', re: 'messenger|fb messenger|facebook messenger|msgr', pkg: 'com.facebook.orca', web: 'https://www.messenger.com' },
    { name: 'TikTok', re: 'tik ?tok', pkg: 'com.zhiliaoapp.musically', web: 'https://www.tiktok.com' },
    { name: 'Call of Duty Mobile', re: 'codm|cod mobile|call of duty(?: mobile)?|cod', pkg: 'com.activision.callofduty.shooter' },
    { name: 'Spotify', re: 'spotify', pkg: 'com.spotify.music', web: 'https://open.spotify.com' },
    { name: 'YouTube', re: 'you ?tube|yt', pkg: 'com.google.android.youtube', web: 'https://www.youtube.com' },
    { name: 'Chrome', re: 'chrome|google chrome', pkg: 'com.android.chrome' },
    { name: 'Brave', re: 'brave|brave browser', pkg: 'com.brave.browser' },
    { name: 'Facebook', re: 'facebook|fb|face book', pkg: 'com.facebook.katana', web: 'https://www.facebook.com' }
  ];
  const rx = /^(?:open|launch|start|run|go to|take me to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/;
  ext.pre.push(function (s, l) {
    const m = l.trim().match(rx); if (!m) return;
    const want = m[1].trim();
    for (const a of APPS) {
      if (new RegExp('^(?:' + a.re + ')$').test(want)) {
        const url = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=' + a.pkg +
          (a.web ? ';S.browser_fallback_url=' + encodeURIComponent(a.web) : '') + ';end';
        setTimeout(function () { location.href = url; }, 400);
        return 'Opening ' + a.name + '. If nothing happens, tap Send on a typed command; the phone only lets apps open from a tap.';
      }
    }
  });
})();
