-- API keys for the public API (/api/v1).
--
-- An administrator creates a key in Settings and sees it once. Only a
-- SHA-256 hash of the key is kept, the same way signing links are, so a
-- copy of the database cannot be used to call the API. A key acts as the
-- administrator who created it: envelopes it creates are theirs, and a
-- key stops working when that account stops being an administrator.
--
-- * prefix: the start of the key, shown so people can tell keys apart.
-- * scope: 'read' may only look; 'write' may also create, send and void.
-- * last_used_at: written at most once a minute, in seconds.
-- * expires_at, revoked_at: null until set. A revoked key never works again.

create table if not exists public.api_keys (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  prefix text not null,
  key_hash text not null unique check (length(key_hash) = 64),
  scope text not null check (scope in ('read', 'write')),
  created_at bigint not null,
  last_used_at bigint,
  expires_at bigint,
  revoked_at bigint
);

create index if not exists api_keys_user_id_idx
  on public.api_keys (user_id);
