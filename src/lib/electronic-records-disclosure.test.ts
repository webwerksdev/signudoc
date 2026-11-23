import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDisclosureSections,
  buildElectronicRecordsDisclosure,
  DISCLOSURE_MAX_LENGTH,
  disclosureSectionsAsText,
  ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
  getDisclosureVersion,
  normalizeCustomDisclosure,
  standardDisclosureTemplate,
  toStoredCustomDisclosure,
  validateCustomDisclosure,
} from "./electronic-records-disclosure.ts";

const party = { contactAddress: "help@acme.com", senderName: "Acme Corp" };

test("with no custom text the built-in disclosure and its dated version are used", () => {
  for (const custom of [null, undefined, "", "  \n  "]) {
    assert.deepEqual(
      buildDisclosureSections(party, custom),
      buildElectronicRecordsDisclosure(party),
    );
    assert.equal(
      getDisclosureVersion(custom),
      ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
    );
  }
});

test("a custom disclosure is split on blank lines, with headings where marked", () => {
  const sections = buildDisclosureSections(
    party,
    "## Signing online\nBy signing you agree to use electronic records.\n\nContact us any time.\r\n\r\n\r\n  Thank you.  ",
  );

  assert.deepEqual(sections, [
    {
      heading: "Signing online",
      text: "By signing you agree to use electronic records.",
    },
    { heading: "", text: "Contact us any time." },
    { heading: "", text: "Thank you." },
  ]);
});

test("{sender} and {contact} are filled in, in the heading and the text", () => {
  const sections = buildDisclosureSections(
    party,
    "## From {sender}\n{sender} asks you to sign. Write to {contact}.",
  );

  assert.deepEqual(sections, [
    {
      heading: "From Acme Corp",
      text: "Acme Corp asks you to sign. Write to Acme Corp at help@acme.com.",
    },
  ]);

  // With no address to write to, the contact is just the sender.
  assert.equal(
    buildDisclosureSections(
      { contactAddress: null, senderName: "Acme Corp" },
      "Write to {contact}.",
    )[0]?.text,
    "Write to Acme Corp.",
  );
});

test("the version of a custom text follows the text and nothing else", () => {
  const first = getDisclosureVersion("Agree to sign online.");

  assert.match(first, /^custom-[0-9a-f]{12}$/);
  // The consent request allows a version of up to 40 characters.
  assert.ok(first.length <= 40);
  // Line endings and the ends of the text do not make a new version.
  assert.equal(getDisclosureVersion("  Agree to sign online.\r\n"), first);
  assert.notEqual(getDisclosureVersion("Agree to sign online!"), first);
  assert.notEqual(first, ELECTRONIC_RECORDS_DISCLOSURE_VERSION);
});

test("normalizing makes line endings the same and treats blank text as none", () => {
  assert.equal(normalizeCustomDisclosure(" a\r\nb\rc "), "a\nb\nc");
  assert.equal(normalizeCustomDisclosure(""), null);
  assert.equal(normalizeCustomDisclosure("   \n"), null);
  assert.equal(normalizeCustomDisclosure(null), null);
  assert.equal(normalizeCustomDisclosure(undefined), null);
});

test("a heading needs words under it, and the text has a length limit", () => {
  assert.equal(validateCustomDisclosure(null), null);
  assert.equal(validateCustomDisclosure(""), null);
  assert.equal(validateCustomDisclosure("## Heading\nWords."), null);
  assert.equal(validateCustomDisclosure("Just a paragraph."), null);

  assert.match(
    validateCustomDisclosure("## Heading only") ?? "",
    /under each heading/,
  );
  assert.match(
    validateCustomDisclosure("Fine.\n\n## Heading only") ?? "",
    /under each heading/,
  );
  assert.match(validateCustomDisclosure("## \nWords.") ?? "", /under each/);

  assert.equal(
    validateCustomDisclosure("a".repeat(DISCLOSURE_MAX_LENGTH)),
    null,
  );
  assert.match(
    validateCustomDisclosure("a".repeat(DISCLOSURE_MAX_LENGTH + 1)) ?? "",
    /characters or fewer/,
  );
});

test("a heading with nothing under it is shown as a paragraph, not dropped", () => {
  assert.deepEqual(buildDisclosureSections(party, "## Only a heading"), [
    { heading: "", text: "Only a heading" },
  ]);
});

test("the standard template, used as custom text, reads the same as the built-in words", () => {
  const template = standardDisclosureTemplate();

  assert.equal(validateCustomDisclosure(template), null);
  assert.deepEqual(
    buildDisclosureSections(party, template),
    buildElectronicRecordsDisclosure(party),
  );
  assert.deepEqual(
    buildDisclosureSections(
      { contactAddress: null, senderName: "Jordan Lee" },
      template,
    ),
    buildElectronicRecordsDisclosure({
      contactAddress: null,
      senderName: "Jordan Lee",
    }),
  );
});

test("a dollar sign in a name or address is copied as it is", () => {
  const sections = buildDisclosureSections(
    { contactAddress: "pay$$@acme.com", senderName: "Dollar $$ $& Consulting" },
    "## From {sender}\nWrite to {contact}.",
  );

  assert.deepEqual(sections, [
    {
      heading: "From Dollar $$ $& Consulting",
      text: "Write to Dollar $$ $& Consulting at pay$$@acme.com.",
    },
  ]);
});

test("the words a signer read are kept as one text, filled in", () => {
  const sections = buildDisclosureSections(
    party,
    "## Signing online\n{sender} asks you to sign online.\n\nWrite to {contact}.",
  );

  assert.equal(
    disclosureSectionsAsText(sections),
    "Signing online\nAcme Corp asks you to sign online.\n\nWrite to Acme Corp at help@acme.com.",
  );
});

test("the standard text saved unchanged is stored as no custom text", () => {
  assert.equal(toStoredCustomDisclosure(standardDisclosureTemplate()), null);
  assert.equal(
    toStoredCustomDisclosure(`  ${standardDisclosureTemplate()}\r\n`),
    null,
  );
  assert.equal(toStoredCustomDisclosure("Our words."), "Our words.");
  assert.equal(toStoredCustomDisclosure("   "), null);
});
