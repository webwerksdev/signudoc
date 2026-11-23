-- Webhooks: the install tells other apps when an envelope changes.
--
-- An administrator adds an endpoint (an https URL and the events it wants)
-- in Settings. Every envelope event that matches is written to
-- webhook_deliveries in the same transaction as its audit row, so a
-- delivery is never lost and never sent for a change that rolled back.
-- The app then POSTs it, signed the Standard Webhooks way, and tries again
-- later when the receiver does not answer 2xx.
--
-- webhook_endpoints
-- * secret_encrypted: the signing secret (whsec_...), sealed with AES-GCM
--   under a key derived from BETTER_AUTH_SECRET, so a copy of the database
--   alone cannot forge deliveries.
-- * previous_secret_*: after a rotation the old secret also signs for 24
--   hours, so a receiver can switch over without dropping anything.
-- * events: the event types it receives, such as 'envelope.completed'.
--
-- webhook_deliveries
-- * id: sent as the webhook-id header. The same on every try, so a
--   receiver can ignore a delivery it already handled.
-- * payload: the JSON body, as text. Null until the first try, which
--   builds it from the envelope as it stands once the change has
--   committed. Kept byte for byte from then on (jsonb would reorder its
--   keys), so a retry sends exactly what the first try sent and signed.
-- * status: pending (to send, or to try again at next_attempt_at),
--   delivered, or failed (gave up after the last try).
-- * locked_until: set while one function is sending it, so two never send
--   the same try at once.

create table if not exists public.webhook_endpoints (
  id text primary key,
  url text not null check (length(url) between 1 and 2048),
  description text not null default '' check (length(description) <= 200),
  secret_encrypted text not null,
  previous_secret_encrypted text,
  previous_secret_expires_at bigint,
  events text[] not null,
  enabled boolean not null default true,
  created_by text references public."user"(id) on delete set null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.webhook_deliveries (
  id text primary key,
  endpoint_id text not null references public.webhook_endpoints(id) on delete cascade,
  event_type text not null,
  envelope_id text,
  audit_event_id text,
  signer_id text,
  payload text,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint,
  locked_until bigint,
  last_status_code integer,
  last_error text,
  created_at bigint not null,
  delivered_at bigint,
  updated_at bigint not null
);

-- What the sender looks for: pending deliveries that are due.
create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status = 'pending';

-- The delivery log in Settings, newest first per endpoint.
create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

-- The API's catch-up list, newest first across endpoints.
create index if not exists webhook_deliveries_created_idx
  on public.webhook_deliveries (created_at desc, id desc);
