-- Consent disclosure: the words a signer reads and agrees to before signing,
-- which an administrator can now write for their own organization.
--
-- * app_settings.consent_disclosure: the administrator's own text. Null
--   means the built-in disclosure is shown, as it was before this column.
--   Blank lines separate paragraphs, and a paragraph that starts with "## "
--   has a heading. See electronic-records-disclosure.ts.

alter table public.app_settings
  add column if not exists consent_disclosure text
    check (
      consent_disclosure is null
      or char_length(consent_disclosure) between 1 and 6000
    );
