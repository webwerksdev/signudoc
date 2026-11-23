import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ambiguousBulkSendColumnsMessage,
  bulkSendBatchKeyForCheck,
  bulkSendCapMessage,
  bulkSendPreviewKey,
  copyRecipientPairError,
  exampleCsvForRoles,
  MAX_BULK_SEND_ROWS,
  missingBulkSendColumnsMessage,
  parseBulkSendCsv,
  parseCsv,
  serializeBulkSendResultsCsv,
  serializeCsv,
  validateBulkSendRows,
} from "./bulk-send-csv.ts";
import { duplicateSignerEmailMessage } from "./schemas/signer.ts";

const oneRole = [{ name: "Signer 1" }];
const twoRoles = [{ name: "Tenant" }, { name: "Landlord" }];

test("quoted commas, doubled quotes, CRLF and a UTF-8 BOM are read as they were written", () => {
  const text =
    '\uFEFFname,email,note\r\n"Smith, Jane",jane@example.test,"said ""hello"""\r\n';

  assert.deepEqual(parseCsv(text), [
    ["name", "email", "note"],
    ["Smith, Jane", "jane@example.test", 'said "hello"'],
  ]);
  assert.deepEqual(parseCsv("a,b\n\n,\n c ,d \n"), [
    ["a", "b"],
    [" c ", "d "],
  ]);
  assert.deepEqual(parseCsv("a,b\r1,2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("a one-signer CSV uses name and email, or the role's columns, and title is optional", () => {
  const named = parseBulkSendCsv(
    "name,email\nJane Smith,jane@example.test\n",
    oneRole,
    "Company NDA",
  );

  assert.equal(named.error, null);
  assert.deepEqual(named.rows, [
    {
      rowNumber: 1,
      signers: [
        {
          email: "jane@example.test",
          name: "Jane Smith",
          roleName: "Signer 1",
        },
      ],
      title: "Company NDA",
    },
  ]);

  const prefixed = parseBulkSendCsv(
    "Signer 1 name,Signer 1 email,title\nLou,lou@example.test,NDA for Lou\n",
    oneRole,
    "Company NDA",
  );

  assert.equal(prefixed.rows[0]?.title, "NDA for Lou");
  assert.equal(prefixed.rows[0]?.signers[0]?.name, "Lou");
});

test("the example CSV round-trips for role names a spreadsheet would read as formulas", () => {
  const roles = [{ name: "- Client" }, { name: "=Vendor" }];
  const csv = exampleCsvForRoles(roles.map((role) => role.name));
  const parsed = parseBulkSendCsv(csv, roles, "Lease");

  assert.equal(parsed.error, null);
  assert.equal(parsed.rows[0]?.signers[0]?.name, "- Client person");
  assert.match(csv, /^- Client name,- Client email,=Vendor name,/);
});

test("the example rows pass validation for role names with punctuation or non-English letters", () => {
  const roleNames = ["Buyer (Tenant)", "Vendeur/Bailleur", "Käufer"];
  const roles = roleNames.map((name) => ({ name }));
  const parsed = parseBulkSendCsv(
    exampleCsvForRoles(roleNames),
    roles,
    "Lease",
  );

  assert.equal(parsed.error, null);
  assert.equal(validateBulkSendRows(parsed.rows)[0]?.status, "ok");
});

test("a multi-role CSV names each role's columns, and the example round-trips", () => {
  const csv = exampleCsvForRoles(["Tenant", "Landlord"]);
  const parsed = parseBulkSendCsv(csv, twoRoles, "Lease");

  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(
    parsed.rows[0]?.signers.map((signer) => signer.roleName),
    ["Tenant", "Landlord"],
  );
  assert.match(
    csv,
    /Tenant name,Tenant email,Landlord name,Landlord email,title/,
  );
});

test("roles that differ only in spacing keep their own columns", () => {
  const roleNames = ["Client Advisor", "Client  Advisor"];
  const roles = roleNames.map((name) => ({ name }));
  const example = parseBulkSendCsv(
    exampleCsvForRoles(roleNames),
    roles,
    "Engagement",
  );

  assert.equal(example.error, null);
  assert.equal(validateBulkSendRows(example.rows)[0]?.status, "ok");
  assert.deepEqual(
    example.rows[0]?.signers.map((signer) => [signer.roleName, signer.email]),
    [
      ["Client Advisor", "signer1@company.com"],
      ["Client  Advisor", "signer2@company.com"],
    ],
  );

  const parsed = parseBulkSendCsv(
    "Client Advisor name,Client Advisor email,Client  Advisor name,Client  Advisor email\n" +
      "Ann,ann@example.test,Bob,bob@example.test\n",
    roles,
    "Engagement",
  );

  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.rows[0]?.signers.map((signer) => [signer.roleName, signer.email]),
    [
      ["Client Advisor", "ann@example.test"],
      ["Client  Advisor", "bob@example.test"],
    ],
  );
  assert.equal(
    parseBulkSendCsv(
      "Client Advisor name,Client Advisor email\nAnn,ann@example.test\n",
      roles,
      "Engagement",
    ).error,
    ambiguousBulkSendColumnsMessage,
  );
});

test("a header's extra spacing still matches a role", () => {
  const parsed = parseBulkSendCsv(
    " Tenant  name ,Tenant email,Landlord   name,Landlord email\n" +
      "Ann,ann@example.test,Bob,bob@example.test\n",
    twoRoles,
    "Lease",
  );

  assert.equal(parsed.error, null);
  assert.equal(parsed.rows[0]?.signers[1]?.email, "bob@example.test");
});

test("a partly filled copy recipient is refused, and a late preview does not match changed copy fields", () => {
  assert.equal(copyRecipientPairError("", ""), null);
  assert.equal(
    copyRecipientPairError("Zofia Copy", "zofia@example.test"),
    null,
  );
  assert.match(
    copyRecipientPairError("Zofia Copy", "") ?? "",
    /copy recipient's email/,
  );
  assert.match(
    copyRecipientPairError("", "zofia@example.test") ?? "",
    /copy recipient's name/,
  );

  const checked = {
    copyEmail: "",
    copyName: "",
    csv: "name,email\nAnn,ann@example.test\n",
    expiresInDays: 14,
    reminderIntervalDays: 3,
    requireEmailCode: false,
    signatureMeaning: null,
  };

  assert.notEqual(
    bulkSendPreviewKey(checked),
    bulkSendPreviewKey({ ...checked, copyEmail: "zofia@example.test" }),
  );
  assert.equal(bulkSendPreviewKey(checked), bulkSendPreviewKey({ ...checked }));
});

test("the header is refused when a signer's columns are missing", () => {
  assert.equal(
    parseBulkSendCsv("name,email\nA,a@example.test\n", twoRoles, "Lease").error,
    missingBulkSendColumnsMessage,
  );
  assert.equal(
    parseBulkSendCsv("", oneRole, "NDA").error,
    missingBulkSendColumnsMessage,
  );
  assert.equal(
    parseBulkSendCsv("name,email\n", oneRole, "NDA").error,
    "Add at least one person.",
  );
});

test("a missing name, a bad email, a duplicate row and a duplicate address are skipped", () => {
  const parsed = parseBulkSendCsv(
    [
      "name,email,title",
      "Alice,alice@example.test,NDA for Alice",
      ",bob@example.test,NDA for Bob",
      "Cara,not-an-email,NDA for Cara",
      "Alice,alice@example.test,NDA for Alice again",
      "Dana,dana@example.test,NDA for Dana",
      "Dana,dana@example.test,NDA for Dana too",
    ].join("\n"),
    oneRole,
    "Company NDA",
  );
  const rows = validateBulkSendRows(parsed.rows);

  assert.deepEqual(
    rows.map((row) => [row.rowNumber, row.status, row.reason]),
    [
      [1, "ok", null],
      [2, "skipped", "Name is required."],
      [3, "skipped", "Enter a valid email address."],
      [4, "skipped", "This row is the same as row 1."],
      [5, "ok", null],
      [6, "skipped", "This row is the same as row 5."],
    ],
  );

  const sameRow = validateBulkSendRows(
    parseBulkSendCsv(
      "Tenant name,Tenant email,Landlord name,Landlord email\nA,a@example.test,B,A@example.test\n",
      twoRoles,
      "Lease",
    ).rows,
  );

  assert.equal(sameRow[0]?.status, "skipped");
  assert.equal(sameRow[0]?.reason, duplicateSignerEmailMessage);
});

test("a title that is too long is skipped, and a copy recipient's address cannot also sign", () => {
  const longTitle = "T".repeat(161);
  const parsed = parseBulkSendCsv(
    `name,email,title\nJane,jane@example.test,${longTitle}\n`,
    oneRole,
    "NDA",
  );
  const rows = validateBulkSendRows(parsed.rows);

  assert.equal(rows[0]?.status, "skipped");
  assert.ok(rows[0]?.reason);

  const copyClash = validateBulkSendRows(
    parseBulkSendCsv("name,email\nJane,jane@example.test\n", oneRole, "NDA")
      .rows,
    ["JANE@example.test"],
  );

  assert.equal(copyClash[0]?.status, "skipped");
  assert.match(copyClash[0]?.reason ?? "", /copy recipient/);
});

test("the 201st row is skipped and the first 200 stay", () => {
  const lines = [
    "name,email",
    ...Array.from({ length: MAX_BULK_SEND_ROWS + 1 }, (_, index) => {
      const n = String(index + 1);

      return `Person ${n},person${n}@example.test`;
    }),
  ];
  const rows = validateBulkSendRows(
    parseBulkSendCsv(lines.join("\n"), oneRole, "NDA").rows,
  );

  assert.equal(rows.length, MAX_BULK_SEND_ROWS + 1);
  assert.equal(rows[MAX_BULK_SEND_ROWS - 1]?.status, "ok");
  assert.equal(rows[MAX_BULK_SEND_ROWS]?.status, "skipped");
  assert.equal(rows[MAX_BULK_SEND_ROWS]?.reason, bulkSendCapMessage);
  assert.equal(
    rows.filter((row) => row.status === "ok").length,
    MAX_BULK_SEND_ROWS,
  );
});

test("a results CSV records each row without turning a cell into a formula", () => {
  const csv = serializeBulkSendResultsCsv(
    [
      {
        envelopeId: "e1",
        envelopePath: "/envelopes/e1",
        reason: null,
        rowNumber: 1,
        signers: [
          {
            email: "jane@example.test",
            name: "Jane",
            roleName: "Signer 1",
          },
        ],
        status: "sent",
        title: "NDA for Jane",
      },
      {
        envelopeId: null,
        envelopePath: null,
        reason: '=HYPERLINK("x")',
        rowNumber: 2,
        signers: [
          {
            email: "bad",
            name: "Bob",
            roleName: "Signer 1",
          },
        ],
        status: "skipped",
        title: "NDA",
      },
    ],
    ["Signer 1"],
  );

  assert.match(
    csv,
    /^Row,Status,Reason,Title,Signer 1 name,Signer 1 email,Envelope\r\n/,
  );
  assert.match(csv, /sent,.*\/envelopes\/e1/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.equal(
    serializeCsv([
      ["a", "b"],
      ["1", "2"],
    ]),
    "a,b\r\n1,2\r\n",
  );
});

test("a changed checked list starts a new batch key, a retry keeps it", () => {
  let next = 0;
  const newKey = () => `key-${String(++next)}`;
  const first = bulkSendBatchKeyForCheck(
    { key: "key-0", requestKey: null },
    "list-a",
    newKey,
  );

  assert.deepEqual(first, { key: "key-0", requestKey: "list-a" });
  assert.deepEqual(bulkSendBatchKeyForCheck(first, "list-a", newKey), first);
  assert.deepEqual(bulkSendBatchKeyForCheck(first, "list-b", newKey), {
    key: "key-1",
    requestKey: "list-b",
  });
});
