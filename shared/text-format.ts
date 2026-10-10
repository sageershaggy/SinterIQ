/**
 * Presentation of the free text a list brings in. Scraped exports arrive flattened to lower
 * case — "m.j.b construction", "information technology and services", "new york" — and reading a
 * screen of that is hard work, so a company name, a person's name, a job title, an industry and a
 * place are capitalised on the way in and on the way out to a CSV.
 *
 * It is deliberately conservative, because a name is somebody's and this is not the place to
 * invent spellings:
 *
 * - A word that already has a capital anywhere in it is left exactly as it is. A list that says
 *   "IBM", "eBay", "McDonald's" or "GmbH" already knows better than any rule here.
 * - Small joining words fall to lower case, except as the first or last word of the value:
 *   "Information Technology and Services", not "... And ...".
 * - Letters after an apostrophe or a hyphen start a word too ("O'Brien", "Jean-Luc"), but an
 *   apostrophe of possession does not ("Baker's", never "Baker'S").
 * - A run of initials is upper case whether or not it ends in a dot ("M.J.B", "M.J.B."), and so
 *   is a Roman numeral or a company suffix ("LLC", "GmbH", "III").
 * - Prefixes like Mc and Mac are left alone on purpose: "McDonald" cannot be told from "Machine"
 *   by a rule, and guessing wrong in somebody's name is worse than leaving the list's spelling.
 * - Nothing else moves: spacing is tidied and no word is added, removed or re-spelled.
 */
const small = new Set(
  ('a an the and or but nor for of to in on at by with from as per via vs de del la le du des ' +
    'van von der den und y e di da do dos das e').split(' '),
);
/** Said in capitals whenever they appear as a whole word. */
const upper = new Set(['llc', 'inc', 'ltd', 'plc', 'gmbh', 'bv', 'nv', 'sa', 'ag', 'srl', 'spa', 'ii', 'iii', 'iv', 'uk', 'usa', 'uae', 'eu', 'it', 'hr', 'ai']);

const capitalizeWord = (word: string) =>
  word.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());

/** One space-separated word, with its internal apostrophes and hyphens handled. */
function formatWord(word: string, first: boolean, last: boolean) {
  // Already carries a capital: the source knows the spelling, so it is not ours to change.
  if (/\p{Lu}/u.test(word)) return word;
  const plain = word.replace(/[^\p{L}\p{N}]/gu, '');
  if (!plain) return word;
  if (upper.has(plain.toLowerCase())) return word.toUpperCase();
  if (!first && !last && small.has(plain.toLowerCase())) return word.toLowerCase();
  // An initial such as "m.j.b" capitalises every letter it is made of.
  if (/^\p{L}\.(?:\p{L}\.?)+$/u.test(word)) return word.toUpperCase();
  return capitalizeWord(word)
    // A letter after a hyphen starts a word; after an apostrophe only when more than one follows,
    // which is what separates "O'Brien" from "Baker's".
    .replace(/-\p{Ll}/gu, (part) => part.toUpperCase())
    .replace(/'(\p{Ll}{2,})/gu, (_, rest: string) => "'" + capitalizeWord(rest));
}

/** The value as a heading would carry it. Empty in, empty out. */
export function titleCase(value: string) {
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  if (!words[0]) return '';
  return words
    .map((word, index) => formatWord(word, index === 0, index === words.length - 1))
    .join(' ');
}

/** The lead fields this applies to: names, roles, industries and places, never a URL or an email. */
export const titleCasedFields = [
  'name',
  'industry',
  'city',
  'country',
  'contact_name',
  'contact_role',
] as const;
export type TitleCasedField = (typeof titleCasedFields)[number];
