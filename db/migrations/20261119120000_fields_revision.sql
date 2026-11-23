-- How many times a draft's field list has been saved. The field editor sends
-- the count it last saw with each save, and a save made against an older
-- count is refused, so a save still on its way from a page the sender has
-- left cannot overwrite a newer one made after they came back.

alter table public.envelopes
  add column if not exists fields_revision integer not null default 0;
