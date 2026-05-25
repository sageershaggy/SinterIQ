#!/usr/bin/env node
/**
 * SinterIQ — duplicate-candidate audit.
 *
 * Scans every company in the database against the same normalization rules
 * the live import/create endpoints use (Phase 4). Prints groups of rows
 * that share a normalized name OR normalized website host.
 *
 * Usage:
 *   node scripts/audit_duplicates.mjs                                 # uses ./sintertechnik.db
 *   node scripts/audit_duplicates.mjs path/to/your.db                  # custom DB path
 *   node scripts/audit_duplicates.mjs --csv > duplicates_report.csv    # CSV output
 *
 * Output: groups where >1 row collapses to the same key, ordered by group size.
 * Does NOT modify the DB. Use the UI's merge tool to act on findings.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const csvMode = args.includes('--csv');
const positional = args.filter((a) => !a.startsWith('--'));
const dbPath = positional[0] || path.resolve(process.cwd(), 'sintertechnik.db');

// ------- normalization (mirrors server.ts) -------

function transliterateGerman(value) {
  return value
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'ae').replace(/Ö/g, 'oe').replace(/Ü/g, 'ue');
}

const IGNORED_TOKENS = new Set([
  'gmbh', 'mbh', 'mbh+co', 'kg', 'ag', 'ohg', 'gbr', 'eg', 'ek',
  'gesellschaft', 'gesellschaften',
  'co', 'company', 'companies', 'compagnie',
  'und', 'and', 'the',
  'llc', 'ltd', 'limited', 'inc', 'incorporated',
  'corp', 'corporation', 'plc', 'pte', 'pvt', 'private',
  'bv', 'nv', 'sarl', 'sa', 'srl', 'spa', 'oy', 'ab', 'as', 'aps',
  'holdings', 'holding', 'group', 'groupe', 'gruppe',
  'international', 'intl',
  'deutschland', 'germany', 'europe', 'europa',
]);

function normalizeCompanyName(name) {
  if (!name) return '';
  const transliterated = transliterateGerman(String(name).trim());
  const cleaned = transliterated.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).filter((t) => t && !IGNORED_TOKENS.has(t)).join(' ');
}

function normalizeWebsiteHost(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  try {
    const url = /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return trimmed.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
  }
}

// ------- main -------

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Cannot open DB at ${dbPath}: ${err.message}`);
  process.exit(1);
}

const rows = db.prepare(
  'SELECT id, company_name, website, country, city, lead_status, created_at FROM companies ORDER BY id'
).all();

if (!csvMode) {
  console.error(`Loaded ${rows.length} companies from ${dbPath}\n`);
}

const byName = new Map();
const byHost = new Map();

for (const row of rows) {
  const nKey = normalizeCompanyName(row.company_name);
  if (nKey) {
    if (!byName.has(nKey)) byName.set(nKey, []);
    byName.get(nKey).push(row);
  }
  const hKey = normalizeWebsiteHost(row.website);
  if (hKey) {
    if (!byHost.has(hKey)) byHost.set(hKey, []);
    byHost.get(hKey).push(row);
  }
}

const nameGroups = Array.from(byName.entries())
  .filter(([_, rs]) => rs.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

const hostGroups = Array.from(byHost.entries())
  .filter(([_, rs]) => rs.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

if (csvMode) {
  console.log('group_type,group_key,id,company_name,website,country,city,lead_status,created_at');
  for (const [key, group] of nameGroups) {
    for (const r of group) {
      const fields = ['name', key, r.id, r.company_name, r.website, r.country, r.city, r.lead_status, r.created_at];
      console.log(fields.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    }
  }
  for (const [key, group] of hostGroups) {
    for (const r of group) {
      const fields = ['website', key, r.id, r.company_name, r.website, r.country, r.city, r.lead_status, r.created_at];
      console.log(fields.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    }
  }
  process.exit(0);
}

function printGroup(label, key, rows) {
  console.log(`\n${label}: "${key}"  (${rows.length} rows)`);
  for (const r of rows) {
    const loc = [r.city, r.country].filter(Boolean).join(', ');
    console.log(`  id=${String(r.id).padEnd(4)} | ${r.company_name}${loc ? `  [${loc}]` : ''}  ${r.website ? `· ${r.website}` : ''}  ${r.lead_status ? `(${r.lead_status})` : ''}`);
  }
}

console.log('='.repeat(70));
console.log(`DUPLICATE CANDIDATES — same normalized NAME`);
console.log('='.repeat(70));
if (nameGroups.length === 0) {
  console.log('  (none)');
} else {
  for (const [key, group] of nameGroups) {
    printGroup('NAME', key, group);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`DUPLICATE CANDIDATES — same normalized WEBSITE`);
console.log('='.repeat(70));
if (hostGroups.length === 0) {
  console.log('  (none)');
} else {
  for (const [key, group] of hostGroups) {
    printGroup('SITE', key, group);
  }
}

const totalDupes = nameGroups.reduce((a, [, g]) => a + g.length - 1, 0)
                 + hostGroups.reduce((a, [, g]) => a + g.length - 1, 0);

console.log('\n' + '='.repeat(70));
console.log(`SUMMARY`);
console.log('='.repeat(70));
console.log(`  ${rows.length} companies scanned`);
console.log(`  ${nameGroups.length} name groups with duplicates`);
console.log(`  ${hostGroups.length} website groups with duplicates`);
console.log(`  ~${totalDupes} candidate duplicate rows to review (some overlap between name/site groups)`);
console.log(`\nNext steps:`);
console.log(`  • Open SinterIQ → Companies, search for each company_name above`);
console.log(`  • Use the merge tool to consolidate genuine duplicates`);
console.log(`  • For CSV output:  node scripts/audit_duplicates.mjs --csv > dupes.csv`);
