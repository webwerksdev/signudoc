-- Rows skipped by Part 11 account checks when a "send to many" batch is
-- confirmed are now stored on the batch with status 'skipped' (updating the
-- historical note in 20261118090000_bulk_send_batches.sql that skipped rows
-- are never stored). A retry with the same batch_key restores those rows as
-- skipped instead of sending them if an administrator creates, verifies or
-- unlocks the signer's account in between. envelope_id and reason stay null so
-- no personal details are kept, while rows skipped by CSV validation stay
-- unsaved because the fingerprinted CSV determines them on every run.

alter table public.bulk_send_batch_rows
  drop constraint if exists bulk_send_batch_rows_status_check;

alter table public.bulk_send_batch_rows
  add constraint bulk_send_batch_rows_status_check
    check (status in ('processing', 'sent', 'failed', 'skipped'));
