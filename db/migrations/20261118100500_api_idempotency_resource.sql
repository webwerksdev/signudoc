-- api_idempotency.resource_id: the envelope a request made, set as soon as
-- it has made it. If the request then fails (say, reading the envelope
-- back for the answer), the reservation is kept, and a retry with the same
-- Idempotency-Key answers with that envelope instead of making and sending
-- a second one.

alter table public.api_idempotency
  add column if not exists resource_id text;
