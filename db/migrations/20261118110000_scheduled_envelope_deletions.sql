-- Finished envelopes an administrator has asked to delete. Nothing goes at
-- once: the envelope stays as it is for the waiting period, its sender is
-- emailed a link to download it, and any administrator can cancel. The
-- daily cleanup deletes it once the wait is over, and never before the
-- sender has been told.

create table if not exists public.scheduled_envelope_deletions (
  envelope_id text primary key references public.envelopes (id) on delete cascade,
  -- Who asked. No foreign key: the request stands, and the record names
  -- them, after their account is gone.
  requested_by_user_id text not null,
  requested_by_email text not null,
  requested_at bigint not null,
  -- Deleted by the first daily cleanup at or after this time.
  delete_after bigint not null,
  reason text,
  -- When the sender was told. Null until the email went out; the daily
  -- cleanup tries again, and a late notice moves delete_after back so the
  -- sender still gets the whole wait. Set at once when the sender asked
  -- themselves.
  sender_notified_at bigint,
  -- A cancelled request is kept until its sender, if they were told it
  -- would go, has been told it will not.
  cancelled_at bigint,
  cancelled_by_user_id text,
  cancelled_by_email text,
  cancel_notified_at bigint,
  -- When the daily cleanup last tried this request's email or deletion.
  -- The ones never tried, then the longest waiting, go first, so a few
  -- that keep failing cannot hold back the rest.
  last_attempt_at bigint
);

create index if not exists scheduled_envelope_deletions_due_idx
  on public.scheduled_envelope_deletions (delete_after);
