// The notice an administrator agrees to before their own words replace the
// standard disclosure signers read. Kept apart from
// electronic-records-disclosure.ts, which runs only on the server, so the
// Organization form can show the same words.

/**
 * The notice an administrator must agree to before saving their own words
 * in place of the standard disclosure. The Organization form shows these
 * words, and the site audit trail keeps the version with each agreement, so
 * change the version whenever the words change.
 */
export const CUSTOM_DISCLOSURE_NOTICE_VERSION = "2026-11-20";

export const CUSTOM_DISCLOSURE_NOTICE = {
  title: "Before you change what signers agree to",
  paragraphs: [
    {
      lead: null,
      text: "The standard text tells signers what the U.S. E-SIGN Act requires before a consumer agrees to sign electronically: that they can choose paper instead, how to get a paper copy, how to withdraw and what that means, and what device and software they need. If you remove or change any of this, your signers' electronic signatures and records may not be valid under E-SIGN or other laws where you or your signers are.",
    },
    {
      lead: "One more thing, from us to you:",
      text: "we're software folks, not lawyers. Nothing in SignuDoc, including the standard text we include for your signers, is legal advice, and we can't promise any wording will hold up between you and the people who sign. Before you rely on this as part of a legal agreement, please run it past your own legal counsel. They know your business and where your signers are.",
    },
  ],
  agree: "I agree",
} as const;

/** Shown under the disclosure box in Settings, before anything is saved. */
export const CUSTOM_DISCLOSURE_LEGAL_NOTE =
  "We're not lawyers, and nothing here is legal advice, including the standard text we include for your signers. Please check any wording with your own legal counsel before you rely on it.";

/**
 * A disclosure tidied the way it is stored: the same line endings and the
 * ends trimmed. Empty means there is none.
 */
export function tidyDisclosureText(text: string | null | undefined): string {
  return (text ?? "").replace(/\r\n?/g, "\n").trim();
}
