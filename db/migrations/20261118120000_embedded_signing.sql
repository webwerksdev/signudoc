-- Embedded signing: an app shows the signing page inside its own site, in
-- a frame, instead of SignuDoc emailing the signer a link.
--
-- envelopes.delivery
-- * 'email' (every envelope until now): signers get their links by email.
-- * 'embedded': sent through the API. No signing invitations or reminders
--   are emailed; the app asks the API for a short-lived link for the
--   signer whose turn it is and frames it on a site listed below. The
--   finished copy is still emailed to everyone.
--
-- signers.embed_origin: the site the current link was made for. The page
-- refuses to open for any other, and the certificate names it.
-- signers.embed_link_opened_at: when the current link was first opened.
-- An unopened link lasts 15 minutes; once opened, it lasts for the
-- signing session.
--
-- embed_allowed_origins: the sites (exact origins, such as
-- https://app.example.com) an administrator allows to frame signing
-- pages. Empty means embedding is off.

alter table public.envelopes
  add column if not exists delivery text not null default 'email'
    check (delivery in ('email', 'embedded'));

alter table public.signers
  add column if not exists embed_origin text,
  add column if not exists embed_link_opened_at bigint;

create table if not exists public.embed_allowed_origins (
  origin text primary key check (length(origin) between 8 and 255),
  created_by text references public."user"(id) on delete set null,
  created_at bigint not null
);
