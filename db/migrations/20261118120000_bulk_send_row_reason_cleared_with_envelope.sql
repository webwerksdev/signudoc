-- A send-to-many row that failed after its draft was made keeps a reason
-- that can name the signer (a Part 11 account problem does). When that
-- envelope is deleted, by the stale draft cleanup or any other path, the
-- row's envelope link is set to null and erasing the signer's data can no
-- longer find the row. So clear the reason as its envelope goes. The row
-- and its status stay, so a retry of the batch still does not send it
-- again.

create or replace function public.clear_bulk_send_row_reason()
returns trigger
language plpgsql
as $$
begin
  update public.bulk_send_batch_rows
  set reason = null
  where envelope_id = old.id and reason is not null;

  return old;
end;
$$;

drop trigger if exists envelopes_clear_bulk_send_row_reason
  on public.envelopes;

create trigger envelopes_clear_bulk_send_row_reason
  before delete on public.envelopes
  for each row execute function public.clear_bulk_send_row_reason();
