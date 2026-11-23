-- Part 11: the name and email address an administrator confirmed, kept
-- with the confirmation. The confirmation counts only while the account
-- still has that name and address, so changing either one (in the profile,
-- or through the email change flow) needs an administrator to confirm the
-- person again before they can sign.

alter table public."user"
  add column if not exists identity_verified_name text,
  add column if not exists identity_verified_email text;

-- Confirmations made before this change were of the account as it is now.
update public."user"
set
  identity_verified_name = name,
  identity_verified_email = email
where identity_verified_at is not null
  and identity_verified_name is null;
