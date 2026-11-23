-- The hash of the signing link a signer last held, kept once signing,
-- declining or voiding has taken the link away. It opens nothing: it lets
-- the page an old invitation opens say what happened to the envelope
-- (signed, completed, declined, voided) instead of asking the signer for a
-- new link the sender cannot send. Cleared when an envelope goes back to
-- draft or is sent again, so a link from before then reads as expired.

alter table public.signers
  add column if not exists spent_signing_token_hash text;

create index if not exists idx_signers_spent_signing_token_hash
  on public.signers(spent_signing_token_hash)
  where spent_signing_token_hash is not null;
