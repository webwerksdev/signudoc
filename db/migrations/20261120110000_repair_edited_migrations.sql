-- Three earlier migrations were changed after they were first published,
-- while their pull requests were open. A database that ran an earlier copy
-- of one (a preview deployment that shares the production database, for
-- one) has it recorded as applied, so the columns added later never
-- reached it, and the code that reads them fails. This adds whatever is
-- missing. On a database that ran the final copies it changes nothing.
--
-- From now on a published migration is never changed: a change goes in a
-- new migration, like this one.

-- 20261118110000_scheduled_envelope_deletions.sql
alter table public.scheduled_envelope_deletions
  add column if not exists sender_notified_at bigint,
  add column if not exists cancelled_at bigint,
  add column if not exists cancelled_by_user_id text,
  add column if not exists cancelled_by_email text,
  add column if not exists cancel_notified_at bigint,
  add column if not exists last_attempt_at bigint;

-- 20261118100000_pending_file_deletions.sql
alter table public.pending_file_deletions
  add column if not exists last_tried_at bigint;

drop index if exists public.pending_file_deletions_queued_at_idx;

create index if not exists pending_file_deletions_order_idx
  on public.pending_file_deletions (last_tried_at nulls first, queued_at);

-- 20261118090000_bulk_send_batches.sql
alter table public.bulk_send_batches
  add column if not exists claim_token text,
  add column if not exists claimed_at bigint;
