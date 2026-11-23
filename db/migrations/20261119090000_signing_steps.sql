-- Signing at the same time: signers who share a step of the signing order
-- are invited together and sign in any order among themselves. The next
-- step starts once every signer of the step before has signed.
--
-- * signers.signing_step: the step a signer belongs to, counted from 1.
--   sign_order stays what it was, the signer's place in the list, so it is
--   still unique on an envelope and every list keeps its order. Copy
--   recipients are in no step.
-- * Existing signers get the step of their place in the list, which is how
--   they were signing already: one after the other.
-- * idx_signers_single_notified allowed one waiting signer per envelope.
--   Every signer of the current step now waits at once, so it goes. What
--   kept two transactions from both moving the order on, the envelope's row
--   being locked first, still does.
-- * templates_roles_check: a template keeps up to as many roles as an
--   envelope can have signers at most (MAX_SIGNERS_CEILING in
--   src/lib/types/domain.ts).
--
-- A copy of the app from before this migration still runs on this
-- database, but signs a document whose signers share a step one after the
-- other, and only invites the first of them when it is sent.

alter table public.signers
  add column if not exists signing_step integer;

alter table public.signers
  drop constraint if exists signers_signing_step_check;

alter table public.signers
  add constraint signers_signing_step_check
    check (signing_step is null or signing_step > 0);

alter table public.signers
  drop constraint if exists signers_copy_recipient_has_no_step;

alter table public.signers
  add constraint signers_copy_recipient_has_no_step
    check (role = 'signer' or signing_step is null);

update public.signers
set signing_step = sign_order
where role = 'signer'
  and signing_step is null;

drop index if exists public.idx_signers_single_notified;

alter table public.templates
  drop constraint if exists templates_roles_check;

alter table public.templates
  add constraint templates_roles_check check (
    case
      when jsonb_typeof(roles) = 'array'
        then jsonb_array_length(roles) between 1 and 100
      else false
    end
  );
