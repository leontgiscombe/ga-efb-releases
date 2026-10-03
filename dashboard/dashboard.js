// GA-EFB's owner dashboard. It signs in with the owner's GA-EFB account and asks the account
// service directly (server/src/auth/setupSql.ts: efb_owner_dashboard, efb_set_stripe,
// efb_add_licence_keys...). Those functions check it's the owner, so this page is safe to
// publish: anyone else only gets "not the owner". The address and key are public by design.
(() => {
  "use strict";

  const ACCOUNTS = "https://gzdxvcrhfmlbgbziykjk.supabase.co";
  const PUBLIC_KEY = "sb_publishable_KrYVpUmemtBqKSsYkY43pw_LOD3PrFI";
  const STORE = "ga-efb-dashboard";
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
    stripeOpen: false,
    keys: null,
  };

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
    try {
      data = await rpc("efb_owner_dashboard");
    } catch (err) {
      if (missing(err)) data = null;
      else return failed(err);
    }
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
        stripeSection(),
        testersSection(),
        customersSection(),
        salesSection(),
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
        ? "Real payments. The Buy buttons in GA-EFB, the Launcher and on the website use this link."
        : s.connected
          ? "Sandbox: test payments only (card 4242 4242 4242 4242). GA-EFB isn't on sale yet: only your testers see Buy, and the website's Buy buttons stay hidden until a live key and link are connected."
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
