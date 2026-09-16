import { z } from 'zod';
import { fetchWebsite, type WebsitePage } from './network';
import type { AiConfig, Generate } from './ai';
import type { Lead, ResearchOutcome, ResearchableField } from '../shared/types';

/**
 * Filling in what a lead record is missing, from the company's own website.
 *
 * Two rules keep this from becoming a machine that invents customers:
 *
 * 1. A value survives only if the model cites a sentence that really appears in the page we
 *    fetched AND that sentence itself contains the value. Checking only the quote is not
 *    enough: the page text is in the prompt, so quoting it is free, and a model can pair an
 *    invented phone number with a real "Contact us today" and be believed.
 * 2. A website is never taken on the model's word. A proposed domain is fetched through the
 *    same public-network guard as any other site and kept only if the page names the company.
 *    There is no search provider here, so when nothing verifies we say so rather than guess.
 *
 * Anything refused is reported back, not dropped silently: "we looked and could not confirm"
 * is a research result, and hiding it would invite someone to re-run the same lead forever.
 */
export const researchableFields = [
  'website',
  'industry',
  'country',
  'city',
  'employee_count',
  'contact_name',
  'contact_role',
  'contact_email',
  'contact_phone',
] as const;

/** Fields whose value has a shape worth checking before it reaches the record. */
const shapes: Partial<Record<ResearchableField, RegExp>> = {
  contact_email: /^[^\s@<>,;]+@[a-z0-9.-]+\.[a-z]{2,}$/i,
  contact_phone: /^[+0-9][0-9\s().-]{5,30}$/,
  employee_count: /^[0-9][0-9\s,+-]{0,20}$|^[0-9]+\s*(-|to)\s*[0-9]+$/i,
};
const limits: Record<ResearchableField, number> = {
  website: 253,
  industry: 120,
  country: 80,
  city: 80,
  employee_count: 40,
  contact_name: 120,
  contact_role: 120,
  contact_email: 200,
  contact_phone: 40,
};

const candidateSchema = z
  .object({ domains: z.array(z.string().trim().max(253)).max(3).default([]) })
  .strict();
const extractionSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            field: z.string().max(40),
            value: z.string().trim().max(400),
            evidence: z.string().trim().max(800),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    notes: z.array(z.string().trim().max(300)).max(12).default([]),
  })
  .strict();

/** Fields whose value is published verbatim, so it must appear in the sentence citing it. */
const literalFields = new Set<ResearchableField>([
  'contact_email',
  'contact_phone',
  'contact_name',
  'city',
  'country',
  'employee_count',
]);
/** A number is only a headcount if the sentence is actually about people. */
const headcountWords = /(employee|employs|staff|people|workforce|headcount|team of)/i;
const digitsOf = (value: string) => value.replace(/[^0-9]/g, '');

/** Comparison form: punctuation and spacing differ between a quote and the page it came from. */
const flatten = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const legalSuffixes = new Set([
  'llc',
  'ltd',
  'limited',
  'inc',
  'gmbh',
  'bv',
  'nv',
  'sa',
  'srl',
  'spa',
  'ag',
  'kg',
  'oy',
  'ab',
  'as',
  'plc',
  'pte',
  'pvt',
  'est',
  'co',
  'company',
  'corp',
  'corporation',
  'group',
  'holding',
  'holdings',
  'trading',
  'general',
  'international',
  'services',
  'and',
  'the',
]);
/** The words in a company name that actually identify it. */
function identifyingWords(name: string) {
  return flatten(name)
    .split(' ')
    .filter((word) => word.length >= 4 && !legalSuffixes.has(word));
}
/**
 * Does the value follow from the sentence it was cited to?
 *
 * The quote being on the page says nothing about where the VALUE came from. A published
 * email, phone, city or headcount appears inside the sentence that mentions it, so that is
 * what gets checked. Industry and role are summaries, so most of their content words must
 * appear in the quote instead of the whole phrase.
 */
export function citationSupports(field: ResearchableField, value: string, quote: string) {
  if (literalFields.has(field)) {
    if (field === 'contact_phone') {
      const wanted = digitsOf(value);
      return wanted.length >= 6 && digitsOf(quote).includes(wanted);
    }
    if (field === 'employee_count')
      return headcountWords.test(quote) && flatten(quote).includes(flatten(value));
    return flatten(quote).includes(flatten(value));
  }
  const words = flatten(value)
    .split(' ')
    .filter((word) => word.length >= 4);
  if (!words.length) return flatten(quote).includes(flatten(value));
  const present = words.filter((word) => flatten(quote).includes(word));
  return present.length >= Math.ceil(words.length * 0.6);
}

/** Pages that prove only that a domain exists, never that it is this company. */
const notACompanySite =
  /(is for sale|buy this domain|domain (is )?(for sale|parked)|this domain may be for sale|hugedomains|sedo\.com|dan\.com|afternic|godaddy|domain broker|under construction|coming soon|website is being (built|updated)|parked (free )?(of charge|by))/i;
/**
 * The page that answered has to be the domain we guessed. Redirects are followed, so a
 * for-sale domain that lands on a broker's profile page would otherwise verify itself: the
 * broker page prints the very name we are looking for.
 */
export function sameSite(candidate: string, finalUrl: string) {
  try {
    const host = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, '');
    const guess = candidate.toLowerCase().replace(/^www\./, '');
    return host === guess || host.endsWith('.' + guess) || guess.endsWith('.' + host);
  } catch {
    return false;
  }
}

/**
 * Does this page belong to this company? Requires the name's identifying words to appear, not
 * merely a plausible-looking domain: a parked page or a namesake in another country would
 * otherwise become a "verified" website and poison every later qualification.
 */
export function pageNamesCompany(name: string, pageText: string) {
  const words = identifyingWords(name);
  const page = ' ' + flatten(pageText) + ' ';
  // Whole words only. Matching substrings let "maintenance" inside "maintenancefree" count,
  // and a compound logo spelling simply fails to verify, which is the safe direction to err.
  const hasWord = (word: string) =>
    page.includes(' ' + word + ' ') || page.includes(' ' + word + 's ');
  if (!words.length) {
    const flat = flatten(name);
    return flat.length > 3 && page.includes(' ' + flat + ' ');
  }
  const present = words.filter(hasWord);
  // One shared common word is not identification: "General Maintenance" and "Building
  // Materials" are real names in this data, and half of two words is one. A two-word name
  // must match both words; a longer one must match most of them.
  const needed = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  return present.length >= needed;
}

const discoverSystem = [
  'You propose candidate official website domains for a company so that the application can verify them by fetching each one.',
  'Return at most three bare hostnames, most likely first, with no scheme and no path.',
  'You never invent a domain to be helpful. If you have no real basis for a candidate, return an empty list:',
  'an empty answer is correct and useful, a guessed domain is a false record that someone will act on.',
].join(' ');

const extractSystem = [
  "You extract company facts from the text of that company's own website.",
  'Answer a requested field ONLY if the page text itself supports it, and quote the supporting sentence',
  'verbatim from the page in "evidence". Quote the page exactly; do not paraphrase, translate or tidy it.',
  'If the page does not support a field, omit that field and add a short note saying what was missing.',
  'Never guess, never infer a fact from the domain name, and never use knowledge from outside this page.',
  'Personal contact details may be returned only where the page itself publishes them for business contact.',
].join(' ');

export async function researchMissing(options: {
  lead: Lead;
  config: AiConfig;
  generate: Generate;
  fetchPage?: (url: string) => Promise<WebsitePage>;
}): Promise<ResearchOutcome> {
  const { lead, config, generate } = options;
  const fetchPage = options.fetchPage || fetchWebsite;
  const missing = researchableFields.filter(
    (field) => !String(lead[field] ?? '').trim(),
  ) as ResearchableField[];
  const outcome: ResearchOutcome = {
    website: lead.website,
    discovered: false,
    tried: [],
    proposals: [],
    refused: [],
    notes: [],
  };
  if (!missing.length) {
    outcome.notes.push('This lead already has every researchable field filled in.');
    return outcome;
  }

  let page: WebsitePage | null = null;
  if (lead.website) {
    try {
      page = await fetchPage(lead.website);
    } catch (error) {
      outcome.notes.push(
        'The saved website could not be read: ' +
          (error instanceof Error ? error.message : 'the request failed') +
          '.',
      );
    }
  } else {
    const proposed = candidateSchema.safeParse(
      await generate(config, discoverSystem, {
        company: lead.name,
        country: lead.country,
        city: lead.city,
        industry: lead.industry,
        notes: lead.notes.slice(0, 2000),
      }),
    );
    const offered = proposed.success
      ? proposed.data.domains.map((domain) =>
          domain
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, ''),
        )
      : [];
    const domains = offered.filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)).slice(0, 3);
    // Say what was thrown away, so "none proposed" never hides a malformed suggestion.
    for (const domain of offered.filter((candidate) => !domains.includes(candidate)))
      outcome.notes.push('A proposed address was not a usable hostname and was ignored.');
    if (!domains.length)
      outcome.notes.push(
        'No candidate website could be proposed for this company name, so nothing could be verified.',
      );
    for (const domain of domains) {
      outcome.tried.push(domain);
      try {
        const candidate = await fetchPage('https://' + domain);
        if (!sameSite(domain, candidate.url)) {
          outcome.notes.push(
            domain + " redirected somewhere else, so it is not this company's own site.",
          );
          continue;
        }
        if (notACompanySite.test(candidate.content.slice(0, 4000))) {
          outcome.notes.push(
            domain + ' is a parked, for-sale or placeholder page rather than a company website.',
          );
          continue;
        }
        if (candidate.url.length > limits.website) {
          outcome.notes.push(domain + ' resolved to an address too long to store.');
          continue;
        }
        if (!pageNamesCompany(lead.name, candidate.content)) {
          outcome.notes.push(domain + ' was reachable but its page does not name this company.');
          continue;
        }
        page = candidate;
        outcome.website = candidate.url;
        outcome.discovered = true;
        break;
      } catch {
        // A candidate that cannot be fetched is simply not evidence of anything.
        outcome.notes.push(domain + ' could not be read.');
      }
    }
  }
  if (!page) {
    if (!outcome.notes.length)
      outcome.notes.push('No readable website was found, so there was nothing to research from.');
    return outcome;
  }

  const wanted: ResearchableField[] = missing.filter((field) => field !== 'website');
  if (wanted.length) {
    const extracted = extractionSchema.safeParse(
      await generate(config, extractSystem, {
        company: lead.name,
        page_url: page.url,
        requested_fields: wanted,
        page_text: page.content,
      }),
    );
    if (!extracted.success) outcome.notes.push('The extraction result could not be read.');
    else {
      for (const candidate of extracted.data.fields) {
        const field = candidate.field as ResearchableField;
        if (!wanted.includes(field)) continue;
        if (outcome.proposals.some((proposal) => proposal.field === field)) continue;
        const value = candidate.value.replace(/\s+/g, ' ').trim();
        if (!value) continue;
        if (value.length > limits[field]) {
          outcome.refused.push({
            field,
            value,
            reason: 'The value was longer than the field allows.',
          });
          continue;
        }
        const shape = shapes[field];
        if (shape && !shape.test(value)) {
          outcome.refused.push({
            field,
            value,
            reason: 'The value is not shaped like a ' + field.replace('_', ' ') + '.',
          });
          continue;
        }
        // Two checks, not one: the sentence has to be on the page, and the value has to be in
        // the sentence. Either alone is satisfied for free by a model holding the page text.
        const quote = flatten(candidate.evidence);
        if (quote.length < 12 || !flatten(page.content).includes(quote)) {
          outcome.refused.push({
            field,
            value,
            reason: 'No supporting sentence from the page was provided, so it was not recorded.',
          });
          continue;
        }
        if (!citationSupports(field, value, candidate.evidence)) {
          outcome.refused.push({
            field,
            value,
            reason:
              'The quoted sentence does not contain this value, so it was not recorded. ' +
              'Only a detail the page itself states is saved.',
          });
          continue;
        }
        outcome.proposals.push({
          field,
          value,
          evidence: candidate.evidence.slice(0, 400),
          source_url: page.url,
        });
      }
      // Attributed, because these come from the model rather than from a check we ran: an
      // unsupported claim must not sit in the report looking like a verified finding.
      outcome.notes.push(
        ...extracted.data.notes.map((note) => 'Reported while reading the page: ' + note),
      );
    }
  }
  if (outcome.discovered)
    outcome.proposals.unshift({
      field: 'website',
      value: outcome.website,
      // Not a quotation from the page: this is the check that was run. The UI must not
      // present it as a sentence the company wrote.
      evidence: '',
      source_url: outcome.website,
    });
  return outcome;
}
