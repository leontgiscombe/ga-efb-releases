// GA-EFB's owner dashboard. It signs in with the owner's GA-EFB account and asks the account
// service directly (server/src/auth/setupSql.ts: efb_owner_dashboard, efb_set_stripe,
// efb_add_licence_keys...). Those functions check it's the owner, so this page is safe to
// publish: anyone else only gets "not the owner". The address and key are public by design.
(() => {
  "use strict";

  const ACCOUNTS = "https://gzdxvcrhfmlbgbziykjk.supabase.co";
  const PUBLIC_KEY = "sb_publishable_KrYVpUmemtBqKSsYkY43pw_LOD3PrFI";
  const STORE = "ga-efb-dashboard";
  // GA-EFB's cache on Cloudflare (cloud/rain-worker): it counts what Rainbow, openAIP and Apple are asked.
  const CACHE = "https://ga-efb-rain.leontgiscombe.workers.dev";
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

  // ---- signing in ----

  function showSignIn(message) {
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
      }
    });
  }

  // ---- the dashboard ----

  let data = null;
  let setupNeeded = null; // null, or the link that opens Supabase with the setup filled in
  let setupHere = null; // the SHA-256 of the setup to run from here (efb_run_setup), if it can be
  const view = {
    filter: "all",
    search: "",
    shown: 50,
    sales: 20,
    subs: 20,
    stripeOpen: false,
    keys: null,
  };

  let usage = null;
  let supabaseUsage = null;

  async function load() {
    if (!session) return showSignIn();
    app.replaceChildren(h("p.loading", {}, "Loading…"));
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
    setupHere = null;
    if (setupNeeded && version && current.sha256)
      setupHere = await rpc("efb_run_setup", { setup_sha256: null }).then(
        () => current.sha256,
        (err) => (missing(err) ? null : current.sha256),
      );
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
    if (/only the owner/i.test(err.message)) {
      app.replaceChildren(
        h(
          "section.signin",
          {},
          h("h1", {}, "Not the owner"),
          h(
            "p.dim",
            {},
            session.email +
              " isn't GA-EFB's owner account, so there's nothing to show here.",
          ),
          h(
            "button.primary",
            { type: "button", onclick: signOut },
            "Sign In as Someone Else",
          ),
        ),
      );
    } else {
      app.replaceChildren(
        h(
          "section.signin",
          {},
          h("h1", {}, "Couldn't load"),
          h("p.dim", {}, err.message),
          h(
            "button.primary",
            { type: "button", onclick: () => void load() },
            "Try Again",
          ),
          h(
            "button.link-btn",
            { type: "button", onclick: signOut },
            "Sign Out",
          ),
        ),
      );
    }
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
    if (a.owner) return { text: "You", kind: "other" };
    if (a.bought)
      return {
        text: "Bought " + day(a.bought),
        kind: "bought",
        badge: ["Bought", "good"],
      };
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
    if (a.refunded)
      return { text: "Refunded", kind: "ended", badge: ["Refunded", "bad"] };
    if (!a.confirmed) return { text: "Email not confirmed yet", kind: "other" };
    if (!a.trial_started)
      return { text: "Hasn't opened GA-EFB yet", kind: "other" };
    const ends = new Date(a.trial_started).getTime() + trialDays * 86_400_000;
    const left = Math.ceil((ends - Date.now()) / 86_400_000);
    if (left > 0)
      return {
        text: left === 1 ? "Trial · last day" : `Trial · ${left} days left`,
        kind: "trial",
        badge: ["Trial", "warn"],
      };
    return {
      text: "Trial ended " + day(ends),
      kind: "ended",
      badge: ["Ended", ""],
    };
  }

  function render() {
    const parts = [top()];
    if (setupNeeded || !data) parts.push(setupCard());
    if (data)
      parts.push(
        tiles(),
        usageSection(),
        stripeSection(),
        testersSection(),
        customersSection(),
        salesSection(),
        subscriptionsSection(),
        keysSection(),
      );
    parts.push(
      h(
        "p.foot",
        {},
        "Buyers' names, receipts and payouts are in ",
        h(
          "a",
          {
            href: "https://dashboard.stripe.com/",
            target: "_blank",
            rel: "noopener",
          },
          "Stripe",
        ),
        ".",
      ),
    );
    app.replaceChildren(...parts.filter(Boolean));
  }

  function top() {
    return h(
      "header.top",
      {},
      h("div", {}, h("h1", {}, "Dashboard"), h("p.who", {}, session.email)),
      h(
        "div.top-actions",
        {},
        h(
          "button.link-btn",
          { type: "button", onclick: () => void load() },
          "Refresh",
        ),
        h("button.link-btn", { type: "button", onclick: signOut }, "Sign Out"),
      ),
    );
  }

  /** The update, run from here: the account service fetches it from the website, checks it and runs it. */
  async function runSetup(button, error) {
    button.disabled = true;
    button.textContent = "Updating…";
    error.hidden = true;
    try {
      await rpc("efb_run_setup", { setup_sha256: setupHere });
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
      const error = h("p.error", { hidden: true });
      const button = h(
        "button.primary",
        { type: "button", onclick: () => void runSetup(button, error) },
        "Update",
      );
      return h(
        "div.notice",
        {},
        h("strong", {}, "Update the account service"),
        h("p", {}, "A new version of the setup is ready. Tap Update - it takes a few seconds."),
        button,
        error,
      );
    }
    return h(
      "div.notice",
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

  function tiles() {
    const days = data.trial_days || 7;
    const people = data.accounts.filter((a) => !a.owner);
    const count = (kind) =>
      people.filter((a) => standing(a, days).kind === kind).length;
    // Real sales only, not the Sandbox's test ones (older setups don't say, and only had real ones).
    const paid = data.sales.filter((s) => !s.refunded && s.live !== false);
    const taken = paid.reduce((sum, s) => sum + (s.amount || 0), 0);
    // App Store subscribers paying for real (not TestFlight's or Apple's reviewers' Sandbox ones).
    const subscribers = (data.subscriptions || []).filter(
      (s) => s.environment === "Production" && subActive(s),
    ).length;
    const tile = (num, label, cls) =>
      h(
        "div.tile" + (cls ? "." + cls : ""),
        {},
        h("div.num", {}, num),
        h("div.label", {}, label),
      );
    return h(
      "div.tiles",
      {},
      tile(
        money(taken, paid[0]?.currency),
        paid.length === 1 ? "1 sale" : paid.length + " sales",
        paid.length ? "good" : "",
      ),
      tile(
        subscribers,
        subscribers === 1 ? "App Store subscriber" : "App Store subscribers",
        subscribers ? "good" : "",
      ),
      tile(people.length, "Accounts"),
      tile(count("trial"), "On free trial"),
      tile(count("ended"), "Trial ended, not bought"),
    );
  }

  function section(title, children, foot, extra) {
    return h(
      "section.section",
      {},
      h("div.section-head", {}, h("h2", {}, title), extra || null),
      ...children,
      foot ? h("p.foot", {}, foot) : null,
    );
  }

  const row = (title, value, opts = {}) =>
    h(
      "div.row" + (opts.action ? ".action" : "") + (opts.empty ? ".empty" : ""),
      {
        onclick: opts.onclick,
        role: opts.onclick ? "button" : null,
        tabindex: opts.onclick ? "0" : null,
      },
      h(
        "div.main",
        {},
        h("div.title", {}, title),
        opts.sub ? h("div.sub", {}, opts.sub) : null,
      ),
      value == null
        ? null
        : typeof value === "string"
          ? h("div.value", {}, value)
          : value,
    );

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

  const link = (title, sub, href) =>
    row(title, null, {
      sub,
      action: true,
      onclick: () => window.open(href, "_blank", "noopener"),
    });
  const bytes = (n) =>
    n >= 1024 * 1024 * 1024
      ? (n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "") + " GB"
      : n >= 1024 * 1024
        ? (n / 1024 / 1024).toFixed(1).replace(/\.0$/, "") + " MB"
        : Math.round((n || 0) / 1024) + " KB";
  const levelBadge = (used, limit) =>
    used >= limit
      ? h("span.badge.bad", {}, "At the limit")
      : used >= limit * 0.8
        ? h("span.badge.warn", {}, "Getting close")
        : h("span.badge.good", {}, "Fine");

  function usageSection() {
    const groups = usage && !usage.error ? cacheGroups() : [
      h("div.group", {}, row("GA-EFB's cache", h("span.badge.bad", {}, "Not answering"), {
        sub: (usage?.error || "") + " It counts Rainbow, openAIP, Apple and Cloudflare. Try Refresh in a minute.",
      })),
    ];
    const elsewhere = h(
      "div.group",
      {},
      link("Esri (satellite map, terrain heights)", "The app asks Esri directly with your key, so only Esri can count it.", "https://location.arcgis.com/"),
      link("CARTO (Dark and Streets maps)", "Asked directly by the app with your key.", "https://app.carto.com/"),
    );
    return section(
      "Usage",
      [
        ...groups.flatMap((g) => [g, h("div.gap")]),
        supabaseGroup(),
        h("div.gap"),
        h("h3.subhead", {}, "Seen only on their own sites"),
        elsewhere,
      ],
      (usage && !usage.error
        ? "Counted by GA-EFB's cache on Cloudflare, updated " +
          new Date(usage.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) +
          ". "
        : "") +
        "Forecasts (MET Norway, NOAA), OurAirports, X-Plane Gateway, GeoNames and NOTAMs are free with no allowance to watch.",
    );
  }

  /** Supabase's free plan, as the account service sees itself. */
  function supabaseGroup() {
    const open = link("Open Supabase", "Data transfer and anything else Supabase counts.", "https://supabase.com/dashboard/project/gzdxvcrhfmlbgbziykjk");
    const su = supabaseUsage;
    if (!su || su.error)
      return h(
        "div.group",
        {},
        row("Supabase (accounts, licences)", su ? h("span.badge.bad", {}, "Problem") : null, {
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
      row("Supabase (accounts, licences)", levelBadge(...worst)),
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
    const open = link("Open Cloudflare", "Storage and everything else on your Cloudflare account.", "https://dash.cloudflare.com/");
    if (!c.hasKey || c.error)
      return h(
        "div.group",
        {},
        row("Cloudflare (the cache, the VFR chart's map)", h("span.badge.bad", {}, c.hasKey ? "Problem" : "No key"), {
          sub: c.error || "Needs a read-only Cloudflare key (Account Analytics: Read) saved in GitHub as the CLOUDFLARE_ANALYTICS_TOKEN secret, then Actions → Rain cache → Run workflow.",
        }),
        open,
      );
    const today = c.days[c.days.length - 1];
    const busiest = Math.max(today.workers, today.durableObjects);
    return h(
      "div.group",
      {},
      row("Cloudflare (the cache, the VFR chart's map)", levelBadge(busiest, c.dailyLimit)),
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
      ? h("span.badge.bad", {}, "No key")
      : r.used >= r.cap
        ? h("span.badge.bad", {}, "Paused till the 1st")
        : r.used >= r.cap * 0.8
          ? h("span.badge.warn", {}, "Getting close")
          : h("span.badge.good", {}, "Fine");
    const aipState = !a.hasKey
      ? h("span.badge.bad", {}, "No key")
      : a.today >= a.dailyCap
        ? h("span.badge.bad", {}, "Used up today")
        : h("span.badge.good", {}, "Fine");

    const rainbow = h(
      "div.group",
      {},
      row("Rainbow rain radar", rainState),
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
      r.lastError ? row("Last problem", null, { sub: r.lastError }) : null,
    );

    const openaip = h(
      "div.group",
      {},
      row("openAIP (airspace, reporting points, navaids)", aipState),
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
        usage.appStore.hasKey ? num(usage.appStore.checks) : h("span.badge.bad", {}, "No key"),
        { sub: "Asked of Apple in " + thisMonth + ". Free, no limit to worry about." },
      ),
      row(
        "Sign in with Apple",
        usage.signInWithApple.hasKey ? h("span.badge.good", {}, "Set up") : h("span.badge.bad", {}, "No key"),
        { sub: "Used only when someone deletes their account. Free." },
      ),
    );

    return [rainbow, openaip, apple, cloudflareGroup()];
  }

  // ---- Stripe ----

  function stripeSection() {
    const s = data.stripe || {};
    const mode = !s.connected
      ? h("span.badge.bad", {}, "Not connected")
      : s.live
        ? h("span.badge.good", {}, "Live")
        : h("span.badge.warn", {}, "Sandbox");
    const rows = [
      row("Payments", mode),
      s.link ? row("Payment link", s.link.replace(/^https:\/\//, "")) : null,
      s.error ? row("Last problem", null, { sub: s.error }) : null,
      row(
        view.stripeOpen
          ? "Cancel"
          : s.connected
            ? "Change Key or Link…"
            : "Connect Stripe…",
        null,
        {
          action: true,
          onclick: () => {
            view.stripeOpen = !view.stripeOpen;
            render();
          },
        },
      ),
    ];
    const children = [h("div.group", {}, ...rows)];
    if (view.stripeOpen) children.push(stripeForm());
    return section(
      "Stripe",
      children,
      s.live
        ? "Real payments. The Buy buttons in GA-EFB for the PC and the Launcher use this link (the website sells the app's App Store subscription instead)."
        : s.connected
          ? "Sandbox: test payments only (card 4242 4242 4242 4242). GA-EFB isn't on sale yet: only your testers see Buy."
          : "Connect a restricted key (Custom permissions, Read access to Checkout Sessions, Payment Links, Payment Intents and Charges) and your payment link.",
    );
  }

  function stripeForm() {
    const form = h(
      "form",
      {},
      h(
        "div.group.fields",
        { style: "margin-top:10px" },
        h("input", {
          name: "key",
          type: "password",
          placeholder: "Restricted key (rk_live_… or rk_test_…)",
          autocomplete: "off",
          required: true,
        }),
        h("input", {
          name: "link",
          type: "url",
          placeholder: "Payment link (https://buy.stripe.com/…)",
          autocomplete: "off",
          required: true,
        }),
      ),
      h("p.error", { hidden: true }),
      h("button.primary", { type: "submit" }, "Connect Stripe"),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const error = form.querySelector(".error");
      const button = form.querySelector("button");
      const link = form.link.value.trim();
      error.hidden = true;
      if (!/^https:\/\/buy\.stripe\.com\/\S+$/.test(link)) {
        error.textContent = "The payment link starts https://buy.stripe.com/";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      try {
        const r = await rpc("efb_set_stripe", {
          api_key: form.key.value.trim(),
          link_url: link,
        });
        if (!r.ok) throw new Error(r.error || "Stripe couldn't be connected.");
        view.stripeOpen = false;
        await load();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
    return form;
  }

  // ---- testers (while on the Sandbox) ----

  /** The accounts that may try Buy on the Sandbox (anyone could pay with the public test card). */
  function testersSection() {
    const s = data.stripe || {};
    if (s.live || !Array.isArray(data.testers)) return null;
    const setTester = async (email, on) => {
      const r = await rpc("efb_set_tester", {
        tester_email: email,
        is_tester: on,
      });
      if (!r.ok) throw new Error(r.error || "That didn't work.");
      await load();
    };
    const rows = data.testers.map((email) =>
      row(
        email,
        h(
          "button.link-btn",
          {
            type: "button",
            onclick: (e) => {
              e.target.disabled = true;
              setTester(email, false).catch((err) => {
                e.target.disabled = false;
                alert(err.message);
              });
            },
          },
          "Remove",
        ),
      ),
    );
    if (!rows.length) rows.push(row("No testers yet.", null, { empty: true }));
    const form = h(
      "form",
      {},
      h(
        "div.group.fields",
        { style: "margin-top:10px" },
        h("input", {
          name: "email",
          type: "email",
          placeholder: "A test account's email",
          autocomplete: "off",
          autocapitalize: "off",
          required: true,
        }),
      ),
      h("p.error", { hidden: true }),
      h("button.primary", { type: "submit" }, "Add Tester"),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const error = form.querySelector(".error");
      const button = form.querySelector("button");
      error.hidden = true;
      button.disabled = true;
      try {
        await setTester(form.email.value.trim(), true);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
    return section(
      "Testers",
      [h("div.group", {}, ...rows), form],
      "While Stripe is on the Sandbox, only these accounts (and yours) see Buy in GA-EFB and the Launcher, and only their test purchases unlock GA-EFB. Test purchases stop counting once you go live.",
    );
  }

  // ---- customers ----

  function customersSection() {
    const days = data.trial_days || 7;
    const q = view.search.trim().toLowerCase();
    const list = data.accounts.filter((a) => {
      if (q && !(a.email || "").toLowerCase().includes(q)) return false;
      return view.filter === "all" || standing(a, days).kind === view.filter;
    });
    const filters = [
      ["all", "All"],
      ["trial", "Trial"],
      ["ended", "Ended"],
      ["bought", "Bought"],
    ];
    const search = h("input.search", {
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
      const again = app.querySelector(".search");
      again.focus();
      again.setSelectionRange(at, at);
    });
    const rows = list.slice(0, view.shown).map((a) => {
      const st = standing(a, days);
      return row(
        a.email || "(no email)",
        st.badge
          ? h(
              "span.badge" + (st.badge[1] ? "." + st.badge[1] : ""),
              {},
              st.badge[0],
            )
          : null,
        {
          sub: st.text + " · joined " + day(a.joined),
        },
      );
    });
    if (!rows.length)
      rows.push(
        row(q ? "No accounts match." : "No accounts here yet.", null, {
          empty: true,
        }),
      );
    const group = h("div.group", {}, ...rows);
    // Sign-ups that never confirmed their email (bots, mostly), a week on: one tap clears them.
    const STALE_DAYS = 7;
    const stale = data.accounts.filter(
      (a) => !a.confirmed && !a.owner && Date.now() - Date.parse(a.joined) > STALE_DAYS * 86400000,
    ).length;
    const clear = stale
      ? h(
          "button.more.clear-unconfirmed",
          {
            type: "button",
            onclick: async (e) => {
              if (!confirm(`Delete the ${stale} account${stale === 1 ? "" : "s"} that never confirmed their email, over ${STALE_DAYS} days ago? They can't sign in, and have nothing in GA-EFB. This can't be undone.`)) return;
              e.target.disabled = true;
              try {
                const r = await rpc("efb_delete_unconfirmed", { older_than_days: STALE_DAYS });
                if (!r.ok) throw new Error(r.error || "That didn't work.");
                await load();
              } catch (err) {
                e.target.disabled = false;
                alert(err.message);
              }
            },
          },
          `Delete ${stale} unconfirmed account${stale === 1 ? "" : "s"} (over ${STALE_DAYS} days old)`,
        )
      : null;
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
    return section(
      "Customers",
      [
        h(
          "div.segments",
          { role: "group", "aria-label": "Show" },
          filters.map(([id, label]) =>
            h(
              "button",
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
        search,
        group,
        clear,
      ],
      `Every GA-EFB account, newest first. A trial starts the first time the account opens GA-EFB, and lasts ${days} days.`,
    );
  }

  // ---- sales ----

  function salesSection() {
    const rows = data.sales
      .slice(0, view.sales)
      .map((s) =>
        row(
          s.email || "(account deleted)",
          s.refunded
            ? h("span.badge.bad", {}, "Refunded")
            : s.live === false
              ? h("span.badge", {}, "Test")
              : money(s.amount, s.currency),
          { sub: day(s.created) },
        ),
      );
    if (!rows.length) rows.push(row("No sales yet.", null, { empty: true }));
    const group = h("div.group", {}, ...rows);
    if (data.sales.length > view.sales)
      group.append(
        h(
          "button.more",
          {
            type: "button",
            onclick: () => {
              view.sales += 50;
              render();
            },
          },
          `Show more (${data.sales.length - view.sales} more)`,
        ),
      );
    return section(
      "Sales",
      [group],
      "Each sale is recorded once the buyer's GA-EFB unlocks. Refunds show within a day. Amounts are before Stripe's fees.",
    );
  }

  // ---- App Store subscriptions ----

  // Apple's statuses: 1 active, 2 expired, 3 billing retry, 4 billing grace period, 5 refunded.
  const subActive = (s) =>
    s.status === 4 ||
    (s.status === 1 &&
      (!s.expires || new Date(s.expires).getTime() > Date.now() - 86_400_000));
  const PLANS = {
    "uk.co.gaefb.app.monthly": "Monthly",
    "uk.co.gaefb.app.yearly": "Yearly",
  };

  function subscriptionsSection() {
    const list = data.subscriptions || [];
    const rows = list.slice(0, view.subs).map((s) => {
      const plan = PLANS[s.product] || s.product || "Subscription";
      const badge =
        s.status === 5
          ? h("span.badge.bad", {}, "Refunded")
          : s.environment !== "Production"
            ? h("span.badge", {}, "Test")
            : s.status === 4
              ? h("span.badge.warn", {}, "Card problem")
              : subActive(s)
                ? h("span.badge.good", {}, "Active")
                : h("span.badge", {}, s.status === 3 ? "Card problem" : "Ended");
      const when = subActive(s)
        ? (s.renews === false ? "ends " : "renews ") + day(s.expires)
        : "ended " + day(s.expires);
      return row(s.email || "(account deleted)", badge, {
        sub: `${plan}${s.price ? " · " + money(s.price / 10, s.currency) : ""} · since ${day(s.started)} · ${when}`,
      });
    });
    if (!rows.length)
      rows.push(row("No App Store subscriptions yet.", null, { empty: true }));
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

  function keysSection() {
    const holder = h("div.group", {}, row("Loading…", null, { empty: true }));
    rpc("efb_licence_key_batches")
      .then((batches) => {
        const rows = (batches || []).map((b) =>
          row(b.batch || "(no name)", `${b.used} of ${b.total} used`, {
            sub: "Made " + day(b.made),
          }),
        );
        holder.replaceChildren(
          ...(rows.length
            ? rows
            : [row("No keys made yet.", null, { empty: true })]),
        );
      })
      .catch((err) =>
        holder.replaceChildren(
          row(
            missing(err) ? "Set up the account service first." : err.message,
            null,
            { empty: true },
          ),
        ),
      );

    const form = h(
      "form",
      {},
      h(
        "div.group.fields",
        { style: "margin-top:10px" },
        h("input", {
          name: "batch",
          placeholder: "Name (e.g. Gifts, or a shop)",
          maxlength: "60",
          required: true,
        }),
        h("input", {
          name: "count",
          type: "number",
          min: "1",
          max: "1000",
          value: "5",
          required: true,
          "aria-label": "How many",
        }),
      ),
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
      "div",
      {},
      h(
        "p.ok",
        {},
        `${list.length} new ${list.length === 1 ? "key" : "keys"} for "${batch}". Save them now - they won't be shown again.`,
      ),
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
