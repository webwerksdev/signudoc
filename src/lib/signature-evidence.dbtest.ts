import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { runRetentionSweep } from "./retention.ts";
import {
  listAuditEventsForEnvelope,
  recordAuditEvent,
  verifyAuditChain,
} from "./services/audit.ts";
import type { EmailService } from "./services/email.ts";
import { createStorageService } from "./services/storage.ts";
import { eraseSignerData, exportSignerData } from "./signer-data.ts";

// The audit hash chain, signer data requests, account hand-over and the
// retention period, against a real Postgres. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
const createdUsers: string[] = [];
let settingsRowExisted = true;

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-evidence-"));
  settingsRowExisted =
    (await database.query(`select 1 from app_settings`)).rowCount === 1;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    settingsRowExisted
      ? `update app_settings set retention_days = null`
      : `delete from app_settings`,
  );
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

function storage() {
  return createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
}

async function createUser(role: "admin" | "user" = "user") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)`,
    [id, `User ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );

  return id;
}

async function createEnvelope(
  userId: string,
  status: "completed" | "draft" | "sent",
  signerEmail: string,
  finishedAt: number | null = null,
) {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, completed_at
      ) values ($1, $2, 'Test', $3, $4, 'test.pdf', 10, 1, $5, $6)
    `,
    [id, userId, status, `test/${id}.pdf`, "a".repeat(64), finishedAt],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Signer', $3, 1, 'pending')
    `,
    [randomUUID(), id, signerEmail],
  );

  return id;
}

async function envelopeOwner(envelopeId: string) {
  const result = await database.query<{ user_id: string }>(
    `select user_id from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.user_id ?? null;
}

test("events from the same second are listed in the order they were recorded", async () => {
  const owner = await createUser();
  const createdAt = 1_800_000_000;
  const recorded = ["sent", "viewed", "signed", "completed"] as const;

  // The ids are random, so with enough envelopes an order that leans on
  // them is sure to come out wrong for some.
  for (let index = 0; index < 12; index += 1) {
    const envelopeId = await createEnvelope(owner, "sent", "a@example.test");

    for (const event of recorded) {
      await recordAuditEvent(
        { actorType: "system", createdAt, envelopeId, event },
        database,
      );
    }

    const listed = await listAuditEventsForEnvelope(envelopeId, database);

    assert.deepEqual(
      listed.map((event) => event.event),
      recorded,
    );
  }
});

test("the audit chain verifies, and shows an edited row", async () => {
  const owner = await createUser();
  const envelopeId = await createEnvelope(owner, "sent", "a@example.test");

  for (const event of ["created", "sent", "viewed"] as const) {
    await recordAuditEvent(
      { actorType: "system", envelopeId, event, metadata: { n: event } },
      database,
    );
  }

  assert.deepEqual(await verifyAuditChain(envelopeId, database), {
    chainedEvents: 3,
    ok: true,
  });

  await database.query(
    `update audit_events set ip_address = '10.0.0.1' where envelope_id = $1 and event = 'sent'`,
    [envelopeId],
  );

  const check = await verifyAuditChain(envelopeId, database);

  assert.equal(check.ok, false);
  assert.equal(check.ok ? null : check.brokenAtSequence, 2);
});

test("a signer's data can be exported, then erased from finished envelopes only", async () => {
  const owner = await createUser();
  const email = `${randomUUID()}@example.test`;
  const finished = await createEnvelope(owner, "completed", email, 1);
  const inFlight = await createEnvelope(owner, "sent", email);
  const draft = await createEnvelope(owner, "draft", email);

  const exported = await exportSignerData(email.toUpperCase(), database);

  assert.equal(exported.envelopes.length, 3);

  await assert.rejects(eraseSignerData(email, "someone@else.test", database));

  const result = await eraseSignerData(email, email, database);

  assert.equal(result.deletedEnvelopes, 1);
  assert.equal(result.removedFromDrafts, 1);
  assert.deepEqual(
    result.skippedInProgress.map((row) => row.id),
    [inFlight],
  );
  assert.equal(await envelopeOwner(finished), null);
  assert.equal(await envelopeOwner(draft), owner);
  assert.equal((await exportSignerData(email, database)).envelopes.length, 1);
});

test("closing an account hands finished envelopes to an administrator", async () => {
  const admin = await createUser("admin");
  const leaver = await createUser();
  const finished = await createEnvelope(
    leaver,
    "completed",
    "x@example.test",
    1,
  );
  const draft = await createEnvelope(leaver, "draft", "x@example.test");

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [leaver],
  );

  const summary = await runRetentionSweep({
    database,
    storageService: storage(),
  });

  assert.ok(!summary.accountPurgeFailures.includes(leaver));
  assert.equal(await envelopeOwner(finished), admin);
  assert.equal(await envelopeOwner(draft), null);
});

test("the retention period warns the sender, then deletes", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const old = await createEnvelope(
    owner,
    "completed",
    "r@example.test",
    now - 400 * day,
  );
  const recent = await createEnvelope(
    owner,
    "completed",
    "r@example.test",
    now - 10 * day,
  );
  const sent: string[] = [];
  const emailService = {
    send: async (message: { subject: string; to: string }) => {
      sent.push(message.to);

      return { accepted: [message.to], rejected: [] };
    },
    sendBatch: async () => ({ accepted: [], rejected: [] }),
  } as unknown as EmailService;

  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 365, 1, 1)
     on conflict (id) do update set retention_days = 365`,
  );

  const first = await runRetentionSweep({
    database,
    emailService,
    now,
    storageService: storage(),
  });

  assert.ok(first.finishedEnvelopeWarningsSent >= 1);

  // A shorter period set after the warning does not bring the date forward.
  await database.query(`update app_settings set retention_days = 30`);

  const tooSoon = await runRetentionSweep({
    database,
    emailService,
    now: now + 8 * day,
    storageService: storage(),
  });

  assert.equal(tooSoon.finishedEnvelopesDeleted, 0);
  assert.equal(await envelopeOwner(old), owner);
  assert.ok(sent.includes(`${owner}@example.test`));
  assert.equal(await envelopeOwner(old), owner);

  const later = await runRetentionSweep({
    database,
    emailService,
    now: now + 31 * day,
    storageService: storage(),
  });

  assert.ok(later.finishedEnvelopesDeleted >= 1);
  assert.equal(await envelopeOwner(old), null);
  assert.equal(await envelopeOwner(recent), owner);
});

test("the retention period never warns about or deletes a Part 11 record", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const record = await createEnvelope(
    owner,
    "completed",
    "p11@example.test",
    now - 400 * day,
  );
  const sent: string[] = [];
  const emailService = {
    send: async (message: { subject: string; to: string }) => {
      sent.push(message.to);

      return { accepted: [message.to], rejected: [] };
    },
    sendBatch: async () => ({ accepted: [], rejected: [] }),
  } as unknown as EmailService;

  await database.query(`update envelopes set part11 = true where id = $1`, [
    record,
  ]);
  // Part 11 mode refuses a retention period, but one set before (or by
  // hand) must still leave Part 11 records alone.
  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 30, 1, 1)
     on conflict (id) do update set retention_days = 30`,
  );

  for (const at of [now, now + 60 * day]) {
    await runRetentionSweep({
      database,
      emailService,
      now: at,
      storageService: storage(),
    });
  }

  assert.equal(await envelopeOwner(record), owner);
  assert.equal(sent.includes(`${owner}@example.test`), false);
});

test("the retention period leaves an envelope alone while its scheduled deletion waits", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const record = await createEnvelope(
    owner,
    "completed",
    "waiting@example.test",
    now - 400 * day,
  );
  const emailService = {
    send: async (message: { to: string }) => ({
      accepted: [message.to],
      rejected: [],
    }),
    sendBatch: async () => [],
  } as unknown as EmailService;

  // Warned long ago, and past the period: due under the timer.
  await database.query(
    `update envelopes set retention_warned_at = $1 where id = $2`,
    [now - 60 * day, record],
  );
  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 30, 1, 1)
     on conflict (id) do update set retention_days = 30`,
  );
  // An administrator asked for it to go in two weeks instead.
  await database.query(
    `
      insert into scheduled_envelope_deletions (
        envelope_id, requested_by_user_id, requested_by_email, requested_at,
        delete_after, sender_notified_at
      ) values ($1, $2, 'admin@example.test', $3, $4, $3)
    `,
    [record, owner, now, now + 14 * day],
  );

  await runRetentionSweep({
    database,
    emailService,
    now,
    storageService: storage(),
  });
  assert.equal(await envelopeOwner(record), owner);

  // Cancelled: the timer applies again.
  await database.query(
    `update scheduled_envelope_deletions set cancelled_at = $1, cancelled_by_user_id = $2 where envelope_id = $3`,
    [now + day, owner, record],
  );
  await runRetentionSweep({
    database,
    emailService,
    now: now + day,
    storageService: storage(),
  });
  assert.equal(await envelopeOwner(record), null);
});

test("retention keeps working on a database the scheduled-deletion migration has not reached", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const record = await createEnvelope(
    owner,
    "completed",
    "older-database@example.test",
    now - 400 * day,
  );
  const emailService = {
    send: async (message: { to: string }) => ({
      accepted: [message.to],
      rejected: [],
    }),
    sendBatch: async () => [],
  } as unknown as EmailService;

  await database.query(
    `update envelopes set retention_warned_at = $1 where id = $2`,
    [now - 60 * day, record],
  );
  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 30, 1, 1)
     on conflict (id) do update set retention_days = 30`,
  );
  // As a preview sharing the production database sees it before the
  // migration runs: no scheduled deletions table.
  await database.query(
    `alter table scheduled_envelope_deletions rename to scheduled_envelope_deletions_hidden`,
  );

  try {
    await runRetentionSweep({
      database,
      emailService,
      now,
      storageService: storage(),
    });
  } finally {
    await database.query(
      `alter table scheduled_envelope_deletions_hidden rename to scheduled_envelope_deletions`,
    );
  }

  assert.equal(await envelopeOwner(record), null);
});

test("a deletion scheduled after the retention period's list was read still keeps the envelope", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const record = await createEnvelope(
    owner,
    "completed",
    "scheduled-meanwhile@example.test",
    now - 400 * day,
  );
  const emailService = {
    send: async (message: { to: string }) => ({
      accepted: [message.to],
      rejected: [],
    }),
    sendBatch: async () => [],
  } as unknown as EmailService;

  await database.query(
    `update envelopes set retention_warned_at = $1 where id = $2`,
    [now - 60 * day, record],
  );
  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 30, 1, 1)
     on conflict (id) do update set retention_days = 30`,
  );

  // Once the sweep has read which envelopes are due, an administrator
  // schedules this one's deletion.
  let scheduled = false;
  const watched = new Proxy(database, {
    get(target, property) {
      if (property === "query") {
        return async (...args: Parameters<pg.Pool["query"]>) => {
          const result = await (
            target.query as (...a: unknown[]) => Promise<unknown>
          )(...args);

          if (
            !scheduled &&
            typeof args[0] === "string" &&
            args[0].includes("retention_warned_at AS")
          ) {
            scheduled = true;
            await target.query(
              `
                insert into scheduled_envelope_deletions (
                  envelope_id, requested_by_user_id, requested_by_email,
                  requested_at, delete_after, sender_notified_at
                ) values ($1, $2, 'admin@example.test', $3, $4, $3)
              `,
              [record, owner, now, now + 14 * day],
            );
          }

          return result;
        };
      }

      const value: unknown = Reflect.get(target, property);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await runRetentionSweep({
    database: watched,
    emailService,
    now,
    storageService: storage(),
  });

  assert.equal(scheduled, true);
  assert.equal(await envelopeOwner(record), owner);
});

test("a file the retention period cannot delete stays queued, and the run reports it", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const record = await createEnvelope(
    owner,
    "completed",
    "storage-down@example.test",
    now - 400 * day,
  );
  const emailService = {
    send: async (message: { to: string }) => ({
      accepted: [message.to],
      rejected: [],
    }),
    sendBatch: async () => [],
  } as unknown as EmailService;
  const failingStorage = {
    ...storage(),
    deleteObject: async () => {
      throw new Error("Storage is down.");
    },
  } as ReturnType<typeof storage>;

  await database.query(
    `update envelopes set retention_warned_at = $1 where id = $2`,
    [now - 60 * day, record],
  );
  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 30, 1, 1)
     on conflict (id) do update set retention_days = 30`,
  );

  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    const summary = await runRetentionSweep({
      database,
      emailService,
      now,
      storageService: failingStorage,
    });

    assert.ok(summary.finishedEnvelopeDeletionFailures.includes(record));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(await envelopeOwner(record), null);

  const queued = await database.query(
    `select 1 from pending_file_deletions where storage_key = $1`,
    [`test/${record}.pdf`],
  );

  assert.equal(queued.rowCount, 1);

  // Storage is back: the next sweep deletes it.
  await runRetentionSweep({
    database,
    emailService,
    now: now + day,
    storageService: storage(),
  });

  const left = await database.query(
    `select 1 from pending_file_deletions where storage_key = $1`,
    [`test/${record}.pdf`],
  );

  assert.equal(left.rowCount, 0);
});
