// What a signer is told, and agrees to, before signing: the disclosure the
// US laws on electronic signatures expect (ESIGN 101(c), UETA 5) and that
// works as a plain statement of terms elsewhere. Its version is stored with
// each signer's agreement, so the record shows which words they saw. Change
// the version whenever the words change.
//
// An administrator can replace the built-in words with their own under
// Settings, Organization. That text has no number to bump, so its version is
// taken from the text itself: change a word and the version changes.

import { createHash } from "node:crypto";

import { tidyDisclosureText } from "./consent-disclosure-notice.ts";

export const ELECTRONIC_RECORDS_DISCLOSURE_VERSION = "2026-11-13";

/** The longest custom disclosure, in characters. */
export const DISCLOSURE_MAX_LENGTH = 6000;

const HEADING_MARK = "## ";

export type DisclosureParty = {
  /** Who to ask for a paper copy or to withdraw: the organization or sender. */
  contactAddress: string | null;
  senderName: string;
};

/** A section with no heading is shown as a plain paragraph. */
export type DisclosureSection = { heading: string; text: string };

function contactFor(party: DisclosureParty): string {
  return party.contactAddress
    ? `${party.senderName} at ${party.contactAddress}`
    : party.senderName;
}

/** The built-in words, with who is asking and who to write to given as text. */
function standardSections(
  sender: string,
  contact: string,
): DisclosureSection[] {
  return [
    {
      heading: "Using electronic records and signatures",
      text: `${sender} asks you to receive this document and sign it electronically instead of on paper. If you agree, your electronic signature has the same effect as a handwritten one, and the documents you receive this way count as delivered to you in writing.`,
    },
    {
      heading: "You can choose paper instead",
      text: `You do not have to agree. To sign on paper instead, or to ask for a paper copy of any document after signing, contact ${contact}. A paper copy is free unless ${sender} tells you otherwise before you ask.`,
    },
    {
      heading: "Withdrawing your agreement",
      text: `You can withdraw this agreement at any time before you sign by declining or by telling ${contact}. Withdrawing does not undo a signature you already gave.`,
    },
    {
      heading: "What you need",
      text: "A current web browser and a device that can open and save PDF files. You will receive the signed document by email, so keep your email address up to date with the sender. Download and keep the signed copy: it is your record.",
    },
    {
      heading: "This agreement covers",
      text: "This document and the notices about it that are sent to you through this site.",
    },
  ];
}

export function buildElectronicRecordsDisclosure(
  party: DisclosureParty,
): DisclosureSection[] {
  return standardSections(party.senderName, contactFor(party));
}

/**
 * The built-in words written as a custom disclosure, with {sender} and
 * {contact} where the sender's name and the address to write to go. It is
 * what the Organization form offers as a starting point to change.
 */
export function standardDisclosureTemplate(): string {
  return standardSections("{sender}", "{contact}")
    .map((section) => `${HEADING_MARK}${section.heading}\n${section.text}`)
    .join("\n\n");
}

export const CONSENT_STATEMENT =
  "I have read the disclosure above, I can open and save PDF files on this device, and I agree to use electronic records and signatures for this document.";

/**
 * A custom disclosure as it is stored: line endings made the same and the
 * ends trimmed. Empty means there is none, and the built-in words are used.
 */
export function normalizeCustomDisclosure(
  text: string | null | undefined,
): string | null {
  const normalized = tidyDisclosureText(text);

  return normalized.length === 0 ? null : normalized;
}

/** Splits a custom disclosure into its paragraphs, before anything is filled in. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function splitHeading(paragraph: string): {
  body: string;
  heading: string | null;
} {
  if (!paragraph.startsWith(HEADING_MARK)) {
    return { body: paragraph, heading: null };
  }

  const [firstLine = "", ...rest] = paragraph.split("\n");

  return {
    body: rest.join("\n").trim(),
    heading: firstLine.slice(HEADING_MARK.length).trim(),
  };
}

/**
 * Why a custom disclosure cannot be saved, or null when it can. A heading
 * needs words under it, because a section with only a heading would show
 * the signer nothing to agree to.
 */
export function validateCustomDisclosure(
  text: string | null | undefined,
): string | null {
  const normalized = normalizeCustomDisclosure(text);

  if (normalized === null) {
    return null;
  }

  if (normalized.length > DISCLOSURE_MAX_LENGTH) {
    return `Keep this to ${DISCLOSURE_MAX_LENGTH} characters or fewer.`;
  }

  for (const paragraph of splitParagraphs(normalized)) {
    const { body, heading } = splitHeading(paragraph);

    if (heading !== null && (heading.length === 0 || body.length === 0)) {
      return 'Put some words under each heading. A heading is a line that starts with "## ".';
    }
  }

  return null;
}

/**
 * The sections a signer reads. A custom disclosure is split on blank lines,
 * and {sender} and {contact} are filled in with who is asking and who to
 * write to, as the built-in words do.
 */
export function buildDisclosureSections(
  party: DisclosureParty,
  customText: string | null | undefined,
): DisclosureSection[] {
  const normalized = normalizeCustomDisclosure(customText);

  if (normalized === null) {
    return buildElectronicRecordsDisclosure(party);
  }

  const contact = contactFor(party);
  const sections: DisclosureSection[] = [];

  for (const paragraph of splitParagraphs(normalized)) {
    const { body, heading } = splitHeading(paragraph);
    // A heading with nothing under it cannot be saved, but is not dropped if
    // one got in: its words are shown as a paragraph.
    const text = body.length > 0 ? body : (heading ?? "");

    if (text.length === 0) {
      continue;
    }

    sections.push({
      heading: body.length > 0 ? fillPlaceholders(heading ?? "", party) : "",
      text: fillPlaceholders(text, party, contact),
    });
  }

  return sections;
}

function fillPlaceholders(
  text: string,
  party: DisclosureParty,
  contact: string = contactFor(party),
): string {
  // Callbacks, so a "$" in a name or address is copied as it is rather
  // than read as a replacement pattern.
  return text
    .replaceAll("{sender}", () => party.senderName)
    .replaceAll("{contact}", () => contact);
}

/**
 * The sections as one text, the way the signer read them: a heading on its
 * own line above its paragraph, and a blank line between sections. It is
 * what the audit trail keeps of a custom disclosure.
 */
export function disclosureSectionsAsText(
  sections: readonly DisclosureSection[],
): string {
  return sections
    .map((section) =>
      section.heading ? `${section.heading}\n${section.text}` : section.text,
    )
    .join("\n\n");
}

/**
 * A custom disclosure as it is saved. The standard text saved unchanged is
 * the same as no custom text, so it is stored as none and keeps the
 * built-in version.
 */
export function toStoredCustomDisclosure(
  text: string | null | undefined,
): string | null {
  const normalized = normalizeCustomDisclosure(text);

  return normalized === normalizeCustomDisclosure(standardDisclosureTemplate())
    ? null
    : normalized;
}

/**
 * Names the words a signer agreed to. The built-in words keep their dated
 * version. A custom text is named by a short fingerprint of the text, so the
 * version changes whenever the text does, whoever wrote it.
 */
export function getDisclosureVersion(
  customText: string | null | undefined,
): string {
  const normalized = normalizeCustomDisclosure(customText);

  if (normalized === null) {
    return ELECTRONIC_RECORDS_DISCLOSURE_VERSION;
  }

  const fingerprint = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);

  return `custom-${fingerprint}`;
}
