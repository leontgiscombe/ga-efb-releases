create table if not exists public.efb_data (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  data text,
  updated_at bigint not null default 0,
  modified timestamptz not null default now(),
  primary key (user_id, name)
);

alter table public.efb_data enable row level security;

drop policy if exists "Your own data only" on public.efb_data;
create policy "Your own data only" on public.efb_data
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.efb_data to authenticated;

create or replace function public.efb_data_touch() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.modified := now();
  return new;
end $$;

drop trigger if exists efb_data_touch on public.efb_data;
create trigger efb_data_touch before insert or update on public.efb_data
  for each row execute function public.efb_data_touch();

create table if not exists public.efb_licence_keys (
  key_hash text primary key,
  batch text not null default '',
  made timestamptz not null default now(),
  redeemed_by uuid references auth.users (id) on delete set null,
  redeemed_at timestamptz
);
create index if not exists efb_licence_keys_redeemed_by on public.efb_licence_keys (redeemed_by);
alter table public.efb_licence_keys enable row level security;
revoke all on public.efb_licence_keys from anon, authenticated;

create table if not exists public.efb_trials (
  email_hash text primary key,
  started timestamptz not null default now()
);
alter table public.efb_trials enable row level security;
revoke all on public.efb_trials from anon, authenticated;

create or replace function public.efb_licence_hash(licence_key text) returns text
  language plpgsql immutable set search_path = '' as $$
declare v text := upper(regexp_replace(coalesce(licence_key, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if length(v) = 21 and left(v, 5) = 'GAEFB' then v := substr(v, 6); end if;
  return encode(pg_catalog.sha256(convert_to(v, 'UTF8')), 'hex');
end $$;

create or replace function public.efb_email_hash() returns text
  language sql stable security definer set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(lower(u.email), 'UTF8')), 'hex')
  from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

create or replace function public.efb_licence_status() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  h text := public.efb_email_hash();
  t timestamptz;
begin
  if auth.uid() is null or h is null then raise exception 'Sign in first'; end if;
  insert into public.efb_trials (email_hash) values (h) on conflict do nothing;
  select started into t from public.efb_trials where email_hash = h;
  return json_build_object(
    'licensed', exists (select 1 from public.efb_licence_keys where redeemed_by = auth.uid()),
    'trial_ends', t + interval '7 days'
  );
end $$;

create or replace function public.efb_redeem_licence(licence_key text) returns json
  language plpgsql security definer set search_path = '' as $$
declare
  k public.efb_licence_keys;
begin
  if auth.uid() is null or public.efb_email_hash() is null then raise exception 'Sign in first'; end if;
  select * into k from public.efb_licence_keys where key_hash = public.efb_licence_hash(licence_key) for update;
  if not found then
    return json_build_object('ok', false, 'error', 'That licence key isn''t right. Check it and try again.');
  end if;
  if k.redeemed_by is not null and k.redeemed_by <> auth.uid() then
    return json_build_object('ok', false, 'error', 'That licence key is already in use with another account.');
  end if;
  update public.efb_licence_keys set redeemed_by = auth.uid(), redeemed_at = coalesce(redeemed_at, now())
    where key_hash = k.key_hash;
  return json_build_object('ok', true);
end $$;

create or replace function public.efb_add_licence_keys(key_hashes text[], batch_name text) returns integer
  language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can add licence keys'; end if;
  insert into public.efb_licence_keys (key_hash, batch)
    select h, coalesce(batch_name, '') from unnest(key_hashes) as h
    where h ~ '^[0-9a-f]{64}$'
    on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.efb_licence_key_batches() returns table (batch text, total bigint, used bigint, made timestamptz)
  language plpgsql security definer set search_path = '' as $$
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can see licence keys'; end if;
  return query
    select k.batch, count(*), count(k.redeemed_by), min(k.made)
    from public.efb_licence_keys k group by k.batch order by min(k.made) desc;
end $$;

revoke all on function public.efb_email_hash() from public, anon, authenticated;
revoke all on function public.efb_licence_status() from public, anon;
revoke all on function public.efb_redeem_licence(text) from public, anon;
revoke all on function public.efb_add_licence_keys(text[], text) from public, anon;
revoke all on function public.efb_licence_key_batches() from public, anon;
grant execute on function public.efb_licence_status() to authenticated;
grant execute on function public.efb_redeem_licence(text) to authenticated;
grant execute on function public.efb_add_licence_keys(text[], text) to authenticated;
grant execute on function public.efb_licence_key_batches() to authenticated;

create extension if not exists http with schema extensions;

create table if not exists public.efb_config (
  name text primary key,
  value text not null
);
alter table public.efb_config enable row level security;
revoke all on public.efb_config from anon, authenticated;

create table if not exists public.efb_purchases (
  session_id text primary key,
  user_id uuid references auth.users (id) on delete set null,
  email_hash text,
  payment_intent text,
  amount bigint,
  currency text,
  created timestamptz not null default now(),
  refunded boolean not null default false,
  checked timestamptz not null default now()
);
-- Paid for real, or in Stripe's Sandbox (test cards): Sandbox purchases never count once live.
alter table public.efb_purchases add column if not exists live boolean not null default false;
create index if not exists efb_purchases_user_id on public.efb_purchases (user_id);
alter table public.efb_purchases enable row level security;
revoke all on public.efb_purchases from anon, authenticated;

-- The owner's test accounts: while Stripe is on the Sandbox, only they (and the owner) are offered
-- Buy, and only their test purchases count - anyone can pay with Stripe's public test card.
create table if not exists public.efb_testers (
  email text primary key,
  added timestamptz not null default now()
);
alter table public.efb_testers enable row level security;
revoke all on public.efb_testers from anon, authenticated;

create or replace function public.efb_stripe_live() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.efb_config where name = 'stripe_key' and value like 'rk_live_%')
$$;

create or replace function public.efb_is_tester(uid uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid and u.email_confirmed_at is not null and (
      lower(u.email) in (select t.email from public.efb_testers t)
      or encode(pg_catalog.sha256(convert_to(lower(u.email), 'UTF8')), 'hex') = '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765'
    )
  )
$$;

-- Whether an account has a purchase that counts: a real one, or (on the Sandbox) a tester's test one.
create or replace function public.efb_has_purchase(uid uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.efb_purchases p
    where p.user_id = uid and not p.refunded
      and (p.live or (not public.efb_stripe_live() and public.efb_is_tester(uid)))
  )
$$;

create table if not exists public.efb_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  at timestamptz not null
);
alter table public.efb_claims enable row level security;
revoke all on public.efb_claims from anon, authenticated;

-- A GET from Stripe's API with the saved key: the JSON, or null (and the error noted for the owner).
create or replace function public.efb_stripe_get(path text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  k text;
  r extensions.http_response;
  msg text;
  body jsonb;
begin
  select value into k from public.efb_config where name = 'stripe_key';
  if k is null then return null; end if;
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');
  exception when others then null;
  end;
  begin
    select * into r from extensions.http((
      'GET', 'https://api.stripe.com/v1/' || path,
      array[extensions.http_header('Authorization', 'Bearer ' || k)], null, null
    )::extensions.http_request);
  exception when others then
    insert into public.efb_config values ('stripe_error', 'Stripe couldn''t be reached: ' || sqlerrm)
      on conflict (name) do update set value = excluded.value;
    return null;
  end;
  begin
    body := r.content::jsonb;
  exception when others then body := null;
  end;
  if r.status <> 200 or body is null then
    msg := coalesce(body -> 'error' ->> 'message', left(r.content, 200));
    insert into public.efb_config values ('stripe_error', 'Stripe answered ' || r.status || ': ' || coalesce(msg, ''))
      on conflict (name) do update set value = excluded.value;
    return null;
  end if;
  delete from public.efb_config where name = 'stripe_error';
  return body;
end $$;

-- Paid checkouts for this account - its id passed to the checkout, or (with no id) its email -
-- recorded as its purchases. Returns how many were new.
create or replace function public.efb_find_purchases(uid uuid, email text) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  link text;
  j jsonb;
  s jsonb;
  q text;
  n integer := 0;
  c integer;
begin
  select value into link from public.efb_config where name = 'stripe_link_id';
  foreach q in array array[
    'checkout/sessions?limit=100&status=complete' || coalesce('&payment_link=' || link, ''),
    'checkout/sessions?limit=100&status=complete&customer_details%5Bemail%5D=' || extensions.urlencode(coalesce(email, '')::varchar)
  ] loop
    j := public.efb_stripe_get(q);
    continue when j is null;
    for s in select * from jsonb_array_elements(coalesce(j -> 'data', '[]'::jsonb)) loop
      -- (Each test is true or false, never null: a null would neither skip nor keep it.)
      continue when coalesce(s ->> 'payment_status', '') not in ('paid', 'no_payment_required');
      continue when link is not null and s ->> 'payment_link' is distinct from link;
      continue when not (
        coalesce(s ->> 'client_reference_id', '') = uid::text
        or (coalesce(s ->> 'client_reference_id', '') = ''
            and lower(coalesce(s -> 'customer_details' ->> 'email', '')) = lower(coalesce(email, '-')))
      );
      insert into public.efb_purchases (session_id, user_id, email_hash, payment_intent, amount, currency, created, live)
      values (
        s ->> 'id', uid, encode(pg_catalog.sha256(convert_to(lower(coalesce(email, '')), 'UTF8')), 'hex'),
        s ->> 'payment_intent', (s ->> 'amount_total')::bigint, s ->> 'currency', to_timestamp((s ->> 'created')::bigint),
        coalesce((s ->> 'livemode')::boolean, public.efb_stripe_live())
      )
      on conflict (session_id) do nothing;
      get diagnostics c = row_count;
      n := n + c;
    end loop;
  end loop;
  return n;
end $$;

-- Purchases that have since been refunded stop counting (checked at most once a day each).
create or replace function public.efb_check_refunds(uid uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  p record;
  j jsonb;
begin
  for p in select * from public.efb_purchases
    where user_id = uid and not refunded and payment_intent is not null and checked < now() - interval '1 day'
      and live = public.efb_stripe_live()
  loop
    j := public.efb_stripe_get('payment_intents/' || extensions.urlencode(p.payment_intent::varchar) || '?expand%5B%5D=latest_charge');
    continue when j is null;
    update public.efb_purchases
      set checked = now(), refunded = coalesce((j -> 'latest_charge' ->> 'refunded')::boolean, false)
      where session_id = p.session_id;
  end loop;
end $$;

create or replace function public.efb_licence_status() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  h text := public.efb_email_hash();
  uid uuid := auth.uid();
  t timestamptz;
  licensed boolean;
  mail text;
begin
  if uid is null or h is null then raise exception 'Sign in first'; end if;
  insert into public.efb_trials (email_hash) values (h) on conflict do nothing;
  select started into t from public.efb_trials where email_hash = h;
  perform public.efb_check_refunds(uid);
  perform public.efb_app_store_refresh(uid);
  licensed := exists (select 1 from public.efb_licence_keys where redeemed_by = uid)
    or public.efb_has_purchase(uid) or public.efb_has_subscription(uid);
  -- The trial is over: perhaps it was bought on the website, with this account's email.
  if not licensed and t + interval '7 days' <= now() then
    select u.email into mail from auth.users u where u.id = uid;
    perform public.efb_find_purchases(uid, mail);
    licensed := public.efb_has_purchase(uid) or public.efb_has_subscription(uid);
  end if;
  return json_build_object(
    'licensed', licensed,
    'trial_ends', t + interval '7 days',
    'owner', h = '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765',
    -- The App Store subscription, if it has one (current or lapsed), for the app's Settings.
    'subscription', (select json_build_object('product', a.product_id, 'status', a.status, 'expires', a.expires,
        'renews', a.renews, 'active', public.efb_has_subscription(uid))
      from public.efb_app_store a where a.user_id = uid order by a.expires desc nulls last limit 1),
    -- Where to buy it (the payment link the owner connected), or null before that - and, while
    -- it's the Sandbox, for anyone but the owner's testers: it isn't on sale yet.
    'buy_url', (select value from public.efb_config where name = 'stripe_link_url'
      and exists (select 1 from public.efb_config where name = 'stripe_key')
      and (public.efb_stripe_live() or public.efb_is_tester(uid)))
  );
end $$;

-- Just bought it: look for the payment now (at most every few seconds per account).
create or replace function public.efb_claim_purchase() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  last timestamptz;
  mail text;
begin
  if uid is null or public.efb_email_hash() is null then raise exception 'Sign in first'; end if;
  select at into last from public.efb_claims where user_id = uid;
  if last is null or last < now() - interval '4 seconds' then
    insert into public.efb_claims values (uid, now()) on conflict (user_id) do update set at = excluded.at;
    select u.email into mail from auth.users u where u.id = uid;
    perform public.efb_find_purchases(uid, mail);
  end if;
  return public.efb_licence_status();
end $$;

-- The owner connects Stripe: a read-only restricted key, and the payment link customers buy with.
create or replace function public.efb_set_stripe(api_key text, link_url text) returns json
  language plpgsql security definer set search_path = '' as $$
declare
  k text := btrim(coalesce(api_key, ''));
  j jsonb;
  lid text;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can connect Stripe'; end if;
  if k !~ '^rk_(test|live)_[A-Za-z0-9]+$' then
    return json_build_object('ok', false, 'error', 'Use a restricted key (it starts rk_live_ or rk_test_), not your secret key.');
  end if;
  insert into public.efb_config values ('stripe_key', k) on conflict (name) do update set value = excluded.value;
  j := public.efb_stripe_get('payment_links?limit=100');
  if j is null then
    delete from public.efb_config where name = 'stripe_key';
    return json_build_object('ok', false, 'error', coalesce(
      (select value from public.efb_config where name = 'stripe_error'), 'Stripe didn''t accept that key.'));
  end if;
  select l ->> 'id' into lid from jsonb_array_elements(coalesce(j -> 'data', '[]'::jsonb)) l
    where rtrim(l ->> 'url', '/') = rtrim(btrim(coalesce(link_url, '')), '/');
  if lid is null then
    delete from public.efb_config where name = 'stripe_key';
    return json_build_object('ok', false, 'error',
      'That payment link isn''t in this Stripe account. Check the key and the link are both from the Sandbox, or both live.');
  end if;
  insert into public.efb_config values ('stripe_link_id', lid) on conflict (name) do update set value = excluded.value;
  insert into public.efb_config values ('stripe_link_url', rtrim(btrim(link_url), '/')) on conflict (name) do update set value = excluded.value;
  return json_build_object('ok', true, 'live', k like 'rk_live_%');
end $$;

-- For the owner's Settings page: whether Stripe is connected (never the key itself).
create or replace function public.efb_stripe_status() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can see this'; end if;
  select value into k from public.efb_config where name = 'stripe_key';
  return json_build_object(
    'connected', k is not null,
    'live', coalesce(k like 'rk_live_%', false),
    'link', (select value from public.efb_config where name = 'stripe_link_url'),
    'error', (select value from public.efb_config where name = 'stripe_error'),
    'purchases', (select count(*) from public.efb_purchases where live and not refunded),
    'refunded', (select count(*) from public.efb_purchases where live and refunded)
  );
end $$;

-- For the website's Buy buttons (anyone may ask): the checkout link, once it takes real payments.
create or replace function public.efb_buy_url() returns text
  language sql stable security definer set search_path = '' as $$
  select l.value from public.efb_config l
  where l.name = 'stripe_link_url'
    and exists (select 1 from public.efb_config k where k.name = 'stripe_key' and k.value like 'rk_live_%')
$$;

revoke all on function public.efb_stripe_get(text) from public, anon, authenticated;
revoke all on function public.efb_stripe_live() from public, anon, authenticated;
revoke all on function public.efb_is_tester(uuid) from public, anon, authenticated;
revoke all on function public.efb_has_purchase(uuid) from public, anon, authenticated;
revoke all on function public.efb_find_purchases(uuid, text) from public, anon, authenticated;
revoke all on function public.efb_check_refunds(uuid) from public, anon, authenticated;
revoke all on function public.efb_claim_purchase() from public, anon;
revoke all on function public.efb_set_stripe(text, text) from public, anon;
revoke all on function public.efb_stripe_status() from public, anon;
grant execute on function public.efb_claim_purchase() to authenticated;
grant execute on function public.efb_set_stripe(text, text) to authenticated;
grant execute on function public.efb_stripe_status() to authenticated;
grant execute on function public.efb_buy_url() to anon, authenticated;

-- App Store subscriptions (the iPad/iPhone app), one row per subscription (Apple's original
-- transaction id), as Apple last said: status 1 active, 2 expired, 3 billing retry, 4 billing grace
-- period, 5 revoked (refunded); price in thousandths (2990 is 2.99).
create table if not exists public.efb_app_store (
  original_transaction_id text primary key,
  user_id uuid references auth.users (id) on delete set null,
  product_id text,
  status integer not null default 0,
  expires timestamptz,
  renews boolean,
  environment text,
  price bigint,
  currency text,
  started timestamptz,
  checked timestamptz not null default now()
);
create index if not exists efb_app_store_user_id on public.efb_app_store (user_id);
alter table public.efb_app_store enable row level security;
revoke all on public.efb_app_store from anon, authenticated;

create table if not exists public.efb_app_store_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  at timestamptz not null
);
alter table public.efb_app_store_claims enable row level security;
revoke all on public.efb_app_store_claims from anon, authenticated;

-- Whether an account has an App Store subscription that counts: active (a day's slack while a
-- renewal is checked again) or in Apple's billing grace period.
create or replace function public.efb_has_subscription(uid uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.efb_app_store a
    where a.user_id = uid
      and (a.status = 4 or (a.status = 1 and coalesce(a.expires, now()) > now() - interval '1 day'))
  )
$$;

-- Asks GA-EFB's cache (which asks Apple) about the subscription a transaction belongs to, and
-- records it when it's this account's. Null, or why it wasn't.
create or replace function public.efb_app_store_check(txn text, uid uuid) returns text
  language plpgsql security definer set search_path = '' as $$
declare
  r extensions.http_response;
  j jsonb;
begin
  if coalesce(txn, '') !~ '^[0-9]{1,20}$' then return 'That isn''t an App Store purchase.'; end if;
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
  exception when others then null;
  end;
  begin
    select * into r from extensions.http((
      'GET', 'https://ga-efb-rain.leontgiscombe.workers.dev/app-store/subscription?transaction=' || txn || '&account=' || uid::text, null, null, null
    )::extensions.http_request);
  exception when others then
    return 'The App Store couldn''t be reached. Try again in a minute.';
  end;
  begin
    j := r.content::jsonb;
  exception when others then j := null;
  end;
  if r.status <> 200 or j is null then
    return coalesce(j ->> 'error', 'The App Store couldn''t be reached (' || r.status || '). Try again in a minute.');
  end if;
  if not coalesce((j ->> 'ok')::boolean, false) or coalesce(j ->> 'original', '') = '' then
    return coalesce(j ->> 'error', 'That purchase wasn''t found in the App Store.');
  end if;
  insert into public.efb_app_store as a
    (original_transaction_id, user_id, product_id, status, expires, renews, environment, price, currency, started, checked)
  values (
    j ->> 'original', uid, j ->> 'product', coalesce((j ->> 'status')::integer, 0),
    to_timestamp((j ->> 'expires')::double precision / 1000), (j ->> 'renews')::boolean, j ->> 'environment',
    (j ->> 'price')::bigint, j ->> 'currency', to_timestamp((j ->> 'purchased')::double precision / 1000), now()
  )
  on conflict (original_transaction_id) do update set
    user_id = excluded.user_id, product_id = excluded.product_id, status = excluded.status, expires = excluded.expires,
    renews = excluded.renews, environment = excluded.environment, price = coalesce(excluded.price, a.price),
    currency = coalesce(excluded.currency, a.currency), started = coalesce(a.started, excluded.started), checked = now();
  return null;
end $$;

-- An account's subscriptions asked about again when they're due to renew (or have lapsed, in case
-- they're renewed), and once a day anyway for refunds: at most once an hour each.
create or replace function public.efb_app_store_refresh(uid uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  a record;
begin
  for a in select * from public.efb_app_store
    where user_id = uid and checked < now() - interval '1 hour'
      and status <> 5
      and (expires is null or expires < now() + interval '1 hour' or checked < now() - interval '1 day')
      -- Long lapsed: no more asking (the app claims it again if it's ever renewed).
      and (expires is null or expires > now() - interval '60 days')
    order by expires desc nulls first limit 3
  loop
    -- Asked, even if Apple couldn't be reached: not again for an hour.
    update public.efb_app_store set checked = now() where original_transaction_id = a.original_transaction_id;
    perform public.efb_app_store_check(a.original_transaction_id, uid);
  end loop;
end $$;

-- The app has just subscribed, or restored its purchases: their transaction ids (a few at most),
-- checked with Apple now. The licence status, and why the last one didn't count if it didn't.
create or replace function public.efb_claim_app_store(transaction_ids text[]) returns json
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  last timestamptz;
  txn text;
  err text;
  status json;
begin
  if uid is null or public.efb_email_hash() is null then raise exception 'Sign in first'; end if;
  select at into last from public.efb_app_store_claims where user_id = uid;
  if last is null or last < now() - interval '3 seconds' then
    insert into public.efb_app_store_claims values (uid, now()) on conflict (user_id) do update set at = excluded.at;
    foreach txn in array coalesce(transaction_ids[1:5], '{}') loop
      err := coalesce(public.efb_app_store_check(txn, uid), err);
    end loop;
  end if;
  status := public.efb_licence_status();
  return json_build_object('status', status, 'error', case when (status ->> 'licensed')::boolean then null else err end);
end $$;

revoke all on function public.efb_has_subscription(uuid) from public, anon, authenticated;
revoke all on function public.efb_app_store_check(text, uuid) from public, anon, authenticated;
revoke all on function public.efb_app_store_refresh(uuid) from public, anon, authenticated;
revoke all on function public.efb_claim_app_store(text[]) from public, anon;
grant execute on function public.efb_claim_app_store(text[]) to authenticated;

-- The owner's dashboard (site/dashboard): every account and what it has done, the sales, and
-- Stripe, in one go. Refunds are brought up to date first, a few at a time (each is a call to Stripe).
create or replace function public.efb_owner_dashboard() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  due record;
  j jsonb;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can see this'; end if;
  for due in select * from public.efb_purchases
    where not refunded and payment_intent is not null and checked < now() - interval '1 day'
      and live = public.efb_stripe_live()
    order by checked limit 20
  loop
    j := public.efb_stripe_get('payment_intents/' || extensions.urlencode(due.payment_intent::varchar) || '?expand%5B%5D=latest_charge');
    continue when j is null;
    update public.efb_purchases
      set checked = now(), refunded = coalesce((j -> 'latest_charge' ->> 'refunded')::boolean, false)
      where session_id = due.session_id;
  end loop;
  return json_build_object(
    'trial_days', 7,
    'stripe', public.efb_stripe_status(),
    'accounts', (select coalesce(json_agg(a order by a.joined desc), '[]'::json) from (
      select
        u.email,
        u.created_at as joined,
        u.last_sign_in_at as last_seen,
        u.email_confirmed_at is not null as confirmed,
        encode(pg_catalog.sha256(convert_to(lower(u.email), 'UTF8')), 'hex') = '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' as owner,
        t.started as trial_started,
        (select min(p.created) from public.efb_purchases p where p.user_id = u.id and not p.refunded
          and (p.live or (not public.efb_stripe_live() and public.efb_is_tester(u.id)))) as bought,
        (select min(k.redeemed_at) from public.efb_licence_keys k where k.redeemed_by = u.id) as key_used,
        (select max(s.expires) from public.efb_app_store s where s.user_id = u.id
          and (s.status = 4 or (s.status = 1 and coalesce(s.expires, now()) > now() - interval '1 day'))) as subscribed,
        exists (select 1 from public.efb_purchases p where p.user_id = u.id and p.refunded) as refunded
      from auth.users u
      left join public.efb_trials t on t.email_hash = encode(pg_catalog.sha256(convert_to(lower(u.email), 'UTF8')), 'hex')
      order by u.created_at desc
      limit 2000
    ) a),
    'sales', (select coalesce(json_agg(s order by s.created desc), '[]'::json) from (
      select p.created, p.amount, p.currency, p.refunded, p.live, u.email
      from public.efb_purchases p left join auth.users u on u.id = p.user_id
      order by p.created desc
      limit 1000
    ) s),
    'subscriptions', (select coalesce(json_agg(s order by s.started desc nulls last), '[]'::json) from (
      select a.started, a.product_id as product, a.status, a.expires, a.renews, a.environment, a.price, a.currency, u.email
      from public.efb_app_store a left join auth.users u on u.id = a.user_id
      order by a.started desc nulls last
      limit 1000
    ) s),
    'testers', (select coalesce(json_agg(t.email order by t.added), '[]'::json) from public.efb_testers t)
  );
end $$;

-- The owner adds or removes a test account (by its email) for trying Buy on the Sandbox.
create or replace function public.efb_set_tester(tester_email text, is_tester boolean) returns json
  language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(btrim(coalesce(tester_email, '')));
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can choose testers'; end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    return json_build_object('ok', false, 'error', 'That doesn''t look like an email address.');
  end if;
  if is_tester then
    insert into public.efb_testers (email) values (e) on conflict do nothing;
  else
    delete from public.efb_testers where email = e;
  end if;
  return json_build_object('ok', true);
end $$;

-- The dashboard's Set Up, once the account service has had a setup with this in it: fetches the
-- setup with that SHA-256 from GA-EFB's website, checks it and runs it - no SQL editor needed.
-- Owner only, and only ever a setup the website has published.
create or replace function public.efb_run_setup(setup_sha256 text) returns text
  language plpgsql security definer set search_path = '' as $$
declare
  r extensions.http_response;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can run the setup'; end if;
  if coalesce(setup_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'That isn''t a GA-EFB setup.'; end if;
  r := extensions.http_get('https://raw.githubusercontent.com/leontgiscombe/ga-efb-releases/gh-pages/setup/' || left(setup_sha256, 16) || '.sql');
  if r.status is distinct from 200 then
    raise exception 'GA-EFB''s setup couldn''t be downloaded (%). Try again in a few minutes.', r.status;
  end if;
  if encode(pg_catalog.sha256(convert_to(r.content, 'UTF8')), 'hex') <> setup_sha256 then
    raise exception 'GA-EFB''s setup didn''t match, so it wasn''t run.';
  end if;
  execute r.content;
  return public.efb_setup_version();
end $$;

-- The owner clears out accounts that never confirmed their email (sign-ups by bots, mostly), once
-- they're a while old. They can't sign in, so they have nothing in GA-EFB; the owner's is never one.
create or replace function public.efb_delete_unconfirmed(older_than_days integer) returns json
  language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can do this'; end if;
  if older_than_days is null or older_than_days < 1 then raise exception 'Only accounts at least a day old.'; end if;
  with gone as (
    delete from auth.users u
    where u.email_confirmed_at is null and u.created_at < now() - make_interval(days => older_than_days)
      and encode(pg_catalog.sha256(convert_to(lower(coalesce(u.email, '')), 'UTF8')), 'hex') <> '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765'
    returning 1
  )
  select count(*) into n from gone;
  return json_build_object('ok', true, 'deleted', n);
end $$;

-- The dashboard's Usage: how much of Supabase's free plan GA-EFB uses (500 MB of database, 50,000
-- monthly active users, 1 GB of files). Active this month: signed in, or a sign-in kept fresh, since
-- the 1st (Supabase's own count, which also sees sign-ins that have since ended, may be a little higher).
create or replace function public.efb_owner_usage() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  since timestamptz := date_trunc('month', now());
  files bigint := 0;
begin
  if public.efb_email_hash() is distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then raise exception 'Only the owner can see this'; end if;
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(sum((metadata ->> ''size'')::bigint), 0) from storage.objects' into files;
  end if;
  return json_build_object(
    'database_bytes', pg_catalog.pg_database_size(current_database()),
    'database_limit', 500 * 1024 * 1024,
    'file_bytes', files,
    'file_limit', 1024 * 1024 * 1024,
    'accounts', (select count(*) from auth.users),
    'active_month', (select count(*) from auth.users u where u.last_sign_in_at >= since
      or exists (select 1 from auth.sessions x where x.user_id = u.id and coalesce(x.refreshed_at, x.updated_at) >= since)),
    'active_limit', 50000
  );
end $$;

revoke all on function public.efb_owner_dashboard() from public, anon;
revoke all on function public.efb_owner_usage() from public, anon;
grant execute on function public.efb_owner_usage() to authenticated;
revoke all on function public.efb_run_setup(text) from public, anon;
revoke all on function public.efb_set_tester(text, boolean) from public, anon;
revoke all on function public.efb_delete_unconfirmed(integer) from public, anon;
grant execute on function public.efb_delete_unconfirmed(integer) to authenticated;
grant execute on function public.efb_set_tester(text, boolean) to authenticated;
grant execute on function public.efb_owner_dashboard() to authenticated;
grant execute on function public.efb_run_setup(text) to authenticated;

-- Deleting your own account (Settings -> GA-EFB Account -> Delete Account, which Apple requires):
-- the account, its sign-ins and its data go. Sales records stay, without the account
-- (efb_purchases' user_id goes null), and so does the trial's email fingerprint (efb_trials).
-- The owner's account can't be deleted this way.
create or replace function public.efb_delete_my_account() returns json
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if public.efb_email_hash() is not distinct from '1fbc972a70cb0a897e5057a0c934cd200f3ce5df319efa6ce96f2a02859d9765' then
    return json_build_object('ok', false, 'error', 'The owner''s account can''t be deleted from the EFB.');
  end if;
  delete from public.efb_data where user_id = uid;
  delete from auth.users where id = uid;
  return json_build_object('ok', true);
end $$;

revoke all on function public.efb_delete_my_account() from public, anon;
grant execute on function public.efb_delete_my_account() to authenticated;

create or replace function public.efb_setup_version() returns text
  language sql immutable set search_path = '' as $$ select '13b45926116279e5'::text $$;
grant execute on function public.efb_setup_version() to anon, authenticated;
