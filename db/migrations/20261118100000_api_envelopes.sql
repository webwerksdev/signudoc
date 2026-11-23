-- What the public API (/api/v1) keeps beyond what the web app does.
--
-- * envelopes.api_key_id: the key that created the envelope, kept after the
--   key is revoked so the record can always say how it was made. Null for
--   envelopes made in the web app.
-- * envelopes.api_metadata: up to 2 KB of JSON the calling app sets when it
--   creates the envelope, returned in every response, so the app can match
--   the envelope to its own records.
-- * signers.api_ref: the name the calling app gave the signer in the create
--   request, returned with the signer.
-- * api_idempotency: the first response to a request sent with an
--   Idempotency-Key header, for 24 hours, so a retried request gets the
--   same answer instead of creating or sending a second envelope. A row
--   with no response yet is a request still being worked on.

alter table public.envelopes
  add column if not exists api_key_id text,
  add column if not exists api_metadata jsonb;

alter table public.signers
  add column if not exists api_ref text;

create table if not exists public.api_idempotency (
  api_key_id text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  request_hash text not null check (length(request_hash) = 64),
  status_code integer,
  response jsonb,
  created_at bigint not null,
  primary key (api_key_id, idempotency_key)
);

create index if not exists api_idempotency_created_at_idx
  on public.api_idempotency (created_at);
