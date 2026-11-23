-- signers.embed_api_key_id: the API key that asked for the signer's
-- current embedded link. The signature's evidence names this key, which
-- can differ from the key that created or sent the envelope (a key
-- rotated since, or a draft made in the dashboard and sent through the
-- API).

alter table public.signers
  add column if not exists embed_api_key_id text
    references public.api_keys(id) on delete set null;
