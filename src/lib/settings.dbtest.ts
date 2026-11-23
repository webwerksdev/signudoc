import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests, withTransaction } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  getSettings,
  invalidateSettingsCache,
  saveSettings,
} from "./settings.ts";

// The settings cache against a real Postgres: a save made inside a
// transaction has to show on this instance as soon as it commits, even when
// another request read the settings while the transaction was still open.
// Run with `npm run test:db`.

let database: pg.Pool;
let replaced: pg.Pool | null = null;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});

beforeEach(async () => {
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
});

after(async () => {
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
});

test("a read during an open save does not keep the old settings after commit", async () => {
  await saveSettings({ requireTwoFactor: false, signupMode: "open" });
  invalidateSettingsCache();

  await withTransaction(async (tx) => {
    await saveSettings({ requireTwoFactor: true }, tx);

    // Another request renders a page while the save is still open: it
    // sees the committed (old) row.
    assert.equal((await getSettings()).requireTwoFactor, false);
  }, database);

  assert.equal((await getSettings()).requireTwoFactor, true);
});

test("a read that finishes after a save commits does not cache what it read before", async () => {
  await saveSettings({ requireTwoFactor: false, signupMode: "open" });
  invalidateSettingsCache();

  // Pages read through a pool that runs each query at once but hands the
  // result back only when told: the read sees the row as it was, and
  // returns after the save below has committed.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queried!: () => void;
  const ran = new Promise<void>((resolve) => {
    queried = resolve;
  });
  const slowPool = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "query") {
        return async (...args: Parameters<pg.Pool["query"]>) => {
          const result = await (
            target.query as (...a: unknown[]) => Promise<unknown>
          )(...args);
          queried();
          await released;
          return result;
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });

  replaceDbPoolForTests(slowPool);

  try {
    const oldRead = getSettings();

    await ran;
    await saveSettings({ requireTwoFactor: true }, database);
    release();

    assert.equal((await oldRead).requireTwoFactor, false);
  } finally {
    replaceDbPoolForTests(database);
  }

  assert.equal((await getSettings()).requireTwoFactor, true);
});
