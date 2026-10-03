// The Buy buttons: the Stripe checkout link comes from GA-EFB's account service, which gives it
// only once the owner has connected Stripe for real payments. Until then the buttons stay hidden.
// (The address and key are public by design: they're in every copy of GA-EFB.)
const ACCOUNTS = "https://gzdxvcrhfmlbgbziykjk.supabase.co";
const PUBLIC_KEY = "sb_publishable_KrYVpUmemtBqKSsYkY43pw_LOD3PrFI";

fetch(`${ACCOUNTS}/rest/v1/rpc/efb_buy_url`, {
  method: "POST",
  headers: { apikey: PUBLIC_KEY, "Content-Type": "application/json" },
  body: "{}",
})
  .then((res) => (res.ok ? res.json() : null))
  .then((url) => {
    if (typeof url !== "string" || !url.startsWith("https://buy.stripe.com/")) return;
    for (const el of document.querySelectorAll(".buy")) {
      if (el.tagName === "A") el.href = url;
      el.hidden = false;
    }
  })
  .catch(() => {});
