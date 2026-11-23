-- Confirmed "send to many" batches, so a retry of the same confirm does not
-- create another envelope for a row that already went out.
--
-- The client gives each confirm a batch_key. The first request stores each
-- row as it is sent. A later request with that key returns or finishes those
-- stored results instead of sending the list again. Skipped rows are not
-- stored: a retry works them out again from the same list.
--
-- claim_token and claimed_at mark the one request that is sending a batch.
-- They are a saved claim rather than a session lock so they work through
-- pooled connections, and a request that dies leaves a claim that goes
-- stale instead of one that is held forever.

create table if not exists public.bulk_send_batches (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  template_id text not null references public.templates(id) on delete cascade,
  batch_key text not null,
  request_fingerprint text not null,
  claim_token text,
  claimed_at bigint,
  created_at bigint not null default (extract(epoch from now())::bigint),
  constraint bulk_send_batches_user_key unique (user_id, batch_key)
);

create table if not exists public.bulk_send_batch_rows (
  batch_id text not null references public.bulk_send_batches(id) on delete cascade,
  row_number integer not null,
  status text not null
    check (status in ('processing', 'sent', 'failed')),
  envelope_id text references public.envelopes(id) on delete set null,
  reason text,
  primary key (batch_id, row_number)
);

create index if not exists idx_bulk_send_batch_rows_envelope_id
  on public.bulk_send_batch_rows(envelope_id)
  where envelope_id is not null;
