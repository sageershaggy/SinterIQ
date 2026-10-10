/**
 * Checks on a contact's email address and phone number before either is stored against a lead.
 *
 * Research reads these off a company's own pages, where they sit in running text beside opening
 * hours, VAT numbers and image captions. What comes back is often not an address at all, or is
 * the photographer's rather than the purchasing manager's. Nothing here reaches out to the
 * network: an address is not confirmed deliverable and a number is not rung. These are the
 * questions that can be answered from the value itself and from what the lead already says, and
 * each returns its reason so a refusal can be shown rather than silently applied.
 */

/** A value that passed, or did not, and why in a few words. */
export interface ContactCheck {
  ok: boolean;
  /** Empty when ok and nothing is worth saying. */
  reason: string;
  /** The address belongs to the company's own domain: strong evidence it is the right person. */
  ownDomain?: boolean;
}

const localPart = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const domainPart = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+';
const emailShape = new RegExp('^' + localPart + '@' + domainPart + '$');
/**
 * Addresses that are a file, a placeholder or an example rather than a person. A real address at
 * a real company can look like any of these, so the list is short and literal on purpose.
 */
const notAnAddress =
  /\.(?:png|jpe?g|gif|svg|webp|pdf|docx?|css|js)$|^(?:example|test|sample|your|email|name|user)@|@(?:example|test|sentry|localhost)\./i;

/** The registrable part of a host, roughly: enough to tell one company's mail from another's. */
export function emailDomain(value: string) {
  return (/@([^@\s]+)$/.exec(value.trim())?.[1] ?? '').toLowerCase().replace(/\.$/, '');
}
/** A website's host without www., for comparing against an address's domain. */
export function siteDomain(website: string) {
  const text = website.trim();
  if (!text) return '';
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return '';
  }
}
/** Same company's mail: the address's domain is the site's, or a subdomain of it. */
const sameCompany = (address: string, site: string) =>
  Boolean(address && site && (address === site || address.endsWith('.' + site)));

/** Whether this address may be stored for a lead whose website is `website`. */
export function checkEmail(email: string, website = ''): ContactCheck {
  const value = email.trim();
  if (!value) return { ok: true, reason: '' };
  if (value.length > 254) return { ok: false, reason: 'the address is too long to be real' };
  if (!emailShape.test(value)) return { ok: false, reason: 'it is not shaped like an address' };
  if (notAnAddress.test(value))
    return { ok: false, reason: 'it is a placeholder or a file name, not a person' };
  const ownDomain = sameCompany(emailDomain(value), siteDomain(website));
  return {
    ok: true,
    reason: ownDomain ? '' : 'the address is not on the company’s own domain',
    ownDomain,
  };
}

/**
 * Whether this phone number may be stored. Numbering plans differ far too much to validate a
 * number properly without a library and a country, so this only turns away what cannot be a
 * phone number anywhere: too few digits to dial, more than E.164 allows, or a year or a postcode
 * that happened to sit next to the word "phone".
 */
export function checkPhone(phone: string): ContactCheck {
  const value = phone.trim();
  if (!value) return { ok: true, reason: '' };
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return { ok: false, reason: 'too few digits to be a phone number' };
  if (digits.length > 15) return { ok: false, reason: 'more digits than any phone number has' };
  if (/[A-Za-z]{3,}/.test(value.replace(/^(?:tel|phone|mob(?:ile)?|fax)\b/i, '')))
    return { ok: false, reason: 'it carries words rather than a number' };
  return { ok: true, reason: '' };
}
