// GA-EFB's owner dashboard. It signs in with the owner's GA-EFB account and asks the account
// service directly (server/src/auth/setupSql.ts: efb_owner_dashboard, efb_owner_extend_trial,
// efb_add_licence_keys...). Those functions check it's the owner, so this page is safe to
// publish: anyone else only gets "not the owner". The address and key are public by design.
(() => {
  "use strict";

  const ACCOUNTS = "https://gzdxvcrhfmlbgbziykjk.supabase.co";
  const PUBLIC_KEY = "sb_publishable_KrYVpUmemtBqKSsYkY43pw_LOD3PrFI";
  const STORE = "ga-efb-dashboard";
  // GA-EFB's cache on Cloudflare (cloud/rain-worker): it counts what Rainbow, openAIP and Apple are asked.
  const CACHE = "https://cache.ga-efb.co.uk";
  const app = document.getElementById("app");

  // ---- small helpers ----

  /** An element: h("div.row", {onclick}, child, "text", ...). Text is always text, never HTML. */
  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split(".");
    const el = document.createElement(name || "div");
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat())
      if (c != null && c !== false)
        el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const day = (d) =>
    d
      ? new Date(d).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
  const money = (pence, currency) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: (currency || "gbp").toUpperCase(),
    }).format((pence || 0) / 100);

  function saved() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "null");
    } catch {
      return null;
    }
  }
  function save(s) {
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify(s));
      else localStorage.removeItem(STORE);
    } catch {
      // private browsing: signed in for this visit only
    }
  }

  // ---- the account service ----

  class Refused extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function call(path, body, token) {
    let res;
    try {
      res = await fetch(ACCOUNTS + path, {
        method: "POST",
        headers: {
          apikey: PUBLIC_KEY,
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw new Refused(
        "The account service couldn't be reached. Check the internet connection.",
        0,
        "offline",
      );
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        (data && (data.msg || data.message || data.error_description)) ||
        "The account service answered " + res.status + ".";
      throw new Refused(
        msg,
        res.status,
        (data && (data.error_code || data.code)) || "",
      );
    }
    return data;
  }

  let session = saved();

  async function signIn(email, password) {
    const s = await call("/auth/v1/token?grant_type=password", {
      email,
      password,
    });
    session = {
      email: s.user?.email || email,
      access: s.access_token,
      refresh: s.refresh_token,
      expires: (s.expires_at || 0) * 1000,
    };
    save(session);
  }

  async function token() {
    if (!session) throw new Refused("Sign in first.", 401, "signin");
    if (session.expires - Date.now() > 60_000) return session.access;
    try {
      const s = await call("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: session.refresh,
      });
      session = {
        ...session,
        access: s.access_token,
        refresh: s.refresh_token,
        expires: (s.expires_at || 0) * 1000,
      };
      save(session);
      return session.access;
    } catch (err) {
      if (err.code !== "offline") signOut();
      throw err;
    }
  }

  const rpc = async (fn, args) =>
    call("/rest/v1/rpc/" + fn, args, await token());
  /** A function that isn't there yet: the account service needs its setup. */
  const missing = (err) =>
    err instanceof Refused && (err.status === 404 || err.code === "PGRST202");

  function signOut() {
    session = null;
    save(null);
    showSignIn();
  }

  // ---- icons, avatars and the pieces every screen is made of ----

  const NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
    out: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    money: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
    people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5 5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ended: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    key: '<circle cx="8" cy="8" r="4.5"/><path d="M11 11l9 9M16 16l2-2M18.5 18.5l2-2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 14h9"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
    bin: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    rain: '<path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 18 9a3 3 0 0 1 0 6z"/><path d="M8 18l-1 2M12 18l-1 2M16 18l-1 2"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    cloud: '<path d="M7 18a5 5 0 1 1 1.2-9.8A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18 18z"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    apple: '<path d="M12 7c-1-2.5 1-4 3-4 .2 2-1.4 3.8-3 4z"/><path d="M12 8c-1.5-1-5-1.2-6 2.5-1 3.7 1.5 9.5 4 9.5 1 0 1.3-.5 2-.5s1 .5 2 .5c2.2 0 4-4.2 4-5.5-2.3-1-2.8-4.6-.5-6-1.8-2-4.2-1.4-5.5-.5z"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  };
  function icon(name, big) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "i" + (big ? " big" : ""));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", name === "back" ? "2.4" : "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[name] || ""; // our own fixed shapes, never data
    return svg;
  }
  const ico = (name, tone) => h("span.ico.t-" + (tone || "grey"), {}, icon(name));
  const badge = (text, kind) => h("span.badge" + (kind ? "." + kind : ""), {}, text);

  // Each account's own colour, from its email, for its initials.
  const AVATAR = ["green", "sky", "violet", "amber", "rose", "teal", "indigo", "orange"];
  function avatar(email, big) {
    const e = (email || "").toLowerCase();
    const hash = [...e].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const words = e.split("@")[0].split(/[^a-z]+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
    return h("span.avatar.t-" + AVATAR[hash % AVATAR.length] + (big ? ".big" : ""), { "aria-hidden": "true" }, initials);
  }

  let toastTimer = 0;
  /** A short message at the bottom, as the hub shows after an action. */
  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) document.body.append((el = h("div.toast", { role: "status" })));
    el.textContent = message;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /** The top bar's round buttons, like the hub's back button. */
  const roundButton = (name, label, onclick, extra) =>
    h("button.round" + (extra || ""), { type: "button", "aria-label": label, title: label, onclick }, icon(name, name === "back"));
  const backLink = () =>
    h("a.round", { href: "../", "aria-label": "Back to the GA-EFB website", title: "GA-EFB website" }, icon("back", true));

  // ---- signing in ----

  function showSignIn(message) {
    closeSheet(true);
    app.replaceChildren(
      document.getElementById("signin").content.cloneNode(true),
    );
    const form = app.querySelector("form");
    const error = app.querySelector(".error");
    if (message) {
      error.textContent = message;
      error.hidden = false;
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      button.textContent = "Signing In…";
      error.hidden = true;
      try {
        await signIn(form.email.value.trim(), form.password.value);
        await load();
      } catch (err) {
        error.textContent = /invalid/i.test(err.message)
          ? "The email or password isn't right."
          : err.message;
        error.hidden = false;
        button.disabled = false;
        button.textContent = "Sign In";
      }
    });
  }

  // ---- the dashboard ----

  let data = null;
  let setupNeeded = null; // null, or the link that opens Supabase with the setup filled in
  let setupHere = null; // the SHA-256 of the setup to run from here (efb_run_setup), if it can be
  // The dashboard's three parts, one at a time: remembered on this device, and #payments etc. opens one.
  const TABS = [
    ["analytics", "Analytics"],
    ["payments", "Payments"],
    ["users", "Users"],
  ];
  const TAB_KEY = "ga-efb-dashboard-tab";
  const firstTab = () => {
    const fromHash = location.hash.slice(1);
    if (TABS.some(([id]) => id === fromHash)) return fromHash;
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (TABS.some(([id]) => id === saved)) return saved;
    } catch {
      // private browsing
    }
    return "analytics";
  };

  const view = {
    tab: firstTab(),
    filter: "all",
    sort: "newest",
    search: "",
    shown: 50,
    subs: 20,
    keys: null,
    open: null, // the email of the customer whose sheet is open
  };

  let usage = null;
  let supabaseUsage = null;

  async function load() {
    if (!session) return showSignIn();
    // The first time, a loading line; after that the page stays and the Refresh button pulses
    // (until the page is drawn again with what came back).
    if (!data) app.replaceChildren(h("p.loading", {}, "Loading…"));
    app.querySelector(".refresh")?.classList.add("busy");
    await fetchAll();
  }

  async function fetchAll() {
    // Which setup the account service has had, and the current one (published with this page).
    const [current, version] = await Promise.all([
      fetch("../setup/current.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      rpc("efb_setup_version").catch((err) =>
        missing(err) ? "" : Promise.reject(err),
      ),
    ]).catch((err) => [null, err]);
    if (version instanceof Error) return failed(version);
    setupNeeded =
      current && current.version !== version
        ? setupLink(current.bootstrap)
        : null;
    // Set up already with efb_run_setup in it: the update runs from here, no Supabase needed.
    // (Asked with no setup: it says so if it's there, and isn't found if it isn't.)
    // Worked out first and only then kept, so a refresh never leaves the Update button without it.
    let here = null;
    if (setupNeeded && version && current.sha256)
      here = await rpc("efb_run_setup", { setup_sha256: null }).then(
        () => current.sha256,
        (err) => (missing(err) ? null : current.sha256),
      );
    setupHere = here;
    // Asked alongside, and never holds the page up: the cache being down just shows as such.
    const usageAsked = fetch(CACHE + "/usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("The cache answered " + r.status + "."))))
      .catch((err) => ({ error: err.message }));
    try {
      data = await rpc("efb_owner_dashboard");
    } catch (err) {
      if (missing(err)) data = null;
      else return failed(err);
    }
    usage = await usageAsked;
    // Supabase's own figures, from the account service (null until its setup has efb_owner_usage).
    supabaseUsage = await rpc("efb_owner_usage").catch((err) =>
      missing(err) ? null : { error: err.message },
    );
    render();
  }

  function failed(err) {
    if (!session) return;
    closeSheet(true);
    data = null;
    const notOwner = /only the owner/i.test(err.message);
    app.replaceChildren(
      h(
        "div.center",
        {},
        backLink(),
        h(
          "div.card",
          {},
          h("span.ico.t-" + (notOwner ? "amber" : "red"), { style: "width:48px;height:48px;border-radius:12px" }, icon(notOwner ? "key" : "alert", true)),
          h("h1", {}, notOwner ? "Not the owner" : "Couldn't load"),
          h(
            "p.lede",
            {},
            notOwner
              ? session.email + " isn't GA-EFB's owner account, so there's nothing to show here."
              : err.message,
          ),
          notOwner
            ? h("button.primary", { type: "button", onclick: signOut }, "Sign In as Someone Else")
            : h("button.primary", { type: "button", onclick: () => load().catch(failed) }, "Try Again"),
          notOwner ? null : h("button.text-btn", { type: "button", onclick: signOut }, "Sign Out"),
        ),
      ),
    );
  }

  /** Supabase's SQL editor, with the few lines that fetch and run the setup filled in. */
  function setupLink(bootstrap) {
    const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(ACCOUNTS)?.[1];
    return ref && bootstrap
      ? `https://supabase.com/dashboard/project/${ref}/sql/new?content=${encodeURIComponent(bootstrap)}`
      : null;
  }

  /** What an account is up to, for its line in Customers (and which filter it's under). */
  function standing(a, trialDays) {
    if (a.owner) return { text: "You", kind: "owner", badge: ["You", "info"] };
    if (a.key_used)
      return {
        text: "Licence key " + day(a.key_used),
        kind: "bought",
        badge: ["Key", "good"],
      };
    if (a.subscribed)
      return {
        text: "Subscribed · until " + day(a.subscribed),
        kind: "bought",
        badge: ["App Store", "good"],
      };
    if (!a.confirmed)
      return { text: "Email not confirmed yet", kind: "other", badge: ["Unconfirmed", ""] };
    if (!a.trial_started)
      return { text: "Hasn't opened GA-EFB yet", kind: "other", badge: ["Not started", ""] };
    const ends = trialEnd(a, trialDays);
    const left = Math.ceil((ends - Date.now()) / 86_400_000);
    if (left > 0)
      return {
        text: left === 1 ? "Trial · last day" : `Trial · ${left} days left`,
        kind: "trial",
        badge: [left === 1 ? "Trial · last day" : `Trial · ${left}d`, "warn"],
        left,
      };
    return {
      text: "Trial ended " + day(ends),
      kind: "ended",
      badge: ["Trial ended", "bad"],
    };
  }

  /** When an account last signed in, in words. */
  function seen(iso) {
    if (!iso) return "never signed in";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return d <= 0 ? "seen today" : d === 1 ? "seen yesterday" : d < 30 ? `seen ${d} days ago` : "seen " + day(iso);
  }

  function render() {
    const parts = [
      h("h1", {}, "Dashboard"),
      h("p.lede", {}, "How GA-EFB is doing, and what you can do for each customer · " + session.email),
    ];
    if (data) parts.push(tiles());
    if (setupNeeded || !data) parts.push(setupCard());
    if (data) {
      parts.push(tabBar());
      if (view.tab === "analytics") parts.push(usageSection());
      if (view.tab === "payments")
        parts.push(subscriptionsSection(), keysSection());
      if (view.tab === "users") parts.push(customersSection(), deletionsSection());
    }
    // Remember where the page was scrolled, so a refresh or an action doesn't jump to the top.
    const y = window.scrollY;
    app.replaceChildren(topBar(), h("div.page", {}, ...parts.filter(Boolean)));
    window.scrollTo(0, y);
    renderSheet();
  }

  /** The bar along the top, as on the hub's pages: a round back button, then Refresh and Sign Out. */
  function topBar() {
    return h(
      "div.bar",
      {},
      h(
        "div.bar-inner",
        {},
        backLink(),
        h("span.spacer"),
        roundButton("refresh", "Refresh", () => load().catch(failed), ".refresh"),
        roundButton("out", "Sign out", signOut),
      ),
    );
  }

  function chooseTab(id) {
    view.tab = id;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // private browsing
    }
    history.replaceState(null, "", "#" + id);
    render();
  }

  function tabBar() {
    const people = data.accounts.filter((a) => !a.owner).length;
    const counts = { users: people };
    const alerts = { analytics: problems() };
    return h(
      "nav.tabs",
      { role: "tablist", "aria-label": "Dashboard" },
      ...TABS.map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(view.tab === id),
            onclick: () => chooseTab(id),
          },
          label,
          alerts[id]
            ? h("span.count.alert", { title: alerts[id] + " to look at" }, alerts[id])
            : counts[id]
              ? h("span.count", {}, counts[id])
              : null,
        ),
      ),
    );
  }

  /** How many of the services in Usage are at or near their limit, or not answering. */
  function problems() {
    if (!usage || usage.error) return 1;
    let n = 0;
    const near = (used, limit) => limit && used >= limit * 0.8;
    if (!usage.rainbow?.hasKey || near(usage.rainbow.used, usage.rainbow.cap)) n++;
    if (!usage.openaip?.hasKey || usage.openaip.today >= usage.openaip.dailyCap) n++;
    for (const g of [usage.gfs, usage.met]) if (g && g.today >= g.dailyCap) n++;
    const c = usage.cloudflare;
    if (c && c.hasKey && !c.error && c.days?.length) {
      const t = c.days[c.days.length - 1];
      if (near(Math.max(t.workers, t.durableObjects), c.dailyLimit)) n++;
      else if (c.rowLimits && !c.rowsError && (near(t.rowsRead, c.rowLimits.read) || near(t.rowsWritten, c.rowLimits.written))) n++;
    }
    const su = supabaseUsage;
    if (su && su.error) n++;
    else if (su && (near(su.database_bytes, su.database_limit) || near(su.active_month, su.active_limit))) n++;
    return n;
  }

  /** The update, run from here: the account service fetches it from the website, checks it and runs it. */
  async function runSetup(button, error, sha) {
    if (!sha) return load();
    button.disabled = true;
    button.textContent = "Updating…";
    error.hidden = true;
    try {
      await rpc("efb_run_setup", { setup_sha256: sha });
      toast("Account service updated.");
      await load();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = "Try Again";
    }
  }

  function setupCard() {
    if (setupHere && data) {
      // The setup this card was drawn for, kept with its button.
      const sha = setupHere;
      const error = h("p.error", { hidden: true });
      const button = h(
        "button.primary",
        { type: "button", onclick: () => void runSetup(button, error, sha) },
        "Update",
      );
      return h(
        "div.note.warn",
        {},
        h("strong", {}, "Update the account service"),
        h("p", {}, "A new version of the setup is ready. Tap Update - it takes a few seconds."),
        button,
        error,
      );
    }
    return h(
      "div.note.warn",
      {},
      h(
        "strong",
        {},
        data ? "Update the account service" : "Set up the account service",
      ),
      h(
        "p",
        {},
        "Set Up opens Supabase with it filled in - press Run there, wait for Success, then come back and Refresh. If Supabase asks you to sign in first, come back once you have and tap Set Up again (signing in can leave the editor empty).",
      ),
      setupNeeded
        ? h(
            "button.primary",
            {
              type: "button",
              onclick: () => window.open(setupNeeded, "_blank", "noopener"),
            },
            "Set Up",
          )
        : h(
            "p.error",
            {},
            "The setup couldn't be found on the website. Try again in a few minutes.",
          ),
    );
  }

  /** The figures at the top, each with its coloured icon, as the hub's are. */
  function tiles() {
    const days = data.trial_days || 7;
    const people = data.accounts.filter((a) => !a.owner);
    const standings = people.map((a) => standing(a, days));
    const count = (kind) => standings.filter((s) => s.kind === kind).length;
    // App Store subscribers paying for real (not TestFlight's or Apple's reviewers' Sandbox ones).
    const live = (data.subscriptions || []).filter((s) => s.environment === "Production" && subActive(s));
    const yearly = live.filter((s) => /yearly/.test(s.product || "")).length;
    const now = new Date();
    const newThisMonth = people.filter((a) => {
      const d = new Date(a.joined);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    const endingSoon = standings.filter((s) => s.kind === "trial" && s.left <= 2).length;
    const tile = (num, label, sub, name, tone) =>
      h(
        "div.card.tile",
        {},
        h("div", {}, h("div.num", {}, num), h("div.label", {}, label), sub ? h("div.sub", {}, sub) : null),
        ico(name, tone),
      );
    return h(
      "div.tiles",
      {},
      tile(live.length, "App Store", live.length ? `${yearly} yearly · ${live.length - yearly} monthly` : "no subscribers yet", "apple", "blue"),
      tile(people.length, "Accounts", newThisMonth ? `${newThisMonth} new this month` : null, "people", "orange"),
      tile(count("trial"), "On free trial", endingSoon ? `${endingSoon} ending in 2 days` : null, "clock", "sky"),
      tile(count("ended"), "Trial ended", "not subscribed", "ended", "violet"),
    );
  }

  function section(title, children, foot, extra) {
    return h(
      "section.section",
      {},
      h("div.section-head", {}, h("h2.group-title", {}, title), extra || null),
      ...children,
      foot ? h("p.foot", {}, foot) : null,
    );
  }

  /**
   * One line in a group: a coloured icon (opts.icon, opts.tone) or initials (opts.avatar), its
   * title and opts.sub, a value on the right, and a chevron when it opens something.
   */
  function row(title, value, opts = {}) {
    const opens = opts.onclick || opts.href;
    const kids = [
      opts.avatar || (opts.icon ? ico(opts.icon, opts.tone) : null),
      h(
        "div.main",
        {},
        h("div.title" + (opts.danger ? ".danger" : ""), {}, title),
        opts.sub ? h("div.sub", {}, opts.sub) : null,
      ),
      value == null ? null : typeof value === "string" ? h("div.value", {}, value) : value,
      opens && opts.chevron !== false ? h("span.chev", {}, icon("chevron")) : null,
    ];
    if (opts.href)
      return h("a.row.tap", { href: opts.href, target: /^https?:/.test(opts.href) ? "_blank" : null, rel: "noopener" }, ...kids);
    return h(
      "div.row" + (opts.onclick ? ".tap" : "") + (opts.empty ? ".empty" : ""),
      {
        onclick: opts.onclick,
        role: opts.onclick ? "button" : null,
        tabindex: opts.onclick ? "0" : null,
        onkeydown: opts.onclick
          ? (e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                opts.onclick(e);
              }
            }
          : null,
      },
      ...kids,
    );
  }
  const empty = (text) => row(text, null, { empty: true });

  // ---- Usage of the services GA-EFB pays for or is limited by ----

  const num = (n) => Number(n || 0).toLocaleString("en-GB");
  const monthName = (m, long) =>
    new Date(m + "-01T12:00:00Z").toLocaleDateString("en-GB", {
      month: long ? "long" : "short",
      ...(long ? { year: "numeric" } : {}),
    });

  /** How far through an allowance: a bar, with the level in words too (never colour alone). */
  function meter(used, limit, warnAt) {
    const share = limit ? Math.min(1, used / limit) : 0;
    const level = share >= 1 ? "bad" : share >= warnAt ? "warn" : "good";
    return h(
      "div.meter." + level,
      { role: "meter", "aria-valuemin": "0", "aria-valuemax": String(limit), "aria-valuenow": String(used) },
      h("div.meter-fill", { style: "width:" + (share * 100).toFixed(1) + "%" }),
    );
  }

  /** Small columns over time, newest on the right; each says its own figure when touched. */
  function columns(points, label) {
    const top = Math.max(1, ...points.map((p) => p.n));
    return h(
      "div.columns",
      { role: "img", "aria-label": label },
      ...points.map((p) =>
        h(
          "div.col",
          { title: p.label + ": " + num(p.n) },
          h("div.col-bar", { style: "height:" + Math.max(p.n ? 4 : 0, (p.n / top) * 100).toFixed(1) + "%" }),
        ),
      ),
    );
  }

  const link = (title, sub, href, name, tone) =>
    row(title, null, { sub, href, icon: name || "open", tone: tone || "grey" });
  const bytes = (n) =>
    n >= 1024 * 1024 * 1024
      ? (n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "") + " GB"
      : n >= 1024 * 1024
        ? (n / 1024 / 1024).toFixed(1).replace(/\.0$/, "") + " MB"
        : Math.round((n || 0) / 1024) + " KB";
  const levelBadge = (used, limit) =>
    used >= limit
      ? badge("At the limit", "bad")
      : used >= limit * 0.8
        ? badge("Getting close", "warn")
        : badge("Fine", "good");

  function usageSection() {
    const groups = usage && !usage.error ? cacheGroups() : [
      h("div.group", {}, row("GA-EFB's cache", badge("Not answering", "bad"), {
        icon: "cloud",
        tone: "red",
        sub: (usage?.error || "") + " It counts Rainbow, openAIP, Apple and Cloudflare. Try Refresh in a minute.",
      })),
    ];
    const elsewhere = h(
      "div.group",
      {},
      link("Esri (satellite map, terrain heights)", "The app asks Esri directly with your key, so only Esri can count it.", "https://location.arcgis.com/dashboard/", "map", "teal"),
      link("CARTO (Dark and Streets maps)", "Asked directly by the app with your key.", "https://dashboard.basemaps.carto.com/keys", "map", "rose"),
    );
    return h(
      "div",
      {},
      section(
        "Usage",
        [h("div.cards", {}, ...groups, supabaseGroup())],
        (usage && !usage.error
          ? "Counted by GA-EFB's cache on Cloudflare, updated " +
            new Date(usage.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) +
            ". "
          : "") +
          "Forecasts (MET Norway, NOAA), OurAirports, X-Plane Gateway, GeoNames and NOTAMs are free with no allowance to watch.",
      ),
      section("Seen only on their own sites", [elsewhere]),
    );
  }

  /** Supabase's free plan, as the account service sees itself. */
  function supabaseGroup() {
    const title = "Supabase (accounts, licences)";
    const open = link("Open Supabase", "Data transfer and anything else Supabase counts.", "https://supabase.com/dashboard/project/gzdxvcrhfmlbgbziykjk");
    const su = supabaseUsage;
    if (!su || su.error)
      return h(
        "div.group",
        {},
        row(title, su ? badge("Problem", "bad") : null, {
          icon: "database",
          tone: "emerald",
          sub: su ? su.error : "Shows here once the account service has had its Update (at the top of this page).",
        }),
        open,
      );
    const dbShare = su.database_bytes / su.database_limit;
    const activeShare = su.active_month / su.active_limit;
    const worst = dbShare > activeShare ? [su.database_bytes, su.database_limit] : [su.active_month, su.active_limit];
    return h(
      "div.group",
      {},
      row(title, levelBadge(...worst), { icon: "database", tone: "emerald" }),
      h(
        "div.usage",
        {},
        h("div.usage-figure", {}, h("span.big", {}, bytes(su.database_bytes)), " of " + bytes(su.database_limit) + " database"),
        meter(su.database_bytes, su.database_limit, 0.8),
        h("div.usage-figure.second", {}, h("span.big", {}, num(su.active_month)), " of " + num(su.active_limit) + " people active this month"),
        meter(su.active_month, su.active_limit, 0.8),
        h(
          "p.usage-sub",
          {},
          num(su.accounts) + (su.accounts === 1 ? " account" : " accounts") + " in all. " +
            (su.file_bytes ? bytes(su.file_bytes) + " of " + bytes(su.file_limit) + " of files. " : "") +
            "Limits are Supabase's free plan; the database includes Supabase's own tables. Active means signed in since the 1st.",
        ),
      ),
      open,
    );
  }

  /** Cloudflare's own count of requests a day (the cache, the VFR chart's map and the cache's store). */
  function cloudflareGroup() {
    const c = usage.cloudflare || {};
    const title = "Cloudflare (the cache, the VFR chart's map)";
    const open = link("Open Cloudflare", "Storage and everything else on your Cloudflare account.", "https://dash.cloudflare.com/");
    if (!c.hasKey || c.error)
      return h(
        "div.group",
        {},
        row(title, badge(c.hasKey ? "Problem" : "No key", "bad"), {
          icon: "cloud",
          tone: "orange",
          sub: c.error || "Needs a read-only Cloudflare key (Account Analytics: Read) saved in GitHub as the CLOUDFLARE_ANALYTICS_TOKEN secret, then Actions → Rain cache → Run workflow.",
        }),
        open,
      );
    const today = c.days[c.days.length - 1];
    // The badge goes by whichever daily limit is nearest: requests, or the store's rows read or written
    // (what Cloudflare emails about), each as a share of its limit.
    const rl = c.rowLimits;
    const rowsKnown = rl && !c.rowsError;
    const share = Math.max(
      Math.max(today.workers, today.durableObjects) / c.dailyLimit,
      rowsKnown ? today.rowsRead / rl.read : 0,
      rowsKnown ? today.rowsWritten / rl.written : 0,
    );
    const rows = !rl
      ? null
      : c.rowsError
        ? h("p.usage-sub", {}, "The store's rows read and written couldn't be counted: " + c.rowsError)
        : h(
            "div",
            {},
            h("div.usage-figure", {}, h("span.big", {}, num(today.rowsWritten)), " of " + num(rl.written) + " rows written today"),
            meter(today.rowsWritten, rl.written, 0.8),
            h("div.usage-figure", {}, h("span.big", {}, num(today.rowsRead)), " of " + num(rl.read) + " rows read today"),
            meter(today.rowsRead, rl.read, 0.8),
            h(
              "p.usage-sub",
              {},
              "Inside the store's requests: one request can read or write thousands of rows. These are what Cloudflare emails about at 90%; over either, the cache stops until midnight UTC.",
            ),
          );
    return h(
      "div.group",
      {},
      row(title, levelBadge(share * 1000, 1000), { icon: "cloud", tone: "orange" }),
      h(
        "div.usage",
        {},
        h("div.usage-figure", {}, h("span.big", {}, num(today.workers)), " of " + num(c.dailyLimit) + " requests today"),
        meter(today.workers, c.dailyLimit, 0.8),
        h(
          "p.usage-sub",
          {},
          "Every request from the app to the cache and the VFR chart's map. The cache's store had " +
            num(today.durableObjects) + " of its " + num(c.dailyLimit) +
            " today. Both are the free plan's daily limits and reset at midnight UTC (1am UK time in summer).",
        ),
        columns(
          c.days.map((d) => ({ label: day(d.d), n: d.workers })),
          "Cloudflare requests, last 30 days",
        ),
        h("div.axis", {}, h("span", {}, "30 days ago"), h("span", {}, "Today")),
        rows,
      ),
      open,
    );
  }

  /** Cloudflare R2: where the US chart map and airspace are kept, what's stored and what it costs. */
  function r2Group() {
    const r = usage.r2;
    if (!r) return null;
    const title = "Cloudflare R2 (the US map and airspace)";
    const open = link("Open R2", "Your R2 bucket and its bill on Cloudflare.", "https://dash.cloudflare.com/?to=/:account/r2/overview");
    if (!r.on || r.error)
      return h(
        "div.group",
        {},
        row(title, badge(r.on ? "Problem" : "Not set up", "bad"), {
          icon: "box",
          tone: "amber",
          sub: r.error || "Turn R2 on in Cloudflare, then Actions → Rain cache → Run workflow (it makes the bucket).",
        }),
        open,
      );
    const p = r.prices;
    const free = p.freeGb * 1e9;
    const name = (k) =>
      /^us-/.test(k) ? "US chart map" : /^usair-/.test(k) ? "US airspace" : /\.json$/.test(k) ? "which file is current" : k;
    const files = (r.files || []).filter((f) => f.bytes > 100000).map((f) => name(f.key) + " " + bytes(f.bytes));
    const ops = r.month
      ? "This month: " + num(r.month.classB) + " reads (" + num(p.freeClassB) + " free) and " + num(r.month.classA) + " writes (" + num(p.freeClassA) + " free). "
      : r.opsError
        ? "Reads and writes couldn't be counted: " + r.opsError + " "
        : "Reads and writes show with the read-only Cloudflare key (below). ";
    return h(
      "div.group",
      {},
      row(title, levelBadge(r.bytes, free), { icon: "box", tone: "amber" }),
      h(
        "div.usage",
        {},
        h("div.usage-figure", {}, h("span.big", {}, bytes(r.bytes)), " of " + p.freeGb + " GB free"),
        meter(r.bytes, free, 0.8),
        h(
          "div.usage-figure.second",
          {},
          h("span.big", {}, "$" + (r.estimateUsd || 0).toFixed(2)),
          " estimated this month",
        ),
        h(
          "p.usage-sub",
          {},
          (files.length ? files.join(", ") + ". " : "") +
            ops +
            "Over the free allowance R2 charges $" + p.perGbMonth + " a GB a month, $" + p.perMillionB + " a million reads and $" + p.perMillionA +
            " a million writes; downloads are free. An estimate in US dollars; Cloudflare's bill is the final word.",
        ),
      ),
      open,
    );
  }

  function cacheGroups() {
    const r = usage.rainbow;
    const a = usage.openaip;
    const thisMonth = monthName(usage.month, true);

    // The last 12 months, gaps included.
    const months = [];
    const d = new Date(usage.month + "-01T12:00:00Z");
    for (let i = 11; i >= 0; i--) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
      months.push({ m, label: monthName(m, true), n: r.months.find((x) => x.m === m)?.n || 0 });
    }
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const dd = new Date(Date.parse(usage.at) - i * 86400_000).toISOString().slice(0, 10);
      days.push({ label: day(dd), n: a.days.find((x) => x.d === dd)?.n || 0 });
    }
    const left = Math.max(0, r.cap - r.used);
    const rainState = !r.hasKey
      ? badge("No key", "bad")
      : r.used >= r.cap
        ? badge("Paused till the 1st", "bad")
        : r.used >= r.cap * 0.8
          ? badge("Getting close", "warn")
          : badge("Fine", "good");
    const aipState = !a.hasKey
      ? badge("No key", "bad")
      : a.today >= a.dailyCap
        ? badge("Used up today", "bad")
        : badge("Fine", "good");

    const rainbow = h(
      "div.group",
      {},
      row("Rainbow rain radar", rainState, { icon: "rain", tone: "sky" }),
      h(
        "div.usage",
        {},
        h(
          "div.usage-figure",
          {},
          h("span.big", {}, num(r.used)),
          " of " + num(r.cap) + " in " + thisMonth,
        ),
        meter(r.used, r.cap, 0.8),
        h(
          "p.usage-sub",
          {},
          num(left) + " left. Rainbow's free allowance is " + num(r.free) +
            " a month; the cache stops at " + num(r.cap) + ", so you're never charged. " +
            num(r.served) + " tiles served from the cache this month at no cost.",
        ),
        columns(months, "Rainbow requests, last 12 months"),
        h("div.axis", {}, h("span", {}, monthName(months[0].m) + " " + months[0].m.slice(0, 4)), h("span", {}, "This month")),
      ),
      r.lastError ? row("Last problem", null, { sub: r.lastError, icon: "alert", tone: "red" }) : null,
    );

    const openaip = h(
      "div.group",
      {},
      row("openAIP (airspace, reporting points, navaids)", aipState, { icon: "map", tone: "indigo" }),
      h(
        "div.usage",
        {},
        h("div.usage-figure", {}, h("span.big", {}, num(a.today)), " of " + num(a.dailyCap) + " today"),
        meter(a.today, a.dailyCap, 0.8),
        h(
          "p.usage-sub",
          {},
          num(a.month) + " requests to openAIP in " + thisMonth + "; " + num(a.served) +
            " answers served from the cache (" + num(a.kept) + " kept). The limit is the cache's own, to be kind to openAIP: it resets at midnight UTC.",
        ),
        columns(days, "openAIP requests, last 30 days"),
        h("div.axis", {}, h("span", {}, "30 days ago"), h("span", {}, "Today")),
      ),
    );

    const apple = h(
      "div.group",
      {},
      row(
        "App Store subscription checks",
        usage.appStore.hasKey ? num(usage.appStore.checks) : badge("No key", "bad"),
        { sub: "Asked of Apple in " + thisMonth + ". Free, no limit to worry about.", icon: "apple", tone: "blue" },
      ),
      row(
        "Sign in with Apple",
        usage.signInWithApple.hasKey ? badge("Set up", "good") : badge("No key", "bad"),
        { sub: "Used only when someone deletes their account. Free.", icon: "key", tone: "grey" },
      ),
    );

    /** A service the cache downloads from and shares (NOAA's winds, MET Norway's forecasts). */
    const sharedCard = (g, title, what, note, name, tone) =>
      g
        ? h(
            "div.group",
            {},
            row(
              title,
              g.today >= g.dailyCap
                ? badge("Used up today", "bad")
                : g.lastError && Date.now() - Date.parse(g.lastError.at) < 3600_000
                  ? badge("Problem", "warn")
                  : badge("Fine", "good"),
              { icon: name, tone },
            ),
            h(
              "div.usage",
              {},
              h("div.usage-figure", {}, h("span.big", {}, num(g.today)), " of " + num(g.dailyCap) + " downloads today"),
              meter(g.today, g.dailyCap, 0.8),
              h(
                "p.usage-sub",
                {},
                num(g.month) + " downloads in " + thisMonth + "; " + num(g.served) + " " + what +
                  " served from the cache, shared between everyone (" + num(g.kept) + " kept). " + note,
              ),
            ),
            g.lastError ? row("Last problem", null, { sub: g.lastError.message + " (" + new Date(g.lastError.at).toLocaleString("en-GB") + ")", icon: "alert", tone: "red" }) : null,
          )
        : null;
    const gfs = sharedCard(usage.gfs, "NOAA forecast winds (Winds aloft, plog)", "files",
      "Free; the limit is the cache's own, to be kind to NOAA. If the cache can't help, the app asks NOAA itself.", "wind", "teal");
    const met = sharedCard(usage.met, "MET Norway forecasts (airfield weather)", "forecasts",
      "Free (credit MET Norway); the limit is the cache's own. If the cache can't help, the app asks MET Norway itself.", "sun", "amber");
    return [rainbow, openaip, gfs, met, apple, cloudflareGroup(), r2Group()].filter(Boolean);
  }

  /** When an account's trial ends: the account service's own figure (with any extra time given), else its start and the trial's days. */
  function trialEnd(a, trialDays) {
    if (a.trial_ends) return new Date(a.trial_ends).getTime();
    return new Date(a.trial_started).getTime() + trialDays * 86_400_000;
  }

  async function extendTrial(email) {
    const answer = prompt(`Give ${email} how many more days of trial? (From when it ends, or from today if it has ended.)`, "7");
    if (answer === null) return;
    const days = Number.parseInt(answer, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error("Give between 1 and 365 days.");
    const r = await rpc("efb_owner_extend_trial", { target_email: email, extra_days: days });
    if (!r.ok) throw new Error(r.error || "That didn't work.");
    toast("Trial extended to " + day(r.trial_ends) + ".");
    await load();
  }

  const FILTERS = [
    ["all", "All"],
    ["trial", "On trial"],
    ["ended", "Trial ended"],
    ["bought", "Subscribed or key"],
    ["other", "Not started"],
  ];

  function customersSection() {
    const days = data.trial_days || 7;
    const q = view.search.trim().toLowerCase();
    const list = data.accounts.filter((a) => {
      if (q && !(a.email || "").toLowerCase().includes(q)) return false;
      return view.filter === "all" || standing(a, days).kind === view.filter;
    });
    const by = {
      newest: (a, b) => String(b.joined || "").localeCompare(String(a.joined || "")),
      seen: (a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")),
      email: (a, b) => String(a.email || "").localeCompare(String(b.email || "")),
    };
    list.sort(by[view.sort] || by.newest);

    const search = h("input.field", {
      type: "search",
      placeholder: "Search by email",
      value: view.search,
      "aria-label": "Search by email",
    });
    search.addEventListener("input", () => {
      view.search = search.value;
      view.shown = 50;
      const at = search.selectionStart;
      render();
      const again = app.querySelector('input[type="search"]');
      again.focus();
      again.setSelectionRange(at, at);
    });
    const sort = h(
      "select.field",
      { "aria-label": "Sort by", onchange: (e) => { view.sort = e.target.value; render(); } },
      ...[["newest", "Newest"], ["seen", "Last seen"], ["email", "Email"]].map(([v, l]) =>
        h("option", { value: v, selected: view.sort === v }, l),
      ),
    );

    const rows = list.slice(0, view.shown).map((a) => {
      const st = standing(a, days);
      return row(
        h("span", {}, a.email || "(no email)", st.badge ? badge(...st.badge) : null),
        null,
        {
          avatar: avatar(a.email),
          sub: (st.kind === "trial" || st.kind === "owner" ? "" : st.text + " · ") + "joined " + day(a.joined) + " · " + seen(a.last_seen),
          onclick: () => openSheet(a.email),
        },
      );
    });
    if (!rows.length) rows.push(empty(q || view.filter !== "all" ? "No accounts match." : "No accounts here yet."));
    const group = h("div.group.list", {}, ...rows);
    if (list.length > view.shown)
      group.append(
        h(
          "button.more",
          {
            type: "button",
            onclick: () => {
              view.shown += 100;
              render();
            },
          },
          `Show more (${list.length - view.shown} more)`,
        ),
      );

    // The emails of the accounts listed (as filtered and searched), for a mailing: confirmed ones
    // only (an unconfirmed address may not be theirs), never the owner's. One per line.
    const mailable = list.filter((a) => a.email && a.confirmed && !a.owner).map((a) => a.email);
    const copy = mailable.length
      ? h(
          "button.more",
          {
            type: "button",
            onclick: async () => {
              const text = mailable.join("\n");
              try {
                await navigator.clipboard.writeText(text);
                toast(`${mailable.length} email${mailable.length === 1 ? "" : "s"} copied.`);
              } catch {
                prompt("The emails:", mailable.join(", "));
              }
            },
          },
          `Copy ${mailable.length} email${mailable.length === 1 ? "" : "s"} (the confirmed ones listed)`,
        )
      : null;

    // Everyone listed whose trial has ended, given more days in one go (launch day's free week, say).
    const ended = list.filter((a) => a.email && a.confirmed && !a.owner && standing(a, days).kind === "ended" && "trial_ends" in a);
    const extendAll = ended.length
      ? h(
          "button.more",
          {
            type: "button",
            onclick: async (e) => {
              const answer = prompt(`Give the ${ended.length} account${ended.length === 1 ? "" : "s"} listed whose trial has ended how many more days, from today?`, "7");
              if (answer === null) return;
              const n = Number.parseInt(answer, 10);
              if (!Number.isFinite(n) || n < 1 || n > 365) return alert("Give between 1 and 365 days.");
              const button = e.currentTarget;
              button.disabled = true;
              let done = 0;
              const failed = [];
              for (const a of ended) {
                button.textContent = `Extending… ${done + failed.length + 1} of ${ended.length}`;
                try {
                  const r = await rpc("efb_owner_extend_trial", { target_email: a.email, extra_days: n });
                  if (r.ok) done++;
                  else failed.push(a.email + ": " + (r.error || "not extended"));
                } catch (err) {
                  failed.push(a.email + ": " + err.message);
                }
              }
              toast(`${done} trial${done === 1 ? "" : "s"} extended by ${n} day${n === 1 ? "" : "s"}.`);
              if (failed.length) alert("Not extended:\n" + failed.join("\n"));
              await load();
            },
          },
          `Give the ${ended.length} ended trial${ended.length === 1 ? "" : "s"} listed more days`,
        )
      : null;

    // Sign-ups that never confirmed their email (bots, mostly), a week on: one tap clears them.
    const STALE_DAYS = 7;
    const stale = data.accounts.filter(
      (a) => !a.confirmed && !a.owner && Date.now() - Date.parse(a.joined) > STALE_DAYS * 86400000,
    ).length;
    const clear = stale
      ? h(
          "button.more.danger",
          {
            type: "button",
            onclick: async (e) => {
              if (!confirm(`Delete the ${stale} account${stale === 1 ? "" : "s"} that never confirmed their email, over ${STALE_DAYS} days ago? They can't sign in, and have nothing in GA-EFB. This can't be undone.`)) return;
              const button = e.currentTarget;
              button.disabled = true;
              try {
                const r = await rpc("efb_delete_unconfirmed", { older_than_days: STALE_DAYS });
                if (!r.ok) throw new Error(r.error || "That didn't work.");
                toast("Unconfirmed accounts deleted.");
                await load();
              } catch (err) {
                button.disabled = false;
                alert(err.message);
              }
            },
          },
          `Delete ${stale} unconfirmed account${stale === 1 ? "" : "s"} (over ${STALE_DAYS} days old)`,
        )
      : null;

    return section(
      "Customers",
      [
        h("div.searchbar", {}, h("label.search-wrap", {}, icon("search"), search), sort),
        h(
          "div.chips",
          { role: "group", "aria-label": "Show" },
          FILTERS.map(([id, label]) =>
            h(
              "button.chip",
              {
                type: "button",
                "aria-pressed": String(view.filter === id),
                onclick: () => {
                  view.filter = id;
                  view.shown = 50;
                  render();
                },
              },
              label,
            ),
          ),
        ),
        group,
        copy,
        extendAll,
        clear,
      ],
      `Every GA-EFB account. A trial starts the first time the account opens GA-EFB, and lasts ${days} days. Tap one for its purchases and what you can do.`,
    );
  }

  // ---- a customer's sheet ----

  function openSheet(email) {
    view.open = email;
    view.del = null;
    renderSheet();
  }

  /** Closes the sheet (quietly, without re-rendering, when the page is being replaced anyway). */
  function closeSheet(quiet) {
    view.open = null;
    document.querySelector(".sheet-back")?.remove();
    document.body.classList.remove("locked");
    if (!quiet) render();
  }

  function onSheetKey(e) {
    if (e.key === "Escape" && view.open) closeSheet();
  }
  document.addEventListener("keydown", onSheetKey);

  function renderSheet() {
    const old = document.querySelector(".sheet-back");
    const keepScroll = old?.querySelector(".sheet-body")?.scrollTop || 0;
    old?.remove();
    const a = view.open && data ? data.accounts.find((x) => x.email === view.open) : null;
    if (!a) {
      view.open = null;
      document.body.classList.remove("locked");
      return;
    }
    const days = data.trial_days || 7;
    const st = standing(a, days);
    const same = (e) => (e || "").toLowerCase() === (a.email || "").toLowerCase();
    const subs = (data.subscriptions || []).filter((s) => same(s.email));
    const trialEnds = a.trial_started ? trialEnd(a, days) : null;

    const fact = (n, l) => h("div.fact", {}, h("div.n", {}, n), h("div.l", {}, l));
    // short dates, so they fit on one line: the year only when it isn't this one
    const short = (d) => {
      const t = new Date(d);
      return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(t.getFullYear() === new Date().getFullYear() ? {} : { year: "2-digit" }) });
    };
    const facts = h(
      "div.group.facts",
      {},
      fact(a.joined ? short(a.joined) : "-", "Joined"),
      fact(a.last_seen ? short(a.last_seen) : "Never", "Last signed in"),
      fact(a.confirmed ? "Yes" : "No", "Email confirmed"),
      fact(a.trial_started ? short(a.trial_started) : "-", "Trial started"),
      fact(trialEnds ? short(trialEnds) : "-", (trialEnds && trialEnds < Date.now() ? "Trial ended" : "Trial ends") + (a.trial_extended ? " (extended)" : "")),
      fact(String(subs.length), "Subscriptions"),
    );

    const purchaseRows = [
      ...subs.map((s) => subRow(s, { icon: "apple", tone: "blue", title: (PLANS[s.product] || "App Store") + " subscription" })),
    ];
    if (a.key_used) purchaseRows.push(row("Licence key", day(a.key_used), { icon: "key", tone: "amber", sub: "Unlocked with a key" }));
    if (!purchaseRows.length) purchaseRows.push(empty("No subscription or key yet."));

    const error = h("p.error", { hidden: true });
    const actions = [
      a.email ? row("Email " + (a.owner ? "Yourself" : "Them"), null, { icon: "mail", tone: "sky", sub: a.email, href: "mailto:" + a.email + "?subject=" + encodeURIComponent("GA-EFB") }) : null,
      a.email
        ? row("Copy Email", null, {
            icon: "copy",
            tone: "grey",
            chevron: false,
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(a.email);
                toast("Email copied.");
              } catch {
                prompt("The email:", a.email);
              }
            },
          })
        : null,
      // Only for someone not paying: a trial running or ended (needs the setup with Extend Trial in it).
      !a.owner && a.email && a.confirmed && ["trial", "ended"].includes(st.kind) && "trial_ends" in a
        ? row("Extend Trial", null, {
            icon: "clock",
            tone: "amber",
            sub: trialEnds && trialEnds > Date.now() ? "Give them more days on top of their trial" : "Give them more days, from today",
            chevron: false,
            onclick: async () => {
              error.hidden = true;
              try {
                await extendTrial(a.email);
              } catch (err) {
                error.textContent = err.message;
                error.hidden = false;
              }
            },
          })
        : null,
    ].filter(Boolean);

    const groupWith = (title, kids) =>
      h("section.section", {}, h("div.section-head", {}, h("h2.group-title", {}, title)), ...kids);

    const body = h(
      "div.sheet-body",
      {},
      st.kind === "ended"
        ? h("div.note.warn", {}, h("strong", {}, "Trial ended, not subscribed"), h("p", {}, "Their " + days + "-day trial is over and they haven't subscribed or used a licence key."))
        : null,
      groupWith("Account", [facts]),
      groupWith("Purchases", [h("div.group", {}, ...purchaseRows)]),
      actions.length ? groupWith("Actions", [h("div.group", {}, ...actions), error]) : null,
      a.owner || !a.email ? null : deleteBox(a),
    );

    const back = h(
      "div.sheet-back",
      { onclick: () => closeSheet() },
      h(
        "div.sheet",
        { role: "dialog", "aria-modal": "true", "aria-label": a.email || "Account", onclick: (e) => e.stopPropagation() },
        h(
          "div.sheet-head",
          {},
          avatar(a.email, true),
          h(
            "div.who",
            {},
            h("h2", {}, a.email || "(no email)"),
            h("div.meta", {}, st.badge ? badge(...st.badge) : null, h("span", {}, st.text)),
          ),
          h("button.close", { type: "button", "aria-label": "Close", onclick: () => closeSheet() }, icon("close")),
        ),
        body,
      ),
    );
    document.body.append(back);
    document.body.classList.add("locked");
    body.scrollTop = keepScroll;
    if (!old) back.querySelector(".close").focus({ preventScroll: true });
  }

  // ---- deleting an account ----

  /**
   * Delete Account, at the bottom of a customer's sheet, as the hub's Delete Club: it opens a box
   * that says what goes and what stays, takes a note, and wants their email typed again.
   */
  function deleteBox(a) {
    const open = view.del && view.del.email === a.email;
    const toggle = row("Delete Account", null, {
      icon: "bin",
      tone: "red",
      danger: true,
      sub: "Their account and everything in it, for good",
      chevron: false,
      onclick: () => {
        view.del = open ? null : { email: a.email, confirm: "", note: "", force: false };
        renderSheet();
        if (!open) setTimeout(() => document.getElementById("delete-confirm")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      },
    });
    const parts = [h("div.group", { style: "margin-top:12px" }, toggle)];
    if (!open) return h("div", {}, ...parts);

    const d = view.del;
    const subscribed = !!a.subscribed;
    const typed = () => d.confirm.trim().toLowerCase() === a.email.trim().toLowerCase();
    const error = h("p.error", { hidden: true });
    const button = h("button.primary.danger-btn", { type: "button" }, "Delete Account");
    const ready = () => (button.disabled = !typed() || (subscribed && !d.force));
    const note = h("input.field", { placeholder: "Why (only you see this), e.g. Asked by email", maxlength: "200", "aria-label": "Why" });
    note.value = d.note;
    note.addEventListener("input", () => (d.note = note.value));
    // a phone's keyboard capitalises and adds spaces: those don't count
    const confirmField = h("input.field", {
      id: "delete-confirm",
      placeholder: "Type " + a.email + " to confirm",
      "aria-label": "Type their email to confirm",
      autocapitalize: "off",
      autocorrect: "off",
      autocomplete: "off",
      spellcheck: "false",
    });
    confirmField.value = d.confirm;
    confirmField.addEventListener("input", () => {
      d.confirm = confirmField.value;
      ready();
    });
    const force = subscribed
      ? h(
          "label.check",
          {},
          h("input", {
            type: "checkbox",
            checked: d.force,
            onchange: (e) => {
              d.force = e.target.checked;
              ready();
            },
          }),
          "They've been told to cancel it in their Apple ID settings - delete anyway",
        )
      : null;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Deleting…";
      error.hidden = true;
      try {
        const r = await rpc("efb_owner_delete_account", {
          account_email: a.email,
          confirm_email: d.confirm,
          note: d.note,
          even_if_subscribed: subscribed && d.force,
        });
        if (!r.ok) throw new Error(r.error || "That didn't work.");
        toast("Account deleted.");
        view.del = null;
        closeSheet(true);
        await load();
      } catch (err) {
        error.textContent = missing(err)
          ? "The account service needs its Update first: tap Update at the top of the dashboard, then try again."
          : err.message;
        error.hidden = false;
        button.textContent = "Delete Account";
        ready();
      }
    });
    ready();

    parts.push(
      h(
        "div.note.bad.delete-box",
        {},
        h("strong", {}, "Delete " + a.email + "?"),
        h(
          "p",
          {},
          "Their account, sign-ins and everything GA-EFB keeps for it go, for good. " +
            "Their subscriptions stay in your records (as \"account deleted\"), and signing up again with the same email won't give them a new free trial. " +
            "Anything saved on their own PC or iPad stays there.",
        ),
        subscribed
          ? h("p", {}, h("b", {}, "They have an active App Store subscription. "), "Deleting the account doesn't stop it: Apple goes on charging them until they cancel it themselves (Settings → their name → Subscriptions).")
          : null,
        a.apple
          ? h("p", {}, h("b", {}, "They signed in with Apple. "), "GA-EFB stays listed in their Apple ID until they remove it there (Settings → their name → Sign in with Apple), or delete the account from the app instead, which does that too.")
          : null,
        note,
        confirmField,
        force,
        button,
        error,
      ),
    );
    return h("div", {}, ...parts);
  }

  /** The accounts deleted from here: when, and why (not who: the point is that it's gone). */
  function deletionsSection() {
    const list = data.deletions || [];
    if (!list.length) return null;
    return section(
      "Deleted by you",
      [
        h(
          "div.group",
          {},
          ...list.slice(0, 50).map((x) =>
            row(x.note || "No note", new Date(x.at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }), { icon: "bin", tone: "grey" }),
          ),
        ),
      ],
      "A record that each was done, for anyone who asked for their data to be deleted. Their email isn't kept.",
    );
  }

  // Apple's statuses: 1 active, 2 expired, 3 billing retry, 4 billing grace period, 5 refunded.
  const subActive = (s) =>
    s.status === 4 ||
    (s.status === 1 &&
      (!s.expires || new Date(s.expires).getTime() > Date.now() - 86_400_000));
  const PLANS = {
    "uk.co.gaefb.app.monthly": "Monthly",
    "uk.co.gaefb.app.yearly": "Yearly",
  };

  /** One App Store subscription's line, in the list and in a customer's sheet. */
  function subRow(s, opts) {
    const plan = PLANS[s.product] || s.product || "Subscription";
    const state =
      s.status === 5
        ? badge("Refunded", "bad")
        : s.environment !== "Production"
          ? badge("Test")
          : s.status === 4
            ? badge("Card problem", "warn")
            : subActive(s)
              ? badge("Active", "good")
              : badge(s.status === 3 ? "Card problem" : "Ended", s.status === 3 ? "warn" : "");
    const when = subActive(s)
      ? (s.renews === false ? "ends " : "renews ") + day(s.expires)
      : "ended " + day(s.expires);
    return row(opts.title || s.email || "(account deleted)", state, {
      ...opts,
      sub: `${opts.title ? "" : plan + " · "}${s.price ? money(s.price / 10, s.currency) + " · " : ""}since ${day(s.started)} · ${when}`,
    });
  }

  function subscriptionsSection() {
    const list = data.subscriptions || [];
    const rows = list.slice(0, view.subs).map((s) => {
      const account = s.email && data.accounts.find((a) => a.email === s.email);
      return subRow(s, { avatar: avatar(s.email), onclick: account ? () => openSheet(s.email) : null });
    });
    if (!rows.length) rows.push(empty("No App Store subscriptions yet."));
    const group = h("div.group", {}, ...rows);
    if (list.length > view.subs)
      group.append(
        h(
          "button.more",
          {
            type: "button",
            onclick: () => {
              view.subs += 50;
              render();
            },
          },
          `Show more (${list.length - view.subs} more)`,
        ),
      );
    return section(
      "App Store subscriptions",
      [group],
      "Subscriptions bought in the iPad/iPhone app, as Apple last said: each is checked again when it's due to renew, and daily. Test ones are TestFlight's and Apple's reviewers'. Prices are before Apple's commission; payouts are in App Store Connect.",
    );
  }

  // ---- licence keys ----

  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: easy to read out and type

  /** A new key: GAEFB-XXXX-XXXX-XXXX-XXXX (the same form as server/src/licence/licence.ts expects). */
  function newKey() {
    const limit = Math.floor(2 ** 32 / ALPHABET.length) * ALPHABET.length;
    const one = new Uint32Array(1);
    let body = "";
    while (body.length < 16) {
      crypto.getRandomValues(one);
      if (one[0] < limit) body += ALPHABET[one[0] % ALPHABET.length];
    }
    return "GAEFB-" + body.match(/.{4}/g).join("-");
  }

  /** Only this is stored (the SQL's efb_licence_hash): SHA-256 of the key's 16 characters. */
  async function keyHash(key) {
    const body = key.replace(/[^A-Z0-9]/g, "").slice(5);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  let keyBatches = null; // kept between renders, so the list doesn't flash "Loading…" each time

  function keysSection() {
    const holder = h("div.group", {});
    const show = (batches) =>
      holder.replaceChildren(
        ...((batches || []).length
          ? batches.map((b) =>
              row(b.batch || "(no name)", `${b.used} of ${b.total} used`, {
                icon: "key",
                tone: b.used >= b.total ? "grey" : "amber",
                sub: "Made " + day(b.made),
              }),
            )
          : [empty("No keys made yet.")]),
      );
    if (keyBatches) show(keyBatches);
    else holder.replaceChildren(empty("Loading…"));
    rpc("efb_licence_key_batches")
      .then((batches) => {
        keyBatches = batches || [];
        show(keyBatches);
      })
      .catch((err) =>
        holder.replaceChildren(empty(missing(err) ? "Set up the account service first." : err.message)),
      );

    const form = h(
      "form.group.form",
      { style: "margin-top:12px" },
      h("p.form-title", {}, "Make keys"),
      h("label", { for: "key-batch" }, "Name"),
      h("input.field", {
        id: "key-batch",
        name: "batch",
        placeholder: "e.g. Gifts, or a shop",
        maxlength: "60",
        required: true,
      }),
      h("label", { for: "key-count" }, "How many"),
      h("input.field", {
        id: "key-count",
        name: "count",
        type: "number",
        min: "1",
        max: "1000",
        value: "5",
        required: true,
      }),
      h("p.error", { hidden: true }),
      h("button.primary", { type: "submit" }, "Make Keys"),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const error = form.querySelector(".error");
      const button = form.querySelector("button");
      const count = Math.floor(Number(form.count.value));
      const batch = form.batch.value.trim();
      error.hidden = true;
      if (!(count >= 1 && count <= 1000)) {
        error.textContent = "Make between 1 and 1,000 keys at a time.";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      try {
        const keys = new Set();
        while (keys.size < count) keys.add(newKey());
        const list = [...keys];
        await rpc("efb_add_licence_keys", {
          key_hashes: await Promise.all(list.map(keyHash)),
          batch_name: batch,
        });
        view.keys = { batch, list };
        keyBatches = null;
        render();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    });

    const children = [holder, form];
    if (view.keys) children.push(madeKeys(view.keys));
    return section(
      "Licence keys",
      children,
      "For gifts, or a shop. Each key unlocks GA-EFB for one account. Keys are shown only once, when they're made - only a fingerprint of each is kept.",
    );
  }

  function madeKeys({ batch, list }) {
    const text = list.join("\n");
    const area = h("textarea.keys", {
      readonly: true,
      "aria-label": "The new keys",
    });
    area.value = text;
    const status = h("p.ok", { hidden: true });
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        area.focus();
        area.select();
        document.execCommand("copy");
      }
      status.textContent = "Copied.";
      status.hidden = false;
    };
    const download = () => {
      const a = h("a", {
        href: URL.createObjectURL(
          new Blob([text + "\n"], { type: "text/plain" }),
        ),
        download: `GA-EFB keys - ${batch}.txt`,
      });
      document.body.append(a);
      a.click();
      a.remove();
    };
    return h(
      "div.note.good",
      {},
      h(
        "strong",
        {},
        `${list.length} new ${list.length === 1 ? "key" : "keys"} for "${batch}"`,
      ),
      h("p", {}, "Save them now - they won't be shown again."),
      area,
      h(
        "div.button-row",
        {},
        h(
          "button.primary",
          { type: "button", onclick: () => void copy() },
          "Copy",
        ),
        h("button.primary", { type: "button", onclick: download }, "Download"),
      ),
      status,
    );
  }

  void load().catch((err) => failed(err));
})();
