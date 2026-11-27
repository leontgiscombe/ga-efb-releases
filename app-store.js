/*
 * GA-EFB on the App Store: until the app is live, the website says "Coming soon to the App Store".
 * Each page asks Apple's public lookup (iTunes Search API, by the app's Apple ID) whether GA-EFB is on
 * the UK App Store; once it is, every element marked data-app-store turns into a link to it (with the
 * wording in data-app-store-live, if given). Nothing to change by hand on launch day. Without the
 * lookup (offline, blocked), the page stays as it is.
 */
(function () {
  var APP_ID = "6831366894";
  var URL = "https://apps.apple.com/gb/app/ga-efb/id" + APP_ID;
  var SEEN = "ga-efb:on-app-store";

  function live() {
    var els = document.querySelectorAll("[data-app-store]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var a = document.createElement("a");
      a.className = el.className;
      a.href = URL;
      a.innerHTML = el.getAttribute("data-app-store-live") || el.innerHTML;
      el.parentNode.replaceChild(a, el);
    }
  }

  try {
    if (localStorage.getItem(SEEN) === "1") return live();
  } catch (e) {
    // storage blocked: ask Apple each time
  }
  window.gaEfbAppStore = function (r) {
    if (!r || !r.resultCount) return;
    try {
      localStorage.setItem(SEEN, "1");
    } catch (e) {
      // kept for this page only
    }
    live();
  };
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://itunes.apple.com/lookup?id=" + APP_ID + "&country=gb&callback=gaEfbAppStore";
  document.head.appendChild(s);
})();
