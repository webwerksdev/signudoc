/**
 * A name's words, without case, accents, punctuation or numbers. An
 * apostrophe joins the letters around it, so O'Connor and OConnor are the
 * same word; other punctuation, such as a hyphen, separates words.
 */
export function nameWords(name: string): Set<string> {
  return new Set(
    name
      .replace(/['`´‘’ʼ]/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase("en")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0 && !/\p{N}/u.test(word)),
  );
}

/**
 * Whether two names are the same person's. Case, accents, punctuation and
 * word order do not count, nor do numbers. A name may have words the other
 * lacks, such as a middle name or a title, as long as at least two words
 * match and every word of the shorter name is in the longer; a one-word name
 * has to match exactly.
 */
export function namesMatch(first: string, second: string): boolean {
  const a = nameWords(first);
  const b = nameWords(second);
  const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];

  return (
    shorter.size > 0 &&
    [...shorter].every((word) => longer.has(word)) &&
    (shorter.size >= 2 || a.size === b.size)
  );
}
