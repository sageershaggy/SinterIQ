import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';
import { QUALIFY_SYSTEM_PROMPT, buildQualifyUserPrompt } from './aiPrompts';

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(process.cwd(), '.env.local'));
loadEnvFile(path.join(process.cwd(), '.env'));

// =========================================================================
// Secret encryption — AES-256-GCM at rest for LLM API keys
// =========================================================================
// Master key precedence:
//   1. SINTERIQ_ENCRYPTION_KEY env var (32-byte base64 or 64-char hex)
//   2. Auto-generated key persisted to .sinteriq-encryption-key (gitignored)
// Both modes log a warning if the key is freshly generated.

const ENC_KEY_FILE = path.join(process.cwd(), '.sinteriq-encryption-key');
const ENC_PREFIX = 'enc:v1:';

function loadOrGenerateMasterKey(): Buffer {
  const fromEnv = process.env.SINTERIQ_ENCRYPTION_KEY;
  if (fromEnv) {
    if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) return Buffer.from(fromEnv, 'hex');
    try {
      const decoded = Buffer.from(fromEnv, 'base64');
      if (decoded.length === 32) return decoded;
    } catch {}
    console.warn('SINTERIQ_ENCRYPTION_KEY is set but not a valid 32-byte hex/base64 string — falling back to file-stored key');
  }

  if (fs.existsSync(ENC_KEY_FILE)) {
    try {
      const stored = fs.readFileSync(ENC_KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(stored)) return Buffer.from(stored, 'hex');
    } catch (err) {
      console.error('Failed to read encryption key file:', err);
    }
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(ENC_KEY_FILE, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    console.warn(`[security] Generated new encryption key at ${ENC_KEY_FILE}. Back this up — losing it makes stored API keys unrecoverable.`);
  } catch (err) {
    console.error('Could not persist generated encryption key:', err);
  }
  return generated;
}

const MASTER_KEY = loadOrGenerateMasterKey();

function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  try {
    const blob = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    const iv = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('Failed to decrypt secret (corrupted ciphertext or wrong key):', err instanceof Error ? err.message : err);
    return '';
  }
}

function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Tunable behaviour constants (hoisted from scattered literals).
const AI_REQUALIFY_GUARD_DAYS = 7;          // skip re-qualifying a lead within this window unless force=true
const PREFILTER_CONFIDENCE_THRESHOLD = 75;  // min confidence for the cheap pre-classifier to short-circuit
const BULK_OPERATION_LIMIT = 5000;          // max ids accepted by a single bulk endpoint call

app.use(express.json({ limit: '25mb' }));

// Baseline security headers on every response.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// =========================================================================
// Session authentication — HMAC-signed httpOnly cookie
// =========================================================================
// All /api/* routes except /api/health and /api/auth/* require a valid
// session cookie. The cookie payload is base64url-encoded JSON with an
// HMAC-SHA256 signature appended. Secret is loaded from SINTERIQ_AUTH_SECRET
// env var, or auto-generated and persisted to .sinteriq-auth-secret
// (gitignored, mode 0600). Lose the secret → every active session is
// invalidated, but stored data is unaffected.
//
// Escape hatch: set SINTERIQ_AUTH_DISABLED=true to bypass auth during
// development or if you get locked out. NEVER set in production.

const AUTH_SECRET_FILE = path.join(process.cwd(), '.sinteriq-auth-secret');
const SESSION_COOKIE = 'sinteriq_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function loadOrGenerateAuthSecret(): Buffer {
  const fromEnv = process.env.SINTERIQ_AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, 'utf8');
  if (fs.existsSync(AUTH_SECRET_FILE)) {
    try {
      const stored = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
      if (stored.length >= 32) return Buffer.from(stored, 'hex');
    } catch {}
  }
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(AUTH_SECRET_FILE, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    console.warn(`[security] Generated new auth secret at ${AUTH_SECRET_FILE}. Back this up — losing it logs everyone out.`);
  } catch (err) {
    console.error('Could not persist auth secret:', err);
  }
  return generated;
}

const AUTH_SECRET = loadOrGenerateAuthSecret();
const AUTH_DISABLED = process.env.SINTERIQ_AUTH_DISABLED === 'true';
if (AUTH_DISABLED) {
  console.warn('[security] SINTERIQ_AUTH_DISABLED=true — API authentication is OFF. Do not use in production.');
}

// Default team accounts. Passwords match the previous client-side scheme
// (firstname@135) to keep the existing UX. Override per-user via env vars
// like SINTERIQ_PASSWORD_SAGEER=mynewpass for production.
const SESSION_USERS: Array<{ name: string; firstName: string; role: string }> = [
  { name: 'Sageer A. Shaikh', firstName: 'sageer', role: 'Lead Research & Qualification' },
  { name: 'Ahmad Khan', firstName: 'ahmad', role: 'Sales Representative' },
  { name: 'Dr. Jochen Langguth', firstName: 'jochen', role: 'Managing Director' },
  { name: 'Dr. Juergen Schellenberger', firstName: 'juergen', role: 'Technical Director' },
  { name: 'Christoph Langguth', firstName: 'christoph', role: 'Business Development' },
  { name: 'Patton Lucas', firstName: 'patton', role: 'Sales Manager' },
  { name: 'Dr. Kathrin Langguth', firstName: 'kathrin', role: 'Operations' },
];

function getUserPassword(firstName: string): string {
  const envKey = `SINTERIQ_PASSWORD_${firstName.toUpperCase()}`;
  return process.env[envKey] || `${firstName}@135`;
}

// In production, warn loudly (rather than hard-exit, so nobody gets locked out)
// when accounts still rely on the predictable '<firstname>@135' default scheme.
if (process.env.NODE_ENV === 'production') {
  const usingDefaults = SESSION_USERS.filter((u) => !process.env[`SINTERIQ_PASSWORD_${u.firstName.toUpperCase()}`]);
  if (usingDefaults.length > 0) {
    console.warn(`[security] ${usingDefaults.length} user(s) still use the default '<firstname>@135' password in production. Set SINTERIQ_PASSWORD_<FIRSTNAME> env vars for: ${usingDefaults.map((u) => u.firstName).join(', ')}`);
  }
}

function signSessionToken(payload: { name: string; role: string; issuedAt: number }): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token: string | undefined): { name: string; role: string; issuedAt: number } | null {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx === token.length - 1) return null;
  const data = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  // Constant-time compare.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof parsed.name !== 'string' || typeof parsed.issuedAt !== 'number') return null;
    if (Date.now() - parsed.issuedAt > SESSION_TTL_MS) return null;
    return { name: parsed.name, role: parsed.role || '', issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSessionFromRequest(req: any): { name: string; role: string; issuedAt: number } | null {
  const cookies = parseCookieHeader(req.headers?.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

function setSessionCookie(res: any, token: string) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

function clearSessionCookie(res: any) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// --- Authorization (role) helpers ---------------------------------------
// Admin = the same predicate the UI uses to gate the Commissions tab. Kept in
// one place so it can be swapped for an explicit role flag later.
function isAdminUser(req: any): boolean {
  if (AUTH_DISABLED) return true;
  const name = String((req as any).session?.name || '').toLowerCase();
  return name.includes('sageer') || name.includes('admin');
}

function requireAdmin(req: any, res: any, next: any) {
  if (isAdminUser(req)) return next();
  return res.status(403).json({ error: 'Admin access required for this resource' });
}

// --- Rate limiting ------------------------------------------------------
// Lightweight in-memory fixed-window limiter (no external dependency). Keyed by
// session user when available, else client IP. Sufficient for a single-node
// internal tool; swap for a shared store if this ever scales horizontally.
function createRateLimiter(opts: { windowMs: number; max: number; keyPrefix: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: any, res: any, next: any) => {
    const id = String((req as any).session?.name || req.ip || req.socket?.remoteAddress || 'anon');
    const key = `${opts.keyPrefix}:${id}`;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many requests — slow down and retry in ${retryAfter}s.` });
    }
    next();
  };
}

const loginRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'login' });
const llmRateLimiter = createRateLimiter({ windowMs: 60_000, max: 40, keyPrefix: 'llm' });

// Auth middleware. Mounted before all /api/* routes. Allows /api/health and
// /api/auth/* without a session; rejects everything else with 401.
app.use('/api', (req, res, next) => {
  if (AUTH_DISABLED) return next();
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  (req as any).session = session;
  next();
});

app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  try {
    const username = normalizeOptionalString(req.body?.username)?.toLowerCase() || '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const user = SESSION_USERS.find((u) =>
      u.firstName === username || u.name.toLowerCase() === username,
    );
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const expected = getUserPassword(user.firstName);
    // Constant-time compare to avoid timing oracles.
    const pwdBuf = Buffer.from(password, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    const ok = pwdBuf.length === expBuf.length && crypto.timingSafeEqual(pwdBuf, expBuf);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signSessionToken({ name: user.name, role: user.role, issuedAt: Date.now() });
    setSessionCookie(res, token);
    res.json({ user: { name: user.name, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (AUTH_DISABLED) {
    return res.json({ user: { name: 'Dev (auth disabled)', role: 'Developer' }, authDisabled: true });
  }
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: { name: session.name, role: session.role } });
});

// Initialize SQLite database
const db = new Database('sintertechnik.db');

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}

function normalizeRequiredString(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsedValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function normalizeTechnicalFit(value: unknown) {
  const normalizedValue = normalizeOptionalString(value);
  return normalizedValue && normalizedValue !== 'UNASSESSED' ? normalizedValue : null;
}

function normalizeBooleanFlag(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalizedValue = normalizeOptionalString(value)?.toLowerCase();
  return normalizedValue === 'true' || normalizedValue === '1' || normalizedValue === 'yes';
}

function normalizeComparableValue(value: unknown) {
  return normalizeOptionalString(value)?.toLowerCase() || '';
}

function normalizeTrackingLevel(value: unknown) {
  const normalizedValue = normalizeOptionalString(value);
  return normalizedValue || 'WATCHLIST';
}

function normalizeTrackingStatus(value: unknown) {
  const normalizedValue = normalizeOptionalString(value);
  return normalizedValue || 'PENDING';
}

function formatExportDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const trimmedValue = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const parsedValue = new Date(trimmedValue);
  if (Number.isNaN(parsedValue.getTime())) {
    return trimmedValue;
  }

  return parsedValue.toISOString().slice(0, 10);
}

function formatExportDateTime(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const trimmedValue = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const parsedValue = new Date(trimmedValue);
  if (Number.isNaN(parsedValue.getTime())) {
    return trimmedValue;
  }

  return parsedValue.toISOString().slice(0, 16).replace('T', ' ');
}

function normalizeWebsiteHost(value: unknown) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return '';
  }

  try {
    const url = normalizedValue.match(/^https?:\/\//i) ? new URL(normalizedValue) : new URL(`https://${normalizedValue}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return normalizedValue
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
  }
}

function transliterateGerman(value: string) {
  return value
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'ae')
    .replace(/Ö/g, 'oe')
    .replace(/Ü/g, 'ue');
}

function transliterateGermanForMatch(value: string) {
  return transliterateGerman(value)
    .replace(/ß/g, 'ss')
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue');
}

function normalizeCompanyNameForMatch(value: unknown) {
  const transliterated = transliterateGermanForMatch(normalizeRequiredString(value));
  const normalizedValue = transliterated
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalizedValue) {
    return '';
  }

  const ignoredTokens = new Set([
    // German legal forms
    'gmbh', 'mbh', 'mbh+co', 'kg', 'ag', 'ohg', 'gbr', 'eg', 'ek',
    'gesellschaft', 'gesellschaften',
    'co', 'company', 'companies', 'compagnie',
    'und', 'and', 'the',
    // English / international
    'llc', 'ltd', 'limited', 'inc', 'incorporated',
    'corp', 'corporation', 'plc', 'pte', 'pvt', 'private',
    'bv', 'nv', 'sarl', 'sa', 'srl', 'spa', 'oy', 'ab', 'as', 'aps',
    'holdings', 'holding', 'group', 'groupe', 'gruppe',
    'international', 'intl',
    'deutschland', 'germany', 'europe', 'europa',
  ]);

  return normalizedValue
    .split(/\s+/)
    .filter((token) => token && !ignoredTokens.has(token))
    .join(' ');
}

// Levenshtein distance — fuzzy matching for concatenated-word variants
// that exact normalization can't catch (e.g. "Acme Test Dedup" vs "ACME-TestDedup").
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Bail out cheaply when lengths differ wildly (no chance of similarity ≥ threshold)
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.4) {
    return Math.max(a.length, b.length);
  }
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Threshold: 0.85 catches "acmetestdedup" vs "acme test dedup" (~0.92)
// but rejects unrelated short names like "acme" vs "abme" (~0.75).
// Names below 8 chars use a stricter threshold to avoid false positives.
const FUZZY_THRESHOLD_LONG = 0.85;
const FUZZY_THRESHOLD_SHORT = 0.92;

function findExistingCompanyByMatch(name: unknown, website: unknown, excludeId?: number) {
  // Phase 6: prefer indexed lookup on the stored name_key / website_key when available;
  // fall back to in-memory scan if the columns don't exist yet.
  const normalizedWebsiteHost = normalizeWebsiteHost(website);
  const normalizedName = normalizeCompanyNameForMatch(name);

  if (normalizedWebsiteHost) {
    const exclude = excludeId === undefined ? -1 : excludeId;
    const websiteMatch = db.prepare(
      'SELECT id, company_name FROM companies WHERE website_key = ? AND id != ? LIMIT 1'
    ).get(normalizedWebsiteHost, exclude) as { id: number; company_name: string } | undefined;
    if (websiteMatch) {
      return { id: websiteMatch.id, company_name: websiteMatch.company_name, matchedBy: 'website' as const };
    }
  }

  if (!normalizedName) return null;

  const exclude = excludeId === undefined ? -1 : excludeId;
  const nameMatch = db.prepare(
    'SELECT id, company_name FROM companies WHERE company_name_key = ? AND id != ? LIMIT 1'
  ).get(normalizedName, exclude) as { id: number; company_name: string } | undefined;
  if (nameMatch) {
    return { id: nameMatch.id, company_name: nameMatch.company_name, matchedBy: 'name' as const };
  }

  // Fuzzy fallback — Levenshtein against all candidates with a similar length.
  // Catches concatenated-word variants the tokenizer can't split (e.g. "ACMETestCo"
  // vs "Acme Test Co"), and trailing-suffix variants ("...co" vs no-suffix).
  const candidates = db.prepare(
    'SELECT id, company_name, company_name_key FROM companies WHERE company_name_key IS NOT NULL AND id != ?'
  ).all(exclude) as Array<{ id: number; company_name: string; company_name_key: string }>;

  const threshold = normalizedName.length < 8 ? FUZZY_THRESHOLD_SHORT : FUZZY_THRESHOLD_LONG;

  // Build a few variants of the input for fuzzy comparison:
  //   - spaced normalized form
  //   - compacted (no spaces)
  //   - compacted with trailing legal-suffix substring removed
  const compactInput = normalizedName.replace(/\s+/g, '');
  const COMPACT_TRAILING_SUFFIXES = ['gmbh', 'mbh', 'ag', 'kg', 'co', 'ltd', 'inc', 'llc'];
  const compactInputStripped = COMPACT_TRAILING_SUFFIXES.reduce((acc, suf) => {
    if (acc.endsWith(suf) && acc.length > suf.length + 2) return acc.slice(0, -suf.length);
    return acc;
  }, compactInput);

  let bestMatch: { id: number; company_name: string; similarity: number } | null = null;

  for (const c of candidates) {
    if (!c.company_name_key) continue;
    const compactCandidate = c.company_name_key.replace(/\s+/g, '');
    const compactCandidateStripped = COMPACT_TRAILING_SUFFIXES.reduce((acc, suf) => {
      if (acc.endsWith(suf) && acc.length > suf.length + 2) return acc.slice(0, -suf.length);
      return acc;
    }, compactCandidate);

    const sim = Math.max(
      nameSimilarity(normalizedName, c.company_name_key),
      nameSimilarity(compactInput, compactCandidate),
      nameSimilarity(compactInputStripped, compactCandidateStripped),
      nameSimilarity(compactInputStripped, compactCandidate),
      nameSimilarity(compactInput, compactCandidateStripped),
    );
    if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { id: c.id, company_name: c.company_name, similarity: sim };
    }
  }

  if (bestMatch) {
    return { id: bestMatch.id, company_name: bestMatch.company_name, matchedBy: 'fuzzy_name' as const };
  }

  return null;
}

function sendApiError(res: any, error: unknown, fallbackMessage: string) {
  const rawMessage = error instanceof Error ? error.message : '';
  // Always log the full error (incl. stack) server-side for debugging.
  console.error(`[api-error] ${fallbackMessage}:`, error instanceof Error ? error.stack || error.message : error);

  if (rawMessage.includes('LLM_API_KEY') || rawMessage.includes('GEMINI_API_KEY')) {
    return res.status(503).json({ error: rawMessage.slice(0, 300) });
  }

  // Surface a concise message but never a stack trace or oversized internal dump.
  const safeMessage = rawMessage && rawMessage.length <= 200 ? rawMessage : fallbackMessage;
  return res.status(500).json({ error: safeMessage });
}

// Extract the calling user's identity from the request.
// Order of trust:
//   1. Verified session cookie (set by /api/auth/login, signed with HMAC).
//   2. X-User-Name header — kept for backward compat / dev (auth disabled).
//   3. Body 'by' field — legacy fallback.
function getRequestUser(req: any): string {
  const session = (req as any).session;
  if (session?.name && typeof session.name === 'string') {
    return session.name.slice(0, 120);
  }
  const headerName = req.headers?.['x-user-name'];
  if (typeof headerName === 'string' && headerName.trim()) {
    return headerName.trim().slice(0, 120);
  }
  const bodyBy = req.body?.by;
  if (typeof bodyBy === 'string' && bodyBy.trim()) {
    return bodyBy.trim().slice(0, 120);
  }
  return 'System';
}

const DEFAULT_USERS = [
  'Dr. Jochen Langguth',
  'Dr. Juergen Schellenberger',
  'Ahmad Khan',
  'Sageer A. Shaikh',
  'Christoph Langguth',
  'Patton Lucas',
  'Dr. Kathrin Langguth',
];

type LlmProviderType = 'gemini' | 'openai_compatible';

interface LlmSettings {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  providerName: string;
  providerType: LlmProviderType;
  source: 'database' | 'environment' | 'default';
  supportsWebSearch: boolean;
}

function getSettingValue(settingKey: string) {
  const row = db
    .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
    .get(settingKey) as { setting_value: string } | undefined;

  return row?.setting_value ?? null;
}

function saveSettings(settingEntries: Record<string, string | null>) {
  const upsertSetting = db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const saveAllSettings = db.transaction(() => {
    for (const [settingKey, settingValue] of Object.entries(settingEntries)) {
      upsertSetting.run(settingKey, settingValue ?? '');
    }
  });

  saveAllSettings();
}

function getLlmSettings(): LlmSettings {
  const storedProviderType = normalizeOptionalString(getSettingValue('llm.provider_type'));
  const storedProviderName = normalizeOptionalString(getSettingValue('llm.provider_name'));
  const storedModel = normalizeOptionalString(getSettingValue('llm.model'));
  const storedApiKeyRaw = normalizeOptionalString(getSettingValue('llm.api_key'));
  const storedApiKey = storedApiKeyRaw ? decryptSecret(storedApiKeyRaw) : null;
  const storedBaseUrl = normalizeOptionalString(getSettingValue('llm.base_url'));

  if (storedProviderType === 'openai_compatible' || storedProviderType === 'gemini') {
    const fallbackApiKey = storedProviderType === 'gemini'
      ? normalizeOptionalString(process.env.GEMINI_API_KEY)
      : normalizeOptionalString(process.env.LLM_API_KEY) || normalizeOptionalString(process.env.OPENAI_API_KEY);

    return {
      providerType: storedProviderType,
      providerName: storedProviderName || (storedProviderType === 'gemini' ? 'Gemini' : 'OpenAI-Compatible'),
      model: storedModel || (storedProviderType === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini'),
      apiKey: storedApiKey || fallbackApiKey,
      baseUrl: storedProviderType === 'openai_compatible' ? storedBaseUrl || 'https://api.openai.com/v1' : null,
      source: storedApiKey ? 'database' : fallbackApiKey ? 'environment' : 'database',
      supportsWebSearch: storedProviderType === 'gemini',
    };
  }

  if (process.env.GEMINI_API_KEY) {
    return {
      providerType: 'gemini',
      providerName: 'Gemini',
      model: normalizeOptionalString(process.env.GEMINI_MODEL) || 'gemini-2.5-flash',
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: null,
      source: 'environment',
      supportsWebSearch: true,
    };
  }

  if (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY) {
    return {
      providerType: 'openai_compatible',
      providerName: normalizeOptionalString(process.env.LLM_PROVIDER_NAME) || 'OpenAI-Compatible',
      model: normalizeOptionalString(process.env.LLM_MODEL) || 'gpt-4.1-mini',
      apiKey: normalizeOptionalString(process.env.LLM_API_KEY) || normalizeOptionalString(process.env.OPENAI_API_KEY),
      baseUrl: normalizeOptionalString(process.env.LLM_BASE_URL) || 'https://api.openai.com/v1',
      source: 'environment',
      supportsWebSearch: false,
    };
  }

  return {
    providerType: 'gemini',
    providerName: 'Gemini',
    model: 'gemini-2.5-flash',
    apiKey: null,
    baseUrl: null,
    source: 'default',
    supportsWebSearch: true,
  };
}

function ensureLlmConfigured(settings: LlmSettings) {
  if (!settings.apiKey) {
    throw new Error(`LLM_API_KEY is not configured for ${settings.providerName}. Add it in Settings or .env.local and restart the app.`);
  }
}

function stripHtmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsiteUrl(value: unknown) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return null;
  }

  try {
    return normalizedValue.match(/^https?:\/\//i) ? normalizedValue : `https://${normalizedValue}`;
  } catch {
    return null;
  }
}

// --- SSRF protection ----------------------------------------------------
// Block fetches that resolve to private, loopback, link-local (incl. cloud
// metadata 169.254.169.254), CGNAT, or unique-local addresses. Resolving the
// hostname before fetching also mitigates DNS-rebinding.
function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (family === 6) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
  }
  return false;
}

async function isUrlSafeToFetch(rawUrl: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !isPrivateOrReservedIp(host);
  try {
    const records = await dns.lookup(host, { all: true });
    return records.length > 0 && records.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false;
  }
}

async function fetchPageText(url: string, timeoutMs = 5000) {
  try {
    if (!(await isUrlSafeToFetch(url))) {
      console.warn('[ssrf] Blocked fetch to non-public URL:', url);
      return null;
    }
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SinterIQ/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const text = stripHtmlToText(html);
    return text && text.length > 80 ? text : null;
  } catch {
    return null;
  }
}

// In-memory LRU cache for fetched website context. Saves repeated HTML fetches
// when the same site is qualified back-to-back (e.g. bulk import of related
// companies, or pre-classifier + deep pass within the same AI-qualify call).
// Bounded at 500 entries with a 6h TTL — well within memory budget and stale
// enough to be safe for any site whose copy actually changes during the day.
const WEBSITE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WEBSITE_CACHE_MAX = 500;
const websiteContextCache = new Map<string, { value: string; expiresAt: number }>();

// Guards against two concurrent AI-qualify calls doing duplicate expensive work
// on the same company (the 7-day guard alone is a TOCTOU race under concurrency).
const aiQualifyInProgress = new Set<string>();

function buildWebsiteCacheKey(host: string, paths: string[], perPageCap: number, totalCap: number) {
  return `${host}|${paths.join(',')}|${perPageCap}|${totalCap}`;
}

async function fetchWebsiteContext(value: unknown, opts?: { paths?: string[]; perPageCap?: number; totalCap?: number }) {
  const websiteUrl = normalizeWebsiteUrl(value);
  if (!websiteUrl) {
    return null;
  }

  const base = websiteUrl.replace(/\/+$/, '');
  const paths = opts?.paths ?? ['', '/about', '/products', '/ueber-uns'];
  const perPageCap = opts?.perPageCap ?? 1500;
  const totalCap = opts?.totalCap ?? 3000;

  const host = normalizeWebsiteHost(value);
  const cacheKey = host ? buildWebsiteCacheKey(host, paths, perPageCap, totalCap) : '';
  if (cacheKey) {
    const cached = websiteContextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // LRU touch — re-insert at end.
      websiteContextCache.delete(cacheKey);
      websiteContextCache.set(cacheKey, cached);
      return cached.value;
    }
    if (cached) websiteContextCache.delete(cacheKey);
  }

  const pages = await Promise.all(paths.map((p) => fetchPageText(`${base}${p}`)));

  const seenFingerprints = new Set<string>();
  const uniqueTexts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i];
    if (!text) continue;
    const fingerprint = text.slice(0, 200).toLowerCase().replace(/\s+/g, ' ');
    if (seenFingerprints.has(fingerprint)) continue;
    seenFingerprints.add(fingerprint);
    const label = i === 0 ? 'HOMEPAGE' : `PAGE ${paths[i]}`;
    uniqueTexts.push(`[${label}]\n${text.slice(0, perPageCap)}`);
  }

  const combined = uniqueTexts.join('\n\n---\n\n').slice(0, totalCap);
  const result = combined || null;

  if (result && cacheKey) {
    if (websiteContextCache.size >= WEBSITE_CACHE_MAX) {
      const oldestKey = websiteContextCache.keys().next().value;
      if (oldestKey) websiteContextCache.delete(oldestKey);
    }
    websiteContextCache.set(cacheKey, { value: result, expiresAt: Date.now() + WEBSITE_CACHE_TTL_MS });
  }

  return result;
}

// Cheap pre-classification pass — short prompt, low temperature, no web search.
// Used to skip the expensive deep qualification for obvious NOT_A_TARGETs.
async function preClassifyLead(company: { company_name: string; website?: string | null; industry?: string | null; company_type?: string | null; country?: string | null }, websiteSnippet?: string | null) {
  const snippet = websiteSnippet ? websiteSnippet.slice(0, 800) : '';
  const userPrompt = `Classify this B2B lead for Sintertechnik (Germany, precision ceramic & hybrid bearings manufacturer).

Company: ${company.company_name}
Country: ${company.country || 'Unknown'}
Industry: ${company.industry || 'Unknown'}
Type: ${company.company_type || 'Unknown'}
Website: ${company.website || 'none'}
${snippet ? `Website snippet:\n${snippet}\n` : ''}

Sintertechnik sells precision rolling bearings to OEMs that USE bearings in machinery (pumps, food/pharma/chemical/cryogenic equipment, etc.). They do NOT sell to:
- Other bearing manufacturers (competitors)
- Pure wholesalers / mail-order / authorized dealers / trade-only firms
- Utility operators / software-only firms
- Pure service / MRO / site-operator businesses
- Vertriebs-GmbH / regional sales branches of foreign parents
- EPC contractors / pure system integrators
- Tiny craft producers / micro end-users

Return strict JSON: {"verdict": <"LIKELY_TARGET"|"UNCERTAIN"|"LIKELY_NOT_TARGET">, "category": <"COMPETITOR"|"WHOLESALER_TRADER"|"UTILITY_OR_SOFTWARE"|"SERVICE_MRO"|"GLOBAL_ENTERPRISE"|"SALES_BRANCH"|"EPC_INTEGRATOR"|"SMALL_END_USER"|"LOW_FIT"|null>, "confidence": <0-100>, "reason": "<one short sentence>"}

Only mark LIKELY_NOT_TARGET if confidence >= 75 and the evidence is clear. When in doubt: UNCERTAIN.`;

  try {
    const raw = await generateJsonWithLlm({
      systemPrompt: 'You are a fast B2B lead pre-classifier. Return strict JSON only — no markdown, no code fences.',
      userPrompt,
      useWebSearch: false,
      timeoutMs: 30000,
    });
    return parseJsonResponse<{
      verdict?: string;
      category?: string;
      confidence?: number;
      reason?: string;
    }>(raw, {});
  } catch (err) {
    console.warn('Pre-classify failed, falling through to deep qualify:', err instanceof Error ? err.message : err);
    return null;
  }
}

function localPreClassifyLead(company: { company_name: string; industry?: string | null; company_type?: string | null }) {
  const text = [
    company.company_name,
    company.industry || '',
    company.company_type || '',
  ].join(' ').toLowerCase();
  const compact = text.replace(/[\s._-]+/g, ' ');
  const isManufacturerLike = /\b(manufacturer|manufacturing|producer|produktion|oem)\b/i.test(compact);

  const checks: Array<{ category: string; confidence: number; pattern: RegExp; reason: string; skipIfManufacturer?: boolean }> = [
    {
      category: 'COMPETITOR',
      confidence: 90,
      pattern: /\b(kugellagerfabrik|waelzlagertechnik|wälzlagertechnik|bearing manufacturer|precision bearings)\b/i,
      reason: 'Name strongly indicates an in-house bearing manufacturer or bearing factory.',
    },
    {
      category: 'SALES_BRANCH',
      confidence: 84,
      pattern: /\b(vertriebs\s*gmbh|vertriebsgesellschaft|sales office|sales branch)\b/i,
      reason: 'Name indicates a sales or distribution branch with no local design authority.',
    },
    {
      category: 'WHOLESALER_TRADER',
      confidence: 82,
      pattern: /\b(großhandel|grosshandel|versandhandel|handelsgesellschaft|mail order|wholesale|retail)\b/i,
      reason: 'Name or type indicates a pure wholesaler, retailer, or mail-order trader.',
      skipIfManufacturer: true,
    },
    {
      category: 'SERVICE_MRO',
      confidence: 80,
      pattern: /\b(dienstleistungen|services\s*gmbh|service\s*gmbh|logistik|mro|repair shop)\b/i,
      reason: 'Name or type indicates a service, logistics, or MRO-only business.',
      skipIfManufacturer: true,
    },
    {
      category: 'EPC_INTEGRATOR',
      confidence: 80,
      pattern: /\b(epc|systemintegrator|system integrator|projektentwickler|gebäudetechnik|gebaeudetechnik|installation|installer)\b/i,
      reason: 'Name or type indicates an EPC, system integrator, or installer using third-party components.',
      skipIfManufacturer: true,
    },
  ];

  for (const check of checks) {
    if (check.skipIfManufacturer && isManufacturerLike) continue;
    if (check.pattern.test(compact)) {
      return {
        verdict: 'LIKELY_NOT_TARGET',
        category: check.category,
        confidence: check.confidence,
        reason: check.reason,
      };
    }
  }

  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function runLlmCallOnce(
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  useWebSearch: boolean,
  timeoutMs: number,
): Promise<string> {
  if (settings.providerType === 'gemini') {
    const ai = new GoogleGenAI({ apiKey: settings.apiKey! });
    const usingWebSearch = useWebSearch && settings.supportsWebSearch;
    const response = await withTimeout(
      ai.models.generateContent({
        model: settings.model,
        contents: `${systemPrompt}\n\n${userPrompt}${usingWebSearch ? '\n\nIMPORTANT: Your entire response must be valid JSON only — no markdown, no code fences, no explanation.' : ''}`,
        config: {
          temperature: 0.2,
          // responseMimeType is incompatible with tool use (googleSearch) — only set it when not using tools
          ...(!usingWebSearch ? { responseMimeType: 'application/json' } : {}),
          ...(usingWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
        },
      }),
      timeoutMs,
      `Gemini (${settings.model})`,
    );

    return response.text || '';
  }

  const shouldOmitTemperature = (() => {
    const providerName = settings.providerName.toLowerCase();
    const baseUrl = (settings.baseUrl || '').toLowerCase();
    return (
      providerName.includes('kimi') ||
      providerName.includes('moonshot') ||
      providerName.includes('z.ai') ||
      providerName.includes('zhipu') ||
      baseUrl.includes('moonshot') ||
      baseUrl.includes('api.z.ai') ||
      baseUrl.includes('bigmodel')
    );
  })();

  const requestBody: Record<string, unknown> = {
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${userPrompt}\n\nReturn only valid JSON.` },
    ],
  };

  if (!shouldOmitTemperature) {
    requestBody.temperature = 0.2;
  }

  const response = await fetch(`${settings.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `LLM request failed for ${settings.providerName}`);
  }

  const payload = await response.json();
  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('');
  }

  return '';
}

// Only retry transient failures (timeouts, rate limits, 5xx, network blips).
// Client errors (auth, bad request) are not retryable — fail fast.
function isRetryableLlmError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/\b(400|401|403|404)\b/.test(msg)) return false;
  if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('permission') || msg.includes('invalid_argument')) return false;
  return true;
}

async function generateJsonWithLlm({
  systemPrompt,
  userPrompt,
  useWebSearch,
  timeoutMs = 120000,
  retries = 1,
}: {
  systemPrompt: string;
  userPrompt: string;
  useWebSearch: boolean;
  timeoutMs?: number;
  retries?: number;
}) {
  const settings = getLlmSettings();
  ensureLlmConfigured(settings);

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runLlmCallOnce(settings, systemPrompt, userPrompt, useWebSearch, timeoutMs);
    } catch (error) {
      lastError = error;
      // Fail fast on client errors (bad key, bad request) — retrying won't help.
      if (attempt >= retries || !isRetryableLlmError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('LLM call failed');
}

// Extract the first balanced JSON object/array from arbitrary text, correctly
// skipping braces inside string literals. Far safer than a greedy regex, which
// over-matches to the last brace anywhere in the response.
function extractFirstJson(text: string): string | null {
  let startIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  const open = text[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function parseJsonResponse<T>(rawText: string, fallbackValue: T) {
  if (!rawText) {
    return fallbackValue;
  }

  // Strip markdown code fences the model sometimes wraps JSON in.
  const cleaned = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {}

  const candidate = extractFirstJson(cleaned);
  if (candidate) {
    try {
      return JSON.parse(candidate) as T;
    } catch {}
  }

  console.warn('[llm] Failed to parse JSON response. First 500 chars:', cleaned.slice(0, 500));
  return fallbackValue;
}

function findExistingCompanyForResearch(companyName: unknown, website: unknown) {
  const companies = db.prepare('SELECT id, company_name, website FROM companies').all() as Array<{
    company_name: string;
    id: number;
    website: string | null;
  }>;

  const normalizedWebsiteHost = normalizeWebsiteHost(website);
  if (normalizedWebsiteHost) {
    const websiteMatch = companies.find((company) => normalizeWebsiteHost(company.website) === normalizedWebsiteHost);
    if (websiteMatch) {
      return { company: websiteMatch, matchedBy: 'website' as const };
    }
  }

  const normalizedCompanyName = normalizeCompanyNameForMatch(companyName);
  if (!normalizedCompanyName) {
    return null;
  }

  const companyNameMatch = companies.find(
    (company) => normalizeCompanyNameForMatch(company.company_name) === normalizedCompanyName,
  );

  if (companyNameMatch) {
    return { company: companyNameMatch, matchedBy: 'company_name' as const };
  }

  return null;
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    country TEXT NOT NULL,
    address TEXT,
    city TEXT,
    region TEXT,
    industry TEXT NOT NULL,
    company_type TEXT NOT NULL,
    employee_count INTEGER,
    revenue_eur REAL,
    website TEXT,
    company_email TEXT,
    legal_form TEXT,
    business_role TEXT,
    main_products TEXT,
    related_companies TEXT,
    corporate_parent TEXT,
    is_subsidiary BOOLEAN DEFAULT 0,
    duns_number TEXT,
    source TEXT DEFAULT 'DNB_HOOVERS',
    lead_score INTEGER DEFAULT 0,
    lead_status TEXT DEFAULT 'RAW',
    qualification_notes TEXT,
    technical_fit TEXT,
    assigned_to TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    product_fit TEXT,
    social_media_urls TEXT,
    social_media_active BOOLEAN DEFAULT 0,
    mentions_technology BOOLEAN DEFAULT 0,
    follow_up_date DATETIME,
    tracking_level TEXT DEFAULT 'WATCHLIST',
    tracking_status TEXT DEFAULT 'PENDING',
    tracking_notes TEXT,
    next_tracking_date DATETIME
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    full_name TEXT NOT NULL,
    job_title TEXT,
    department TEXT,
    contact_role TEXT,
    contact_priority TEXT,
    email TEXT,
    phone_direct TEXT,
    phone_mobile TEXT,
    linkedin_url TEXT,
    contacted_via TEXT,
    interest_reason TEXT,
    ceramic_bearing_experience TEXT,
    attempted_solution TEXT,
    operating_media TEXT,
    hybrid_bearing_alternative TEXT,
    cooperation_interest TEXT,
    is_verified BOOLEAN DEFAULT 0,
    verified_date DATETIME,
    verification_source TEXT,
    is_primary BOOLEAN DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    contact_id INTEGER REFERENCES contacts(id),
    activity_type TEXT NOT NULL,
    activity_date DATETIME NOT NULL,
    performed_by TEXT NOT NULL,
    subject TEXT,
    details TEXT,
    outcome TEXT,
    follow_up_date DATETIME,
    follow_up_done BOOLEAN DEFAULT 0,
    attachments TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    contact_id INTEGER REFERENCES contacts(id),
    order_reference TEXT,
    order_date DATETIME NOT NULL,
    order_value_eur REAL NOT NULL,
    product_type TEXT,
    is_hybrid BOOLEAN DEFAULT 0,
    commission_rate REAL,
    commission_eur REAL,
    payment_received BOOLEAN DEFAULT 0,
    payment_date DATETIME,
    commission_paid BOOLEAN DEFAULT 0,
    commission_paid_date DATETIME,
    innovista_contribution TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'Sales',
    is_active BOOLEAN DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Idempotent schema migrations. safeMigrate swallows only "already applied"
// errors (duplicate column / index exists) and logs anything unexpected — so a
// genuinely broken migration is surfaced instead of silently swallowed.
function safeMigrate(sql: string) {
  try {
    db.exec(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column name|already exists/i.test(msg)) return;
    console.error('[migration] Statement failed:', sql.trim(), '—', msg);
  }
}

// Add new columns to companies if they don't exist
safeMigrate("ALTER TABLE companies ADD COLUMN product_fit TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN social_media_urls TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN social_media_active BOOLEAN DEFAULT 0;");
safeMigrate("ALTER TABLE companies ADD COLUMN mentions_technology BOOLEAN DEFAULT 0;");
safeMigrate("ALTER TABLE companies ADD COLUMN follow_up_date DATETIME;");
safeMigrate("ALTER TABLE companies ADD COLUMN tracking_level TEXT DEFAULT 'WATCHLIST';");
safeMigrate("ALTER TABLE companies ADD COLUMN tracking_status TEXT DEFAULT 'PENDING';");
safeMigrate("ALTER TABLE companies ADD COLUMN tracking_notes TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN next_tracking_date DATETIME;");
safeMigrate("ALTER TABLE companies ADD COLUMN address TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN company_email TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN legal_form TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN business_role TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN main_products TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN related_companies TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN contacted_via TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN interest_reason TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN ceramic_bearing_experience TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN attempted_solution TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN operating_media TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN hybrid_bearing_alternative TEXT;");
safeMigrate("ALTER TABLE contacts ADD COLUMN cooperation_interest TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN website_score INTEGER;");
safeMigrate("ALTER TABLE companies ADD COLUMN social_score INTEGER;");
safeMigrate("ALTER TABLE companies ADD COLUMN buying_probability INTEGER;");
safeMigrate("ALTER TABLE companies ADD COLUMN approach_strategy TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN sales_script TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN email_script TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN ai_qualified_at DATETIME;");
safeMigrate("ALTER TABLE companies ADD COLUMN opportunity_notes TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN social_profiles_json TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN lead_priority TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN ai_confidence INTEGER;");
safeMigrate("ALTER TABLE companies ADD COLUMN disqualification_reason TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN disqualification_category TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN disqualified_by TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN disqualified_at DATETIME;");
safeMigrate("ALTER TABLE companies ADD COLUMN human_reviewed INTEGER DEFAULT 0;");
safeMigrate("ALTER TABLE companies ADD COLUMN human_reviewed_at DATETIME;");
safeMigrate("ALTER TABLE companies ADD COLUMN human_reviewed_by TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN human_review_notes TEXT;");

// Phase 6 — FK indexes for hot join paths (idempotent). Cheap at small scale,
// matters when companies grows past a few thousand rows.
safeMigrate("CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_activities_company_id ON activities(company_id);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities(contact_id);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_activities_follow_up ON activities(follow_up_date, follow_up_done);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_orders_company_id ON orders(company_id);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_notes_company_id ON notes(company_id);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_lead_status ON companies(lead_status);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_region ON companies(region);");

// Performance indexes for the columns the companies list sorts/filters on.
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_updated_at ON companies(updated_at);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_created_at ON companies(created_at);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_ai_qualified_at ON companies(ai_qualified_at);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_lead_priority ON companies(lead_priority);");

// Phase 6 — normalized dedup keys. Stored alongside the company row so
// the matcher can do an indexed lookup instead of scanning all companies.
safeMigrate("ALTER TABLE companies ADD COLUMN company_name_key TEXT;");
safeMigrate("ALTER TABLE companies ADD COLUMN website_key TEXT;");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_name_key ON companies(company_name_key);");
safeMigrate("CREATE INDEX IF NOT EXISTS idx_companies_website_key ON companies(website_key);");

try { db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    author TEXT NOT NULL DEFAULT 'Team',
    message TEXT NOT NULL,
    type TEXT DEFAULT 'note',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`); } catch (e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS research_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    website TEXT,
    contacts_found INTEGER DEFAULT 0,
    saved_to_company_id INTEGER,
    saved_to_company_name TEXT,
    results_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`); } catch (e) {}

db.prepare("UPDATE companies SET tracking_level = 'WATCHLIST' WHERE tracking_level IS NULL OR tracking_level = ''").run();
db.prepare("UPDATE companies SET tracking_status = 'PENDING' WHERE tracking_status IS NULL OR tracking_status = ''").run();

// Backfill normalized dedup keys for any rows missing them. Cheap on startup.
try {
  const rowsToBackfill = db.prepare(
    "SELECT id, company_name, website FROM companies WHERE company_name_key IS NULL OR website_key IS NULL"
  ).all() as Array<{ id: number; company_name: string; website: string | null }>;
  if (rowsToBackfill.length > 0) {
    const updateKeys = db.prepare("UPDATE companies SET company_name_key = ?, website_key = ? WHERE id = ?");
    const backfill = db.transaction(() => {
      for (const row of rowsToBackfill) {
        updateKeys.run(
          normalizeCompanyNameForMatch(row.company_name),
          normalizeWebsiteHost(row.website),
          row.id,
        );
      }
    });
    backfill();
    console.log(`[startup] Backfilled normalized dedup keys for ${rowsToBackfill.length} companies.`);
  }
} catch (err) {
  console.error('Dedup key backfill failed:', err);
}

// One-time migration: encrypt any plaintext LLM API key that was saved before
// Phase 6. The encryption prefix 'enc:v1:' marks ciphertext — anything else is
// legacy plaintext and gets encrypted in place.
try {
  const legacyKey = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'llm.api_key'").get() as { setting_value: string } | undefined;
  if (legacyKey?.setting_value && !legacyKey.setting_value.startsWith(ENC_PREFIX)) {
    const encrypted = encryptSecret(legacyKey.setting_value);
    db.prepare("UPDATE app_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'llm.api_key'").run(encrypted);
    console.log('[security] Migrated legacy plaintext LLM API key to encrypted storage.');
  }
} catch (err) {
  console.error('LLM API key migration failed:', err);
}

const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
if (userCount.count === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (full_name, email, role, is_active, notes)
    VALUES (?, ?, 'Sales', 1, '')
  `);

  const seedUsers = db.transaction(() => {
    for (const fullName of DEFAULT_USERS) {
      const emailSlug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '');
      insertUser.run(fullName, `${emailSlug}@example.com`);
    }
  });

  seedUsers();
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/settings/llm', (req, res) => {
  try {
    const settings = getLlmSettings();
    // Never return the plaintext API key — only a preview for UI display.
    res.json({
      provider_type: settings.providerType,
      provider_name: settings.providerName,
      model: settings.model,
      base_url: settings.baseUrl || '',
      api_key: '', // explicitly empty — UI shows masked preview from has_api_key
      api_key_preview: settings.apiKey ? maskSecret(settings.apiKey) : '',
      has_api_key: Boolean(settings.apiKey),
      source: settings.source,
      supports_web_search: settings.supportsWebSearch,
    });
  } catch (error) {
    sendApiError(res, error, 'Failed to load LLM settings');
  }
});

app.put('/api/settings/llm', requireAdmin, (req, res) => {
  try {
    const providerType = normalizeOptionalString(req.body.provider_type);
    if (providerType !== 'gemini' && providerType !== 'openai_compatible') {
      return res.status(400).json({ error: 'provider_type must be gemini or openai_compatible' });
    }

    // Only touch llm.api_key when the caller explicitly sets a new key OR
    // explicitly requests deletion via clear_api_key=true. An empty/missing
    // api_key field means "preserve the existing encrypted key" — the GET
    // endpoint never returns the plaintext, so the form re-sends '' by default.
    const incomingApiKey = normalizeOptionalString(req.body.api_key) || '';
    const shouldClearKey = req.body.clear_api_key === true;
    const apiKeyEntry: Record<string, string> = {};
    if (incomingApiKey) {
      apiKeyEntry['llm.api_key'] = encryptSecret(incomingApiKey);
    } else if (shouldClearKey) {
      apiKeyEntry['llm.api_key'] = '';
    }

    saveSettings({
      'llm.provider_type': providerType,
      'llm.provider_name': normalizeOptionalString(req.body.provider_name) || (providerType === 'gemini' ? 'Gemini' : 'OpenAI-Compatible'),
      'llm.model': normalizeOptionalString(req.body.model) || (providerType === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini'),
      'llm.base_url': providerType === 'openai_compatible'
        ? normalizeOptionalString(req.body.base_url) || 'https://api.openai.com/v1'
        : '',
      ...apiKeyEntry,
    });

    const settings = getLlmSettings();
    res.json({
      provider_type: settings.providerType,
      provider_name: settings.providerName,
      model: settings.model,
      base_url: settings.baseUrl || '',
      has_api_key: Boolean(settings.apiKey),
      source: settings.source,
      supports_web_search: settings.supportsWebSearch,
    });
  } catch (error) {
    sendApiError(res, error, 'Failed to save LLM settings');
  }
});

app.get('/api/users', (req, res) => {
  try {
    const activeOnly = req.query.activeOnly === 'true';
    const users = db.prepare(`
      SELECT *
      FROM users
      ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY is_active DESC, full_name ASC
    `).all();

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const fullName = normalizeRequiredString(req.body.full_name);
    if (!fullName) {
      return res.status(400).json({ error: 'full_name is required' });
    }

    const existingUser = db
      .prepare('SELECT id FROM users WHERE lower(full_name) = lower(?)')
      .get(fullName) as { id: number } | undefined;

    if (existingUser) {
      return res.status(409).json({ error: 'A user with this name already exists' });
    }

    const result = db.prepare(`
      INSERT INTO users (full_name, email, role, is_active, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      fullName,
      normalizeOptionalString(req.body.email),
      normalizeOptionalString(req.body.role) || 'Sales',
      normalizeBooleanFlag(req.body.is_active) ? 1 : 0,
      normalizeOptionalString(req.body.notes),
    );

    const createdUser = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(createdUser);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  try {
    const fullName = normalizeRequiredString(req.body.full_name);
    if (!fullName) {
      return res.status(400).json({ error: 'full_name is required' });
    }

    const existingUser = db
      .prepare('SELECT id FROM users WHERE lower(full_name) = lower(?) AND id != ?')
      .get(fullName, req.params.id) as { id: number } | undefined;

    if (existingUser) {
      return res.status(409).json({ error: 'A user with this name already exists' });
    }

    db.prepare(`
      UPDATE users
      SET full_name = ?, email = ?, role = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      fullName,
      normalizeOptionalString(req.body.email),
      normalizeOptionalString(req.body.role) || 'Sales',
      normalizeBooleanFlag(req.body.is_active) ? 1 : 0,
      normalizeOptionalString(req.body.notes),
      req.params.id,
    );

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ?slim=true returns list-view columns only — excludes the heavy AI-generated
// text fields (approach_strategy, sales_script, email_script, opportunity_notes,
// qualification_notes, social_profiles_json) that the Companies list doesn't
// render. Cuts payload by roughly half on large datasets. Detail view and CSV
// exports continue to use the default (full) response.
app.get('/api/companies', (req, res) => {
  const slim = req.query.slim === 'true';
  const selectClause = slim
    ? `c.id, c.company_name, c.company_type, c.country, c.city, c.region, c.industry,
       c.employee_count, c.revenue_eur, c.website, c.duns_number, c.legal_form,
       c.main_products, c.corporate_parent, c.is_subsidiary, c.source,
       c.lead_score, c.lead_status, c.lead_priority, c.technical_fit, c.product_fit,
       c.buying_probability, c.website_score, c.social_score,
       c.social_media_active, c.mentions_technology,
       c.assigned_to, c.created_by, c.created_at, c.updated_at,
       c.ai_qualified_at, c.ai_confidence,
       c.disqualification_reason, c.disqualification_category, c.disqualified_by, c.disqualified_at,
       c.human_reviewed, c.human_reviewed_at, c.human_reviewed_by,
       c.tracking_level, c.tracking_status, c.next_tracking_date,
       c.company_name_key, c.website_key`
    : 'c.*';
  const companies = db.prepare(`
    SELECT
      ${selectClause},
      (SELECT COUNT(*) FROM contacts con WHERE con.company_id = c.id) as contact_count,
      (SELECT MIN(a.follow_up_date) FROM activities a
        WHERE a.company_id = c.id AND a.follow_up_done = 0 AND a.follow_up_date IS NOT NULL) as follow_up_date
    FROM companies c
    ORDER BY c.updated_at DESC, c.company_name ASC
  `).all();
  res.json(companies);
});

// Paged companies endpoint — server-side filter + sort + paginate.
// Used by the main Companies tab list so the client doesn't sift through
// the full table in memory. Returns slim columns only (heavy AI text fields
// excluded — see comment on /api/companies above).
app.get('/api/companies/paged', (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.page_size) || 50));
    const offset = (page - 1) * pageSize;

    const sortKeyAllowlist = new Set([
      'company_name', 'country', 'city', 'industry', 'company_type',
      'employee_count', 'revenue_eur', 'lead_score', 'lead_status',
      'lead_priority', 'ai_confidence', 'ai_qualified_at',
      'created_at', 'updated_at',
    ]);
    const sortKey = q.sort_key && sortKeyAllowlist.has(q.sort_key) ? q.sort_key : 'updated_at';
    const sortDir = q.sort_dir === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = [];
    const params: unknown[] = [];

    const eqFilter = (column: string, value: string | undefined) => {
      if (value && value.trim()) {
        where.push(`c.${column} = ?`);
        params.push(value.trim());
      }
    };
    eqFilter('lead_status', q.status);
    eqFilter('lead_priority', q.priority);
    eqFilter('country', q.country);
    eqFilter('industry', q.industry);
    eqFilter('company_type', q.company_type);
    eqFilter('assigned_to', q.assigned_to);
    eqFilter('region', q.region);

    if (q.min_score && !Number.isNaN(Number(q.min_score))) {
      where.push('c.lead_score >= ?');
      params.push(Number(q.min_score));
    }
    if (q.max_score && !Number.isNaN(Number(q.max_score))) {
      where.push('c.lead_score <= ?');
      params.push(Number(q.max_score));
    }
    if (q.date_from) {
      where.push('date(c.updated_at) >= date(?)');
      params.push(q.date_from);
    }
    if (q.date_to) {
      where.push('date(c.updated_at) <= date(?)');
      params.push(q.date_to);
    }

    switch (q.ai_qual) {
      case 'AI_QUALIFIED':
        where.push('c.ai_qualified_at IS NOT NULL');
        break;
      case 'NOT_QUALIFIED':
        where.push('c.ai_qualified_at IS NULL');
        break;
      case 'ENRICHED':
        where.push("c.lead_status = 'ENRICHED'");
        break;
      case 'QUALIFIED_NO_AI':
        where.push("c.lead_status = 'QUALIFIED' AND c.ai_qualified_at IS NULL");
        break;
      case 'NEEDS_REVIEW':
        where.push("c.ai_qualified_at IS NOT NULL AND c.human_reviewed = 0 AND (c.ai_confidence IS NULL OR c.ai_confidence < 70)");
        break;
    }

    if (q.search && q.search.trim()) {
      const term = `%${q.search.trim()}%`;
      where.push('(c.company_name LIKE ? OR c.country LIKE ? OR c.city LIKE ? OR c.industry LIKE ? OR c.company_type LIKE ? OR c.assigned_to LIKE ?)');
      params.push(term, term, term, term, term, term);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM companies c ${whereClause}`).get(...params) as { total: number };
    const revenueRow = db.prepare(`SELECT COALESCE(SUM(revenue_eur), 0) as revenue FROM companies c ${whereClause}`).get(...params) as { revenue: number };

    const slimSelect = `c.id, c.company_name, c.company_type, c.country, c.city, c.region, c.industry,
      c.employee_count, c.revenue_eur, c.website, c.duns_number, c.legal_form,
      c.main_products, c.corporate_parent, c.is_subsidiary, c.source,
      c.lead_score, c.lead_status, c.lead_priority, c.technical_fit, c.product_fit,
      c.buying_probability, c.website_score, c.social_score,
      c.social_media_active, c.mentions_technology,
      c.assigned_to, c.created_by, c.created_at, c.updated_at,
      c.ai_qualified_at, c.ai_confidence,
      c.disqualification_reason, c.disqualification_category, c.disqualified_by, c.disqualified_at,
      c.human_reviewed, c.human_reviewed_at, c.human_reviewed_by,
      c.tracking_level, c.tracking_status, c.next_tracking_date`;

    const rows = db.prepare(`
      SELECT ${slimSelect},
        (SELECT COUNT(*) FROM contacts con WHERE con.company_id = c.id) as contact_count,
        (SELECT MIN(a.follow_up_date) FROM activities a WHERE a.company_id = c.id AND a.follow_up_done = 0 AND a.follow_up_date IS NOT NULL) as follow_up_date
      FROM companies c
      ${whereClause}
      ORDER BY c.${sortKey} ${sortDir}, c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
      rows,
      total: totalRow.total,
      total_revenue: revenueRow.revenue,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(totalRow.total / pageSize),
    });
  } catch (error) {
    console.error('Paged companies error:', error);
    sendApiError(res, error, 'Failed to load paged companies');
  }
});

app.post('/api/companies', (req, res) => {
  try {
    const companyName = normalizeRequiredString(req.body.company_name);
    const country = normalizeRequiredString(req.body.country);

    if (!companyName || !country) {
      return res.status(400).json({ error: 'company_name and country are required' });
    }

    const website = normalizeOptionalString(req.body.website);
    const duplicate = findExistingCompanyByMatch(companyName, website);
    if (duplicate) {
      return res.status(409).json({
        error: `Duplicate found: "${duplicate.company_name}" (ID: ${duplicate.id}) — matched by ${duplicate.matchedBy}. Use merge if these are the same company.`,
        duplicate_id: duplicate.id,
        duplicate_name: duplicate.company_name,
        matched_by: duplicate.matchedBy,
      });
    }

    const creatorName = getRequestUser(req);
    const source = normalizeOptionalString(req.body.source) || 'MANUAL';
    const result = db.prepare(`
      INSERT INTO companies (
        company_name,
        website,
        company_email,
        country,
        address,
        city,
        region,
        industry,
        company_type,
        employee_count,
        revenue_eur,
        legal_form,
        business_role,
        main_products,
        related_companies,
        lead_status,
        technical_fit,
        lead_priority,
        assigned_to,
        qualification_notes,
        tracking_level,
        tracking_status,
        tracking_notes,
        next_tracking_date,
        source,
        created_by,
        company_name_key,
        website_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      companyName,
      normalizeOptionalString(req.body.website),
      normalizeOptionalString(req.body.company_email),
      country,
      normalizeOptionalString(req.body.address),
      normalizeOptionalString(req.body.city),
      normalizeOptionalString(req.body.region),
      normalizeRequiredString(req.body.industry) || 'BEARING_TRADER',
      normalizeRequiredString(req.body.company_type) || 'BEARING_TRADER',
      normalizeNullableNumber(req.body.employee_count),
      normalizeNullableNumber(req.body.revenue_eur),
      normalizeOptionalString(req.body.legal_form),
      normalizeOptionalString(req.body.business_role),
      normalizeOptionalString(req.body.main_products),
      normalizeOptionalString(req.body.related_companies),
      normalizeRequiredString(req.body.lead_status) || 'RAW',
      normalizeTechnicalFit(req.body.technical_fit),
      normalizeOptionalString(req.body.lead_priority),
      normalizeOptionalString(req.body.assigned_to),
      normalizeOptionalString(req.body.qualification_notes),
      normalizeTrackingLevel(req.body.tracking_level),
      normalizeTrackingStatus(req.body.tracking_status),
      normalizeOptionalString(req.body.tracking_notes),
      normalizeOptionalString(req.body.next_tracking_date),
      source,
      creatorName,
      normalizeCompanyNameForMatch(companyName),
      normalizeWebsiteHost(req.body.website),
    );

    const createdCompany = db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(createdCompany);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

app.get('/api/companies/:id', (req, res) => {
  try {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id) as any;
    if (!company) return res.status(404).json({ error: 'Not found' });
    const contacts = db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY created_at DESC').all(req.params.id);
    const activities = db.prepare('SELECT * FROM activities WHERE company_id = ? ORDER BY activity_date DESC').all(req.params.id);
    const orders = db.prepare('SELECT * FROM orders WHERE company_id = ? ORDER BY order_date DESC').all(req.params.id);
    res.json({ ...company, contacts, activities, orders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch company details' });
  }
});

app.put('/api/companies/:id', (req, res) => {
  try {
    const companyName = normalizeRequiredString(req.body.company_name);
    const country = normalizeRequiredString(req.body.country);

    if (!companyName || !country) {
      return res.status(400).json({ error: 'company_name and country are required' });
    }

    const newStatus = normalizeRequiredString(req.body.lead_status) || 'RAW';
    if (newStatus === 'DISQUALIFIED') {
      const existing = db.prepare('SELECT lead_status FROM companies WHERE id = ?').get(req.params.id) as { lead_status: string } | undefined;
      if (existing && existing.lead_status !== 'DISQUALIFIED') {
        return res.status(400).json({ error: 'Use /disqualify to record a reason before marking a lead disqualified' });
      }
    }

    db.prepare(`
      UPDATE companies
      SET company_name = ?, website = ?, company_email = ?, country = ?, address = ?, city = ?, region = ?, industry = ?, company_type = ?,
          employee_count = ?, revenue_eur = ?, legal_form = ?, business_role = ?, main_products = ?, related_companies = ?,
          lead_status = ?, technical_fit = ?, lead_priority = ?, assigned_to = ?, qualification_notes = ?, tracking_level = ?, tracking_status = ?, tracking_notes = ?,
          next_tracking_date = ?, duns_number = ?, corporate_parent = ?, is_subsidiary = ?, source = ?,
          created_by = ?, company_name_key = ?, website_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      companyName,
      normalizeOptionalString(req.body.website),
      normalizeOptionalString(req.body.company_email),
      country,
      normalizeOptionalString(req.body.address),
      normalizeOptionalString(req.body.city),
      normalizeOptionalString(req.body.region),
      normalizeRequiredString(req.body.industry) || 'BEARING_TRADER',
      normalizeRequiredString(req.body.company_type) || 'BEARING_TRADER',
      normalizeNullableNumber(req.body.employee_count),
      normalizeNullableNumber(req.body.revenue_eur),
      normalizeOptionalString(req.body.legal_form),
      normalizeOptionalString(req.body.business_role),
      normalizeOptionalString(req.body.main_products),
      normalizeOptionalString(req.body.related_companies),
      normalizeRequiredString(req.body.lead_status) || 'RAW',
      normalizeTechnicalFit(req.body.technical_fit),
      normalizeOptionalString(req.body.lead_priority),
      normalizeOptionalString(req.body.assigned_to),
      normalizeOptionalString(req.body.qualification_notes),
      normalizeTrackingLevel(req.body.tracking_level),
      normalizeTrackingStatus(req.body.tracking_status),
      normalizeOptionalString(req.body.tracking_notes),
      normalizeOptionalString(req.body.next_tracking_date),
      normalizeOptionalString(req.body.duns_number),
      normalizeOptionalString(req.body.corporate_parent),
      req.body.is_subsidiary ? 1 : 0,
      normalizeOptionalString(req.body.source),
      normalizeOptionalString(req.body.created_by) || getRequestUser(req),
      normalizeCompanyNameForMatch(companyName),
      normalizeWebsiteHost(req.body.website),
      req.params.id,
    );

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Update company error:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// PATCH: update a single field (for inline edits)
app.patch('/api/companies/:id', (req, res) => {
  try {
    const companyId = req.params.id;
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
    if (!existing) return res.status(404).json({ error: 'Company not found' });

    if (req.body.lead_status === 'DISQUALIFIED' && existing.lead_status !== 'DISQUALIFIED') {
      return res.status(400).json({ error: 'Use /disqualify to record a reason before marking a lead disqualified' });
    }

    // Build dynamic SET clause from request body fields
    const allowedFields = [
      'company_name', 'website', 'company_email', 'country', 'address', 'city', 'region', 'industry', 'company_type',
      'employee_count', 'revenue_eur', 'legal_form', 'business_role', 'main_products', 'related_companies',
      'lead_status', 'technical_fit', 'lead_priority', 'assigned_to',
      'qualification_notes', 'tracking_level', 'tracking_status', 'tracking_notes',
      'next_tracking_date', 'duns_number', 'corporate_parent', 'is_subsidiary', 'source', 'created_by',
    ];

    const setClauses: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const values: any[] = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        if (field === 'employee_count' || field === 'revenue_eur') {
          values.push(req.body[field] === '' || req.body[field] === null ? null : Number(req.body[field]));
        } else if (field === 'is_subsidiary') {
          values.push(req.body[field] ? 1 : 0);
        } else {
          values.push(req.body[field] === '' ? null : req.body[field]);
        }
      }
    }

    if (setClauses.length <= 1) return res.status(400).json({ error: 'No fields to update' });

    // Keep normalized dedup keys in sync when name or website changes via PATCH.
    if (req.body.company_name !== undefined) {
      setClauses.push('company_name_key = ?');
      values.push(normalizeCompanyNameForMatch(req.body.company_name));
    }
    if (req.body.website !== undefined) {
      setClauses.push('website_key = ?');
      values.push(normalizeWebsiteHost(req.body.website));
    }

    values.push(companyId);
    db.prepare(`UPDATE companies SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updated);
  } catch (err) {
    console.error('Patch company error:', err);
    res.status(500).json({ error: 'Failed to update field' });
  }
});

app.post('/api/contacts/enrich', llmRateLimiter, async (req, res) => {
  try {
    const { company_name, full_name } = req.body;
    if (!company_name || !full_name) {
      return res.status(400).json({ error: 'company_name and full_name are required' });
    }

    const rawResponse = await generateJsonWithLlm({
      systemPrompt:
        'You are an expert B2B contact researcher. Return only strict JSON and leave unknown fields as empty strings.',
      userPrompt: `
        Find the best available professional contact details for the following person.
        Person: ${full_name}
        Company: ${company_name}

        Return a JSON object with these keys:
        - job_title
        - email
        - linkedin_url
      `,
      useWebSearch: true,
    });

    const result = parseJsonResponse(rawResponse, {
      email: '',
      job_title: '',
      linkedin_url: '',
    });
    res.json(result);
  } catch (error) {
    console.error('Contact enrichment error:', error);
    sendApiError(res, error, 'Contact enrichment failed');
  }
});

app.post('/api/contacts', (req, res) => {
  try {
    const {
      company_id,
      full_name,
      job_title,
      email,
      phone_direct,
      linkedin_url,
      contacted_via,
      interest_reason,
      ceramic_bearing_experience,
      attempted_solution,
      operating_media,
      hybrid_bearing_alternative,
      cooperation_interest,
      notes,
      is_verified,
      verification_source,
    } = req.body;

    // Unique email check within the same company
    if (email && email.trim()) {
      const existingContact = db.prepare(
        'SELECT id, full_name FROM contacts WHERE company_id = ? AND lower(email) = lower(?)'
      ).get(company_id, email.trim()) as any;
      if (existingContact) {
        return res.status(409).json({
          error: `A contact with email "${email}" already exists for this company: ${existingContact.full_name}`,
          existing_id: existingContact.id,
        });
      }
    }

    const verified_date = is_verified ? new Date().toISOString() : null;
    const info = db.prepare(`
      INSERT INTO contacts (
        company_id, full_name, job_title, email, phone_direct, linkedin_url,
        contacted_via, interest_reason, ceramic_bearing_experience, attempted_solution,
        operating_media, hybrid_bearing_alternative, cooperation_interest,
        notes, is_verified, verification_source, verified_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      company_id,
      full_name,
      job_title,
      email,
      phone_direct,
      linkedin_url,
      normalizeOptionalString(contacted_via),
      normalizeOptionalString(interest_reason),
      normalizeOptionalString(ceramic_bearing_experience),
      normalizeOptionalString(attempted_solution),
      normalizeOptionalString(operating_media),
      normalizeOptionalString(hybrid_bearing_alternative),
      normalizeOptionalString(cooperation_interest),
      notes,
      is_verified ? 1 : 0,
      verification_source,
      verified_date,
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

app.put('/api/contacts/:id', (req, res) => {
  try {
    const {
      full_name,
      job_title,
      email,
      phone_direct,
      linkedin_url,
      contacted_via,
      interest_reason,
      ceramic_bearing_experience,
      attempted_solution,
      operating_media,
      hybrid_bearing_alternative,
      cooperation_interest,
      notes,
      is_verified,
      verification_source,
    } = req.body;
    
    const currentContact = db.prepare('SELECT is_verified, verified_date FROM contacts WHERE id = ?').get(req.params.id) as any;
    let verified_date = currentContact?.verified_date;
    if (is_verified && !currentContact?.is_verified) {
      verified_date = new Date().toISOString();
    } else if (!is_verified) {
      verified_date = null;
    }

    db.prepare(`
      UPDATE contacts 
      SET full_name = ?, job_title = ?, email = ?, phone_direct = ?, linkedin_url = ?,
          contacted_via = ?, interest_reason = ?, ceramic_bearing_experience = ?, attempted_solution = ?,
          operating_media = ?, hybrid_bearing_alternative = ?, cooperation_interest = ?,
          notes = ?, is_verified = ?, verification_source = ?, verified_date = ?
      WHERE id = ?
    `).run(
      full_name,
      job_title,
      email,
      phone_direct,
      linkedin_url,
      normalizeOptionalString(contacted_via),
      normalizeOptionalString(interest_reason),
      normalizeOptionalString(ceramic_bearing_experience),
      normalizeOptionalString(attempted_solution),
      normalizeOptionalString(operating_media),
      normalizeOptionalString(hybrid_bearing_alternative),
      normalizeOptionalString(cooperation_interest),
      notes,
      is_verified ? 1 : 0,
      verification_source,
      verified_date,
      req.params.id,
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

app.delete('/api/contacts/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

app.post('/api/activities', (req, res) => {
  try {
    const { company_id, contact_id, activity_type, activity_date, performed_by, subject, details, outcome, follow_up_date } = req.body;
    const info = db.prepare(`
      INSERT INTO activities (company_id, contact_id, activity_type, activity_date, performed_by, subject, details, outcome, follow_up_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company_id, contact_id || null, activity_type, activity_date, performed_by, subject, details, outcome, follow_up_date || null);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

app.get('/api/activities/follow-ups', (req, res) => {
  try {
    const followUps = db.prepare(`
      SELECT a.*, c.company_name 
      FROM activities a
      JOIN companies c ON a.company_id = c.id
      WHERE a.follow_up_date IS NOT NULL AND a.follow_up_done = 0
      ORDER BY a.follow_up_date ASC
    `).all();
    res.json(followUps);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch follow-ups' });
  }
});

app.put('/api/activities/:id/snooze', (req, res) => {
  try {
    const { days } = req.body;
    if (!days || typeof days !== 'number') return res.status(400).json({ error: 'days is required' });
    db.prepare(`
      UPDATE activities SET follow_up_date = date(follow_up_date, '+' || ? || ' days') WHERE id = ?
    `).run(days, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to snooze follow-up' });
  }
});

app.put('/api/activities/:id/done', (req, res) => {
  try {
    db.prepare('UPDATE activities SET follow_up_done = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark follow-up as done' });
  }
});

app.get('/api/activities/recent', (req, res) => {
  try {
    const activities = db.prepare(`
      SELECT a.id, a.company_id, a.activity_type, a.activity_date, a.performed_by,
             a.subject, a.details, a.outcome, a.follow_up_date, a.created_at,
             c.company_name
      FROM activities a
      JOIN companies c ON a.company_id = c.id
      ORDER BY a.created_at DESC
      LIMIT 15
    `).all();
    res.json(activities);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recent activities' });
  }
});

// Merge two companies: move all data from source into target, delete source
app.post('/api/companies/merge', (req, res) => {
  try {
    const { target_id, source_id } = req.body;
    if (!target_id || !source_id || target_id === source_id) {
      return res.status(400).json({ error: 'target_id and source_id are required and must differ' });
    }

    const target = db.prepare('SELECT * FROM companies WHERE id = ?').get(target_id) as any;
    const source = db.prepare('SELECT * FROM companies WHERE id = ?').get(source_id) as any;
    if (!target || !source) return res.status(404).json({ error: 'Company not found' });

    db.transaction(() => {
      // Move contacts (skip duplicates by email)
      const sourceContacts = db.prepare('SELECT * FROM contacts WHERE company_id = ?').all(source_id) as any[];
      for (const contact of sourceContacts) {
        if (contact.email) {
          const existing = db.prepare('SELECT id FROM contacts WHERE company_id = ? AND lower(email) = lower(?)').get(target_id, contact.email);
          if (existing) continue; // skip duplicate email
        }
        db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(target_id, contact.id);
      }

      // Move activities, orders, notes
      db.prepare('UPDATE activities SET company_id = ? WHERE company_id = ?').run(target_id, source_id);
      db.prepare('UPDATE orders SET company_id = ? WHERE company_id = ?').run(target_id, source_id);
      db.prepare('UPDATE notes SET company_id = ? WHERE company_id = ?').run(target_id, source_id);

      // Merge fields: fill blanks in target from source
      const fillFields = ['website', 'company_email', 'address', 'legal_form', 'business_role', 'main_products', 'related_companies', 'region', 'duns_number', 'corporate_parent', 'employee_count', 'revenue_eur', 'assigned_to'];
      for (const field of fillFields) {
        if (!target[field] && source[field]) {
          db.prepare(`UPDATE companies SET ${field} = ? WHERE id = ?`).run(source[field], target_id);
        }
      }

      // Add merge note
      db.prepare('INSERT INTO notes (company_id, author, message, type) VALUES (?, ?, ?, ?)').run(
        target_id, 'System', `Merged with "${source.company_name}" (ID: ${source_id}). All contacts, activities, and notes transferred.`, 'system'
      );

      // Delete source company
      db.prepare('DELETE FROM contacts WHERE company_id = ?').run(source_id);
      db.prepare('DELETE FROM companies WHERE id = ?').run(source_id);

      // Update timestamp
      db.prepare('UPDATE companies SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(target_id);
    })();

    const merged = db.prepare('SELECT * FROM companies WHERE id = ?').get(target_id);
    res.json({ success: true, company: merged });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: 'Failed to merge companies' });
  }
});

app.get('/api/companies/:id/notes', (req, res) => {
  try {
    const notes = db.prepare('SELECT * FROM notes WHERE company_id = ? ORDER BY created_at ASC').all(req.params.id);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

app.post('/api/companies/:id/notes', (req, res) => {
  try {
    const message = normalizeOptionalString(req.body.message);
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const author = normalizeOptionalString(req.body.author) || 'Team';
    const type = normalizeOptionalString(req.body.type) || 'note';
    const info = db.prepare(
      'INSERT INTO notes (company_id, author, message, type) VALUES (?, ?, ?, ?)'
    ).run(req.params.id, author, message, type);
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
    res.json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

app.delete('/api/companies/:id', (req, res) => {
  try {
    const companyId = req.params.id;
    db.prepare('DELETE FROM contacts WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM activities WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM orders WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM notes WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

app.patch('/api/companies/:id/status', (req, res) => {
  try {
    const newStatus = normalizeOptionalString(req.body.lead_status);
    if (!newStatus) return res.status(400).json({ error: 'lead_status is required' });
    if (newStatus === 'DISQUALIFIED') {
      return res.status(400).json({ error: 'Use POST /api/companies/:id/disqualify to record a reason' });
    }
    db.prepare('UPDATE companies SET lead_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

const DISQUALIFICATION_CATEGORIES = new Set([
  'COMPETITOR',
  'WHOLESALER_TRADER',
  'UTILITY_OR_SOFTWARE',
  'SERVICE_MRO',
  'GLOBAL_ENTERPRISE',
  'SALES_BRANCH',
  'EPC_INTEGRATOR',
  'SMALL_END_USER',
  'LOW_FIT',
  'DUPLICATE',
  'OTHER',
]);

app.post('/api/companies/:id/disqualify', (req, res) => {
  try {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id) as { id: number } | undefined;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const reason = normalizeOptionalString(req.body.reason);
    const category = normalizeOptionalString(req.body.category);
    const by = normalizeOptionalString(req.body.by) || 'Unknown';

    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: 'A reason of at least 3 characters is required' });
    }
    if (!category || !DISQUALIFICATION_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'A valid category is required' });
    }

    db.prepare(`
      UPDATE companies
      SET lead_status = 'DISQUALIFIED',
          lead_priority = 'NOT_A_TARGET',
          disqualification_reason = ?,
          disqualification_category = ?,
          disqualified_by = ?,
          disqualified_at = CURRENT_TIMESTAMP,
          human_reviewed = 1,
          human_reviewed_at = CURRENT_TIMESTAMP,
          human_reviewed_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, category, by, by, req.params.id);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Disqualify error:', err);
    res.status(500).json({ error: 'Failed to disqualify company' });
  }
});

app.post('/api/companies/:id/mark-reviewed', (req, res) => {
  try {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id) as { id: number } | undefined;
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const by = normalizeOptionalString(req.body.by) || 'Unknown';
    const notes = normalizeOptionalString(req.body.notes);
    db.prepare(`
      UPDATE companies
      SET human_reviewed = 1,
          human_reviewed_at = CURRENT_TIMESTAMP,
          human_reviewed_by = ?,
          human_review_notes = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(by, notes, req.params.id);
    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Mark reviewed error:', err);
    res.status(500).json({ error: 'Failed to mark reviewed' });
  }
});

// Note: NOT mounted under /api/companies/:id/... — Express would match the
// :id segment as "bulk" and shadow this with the single-id endpoint above.
// Sibling /api/bulk/* namespace avoids that footgun for future batch routes.
app.post('/api/bulk/companies/mark-reviewed', (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!rawIds || rawIds.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const ids = rawIds
      .map((v: unknown) => Number(v))
      .filter((n: number) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids must contain positive integers' });
    }
    if (ids.length > BULK_OPERATION_LIMIT) {
      return res.status(400).json({ error: `bulk limit is ${BULK_OPERATION_LIMIT} ids per call` });
    }

    const by = getRequestUser(req);
    const notes = normalizeOptionalString(req.body?.notes);

    const updateStmt = db.prepare(`
      UPDATE companies
      SET human_reviewed = 1,
          human_reviewed_at = CURRENT_TIMESTAMP,
          human_reviewed_by = ?,
          human_review_notes = COALESCE(?, human_review_notes),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const existsStmt = db.prepare('SELECT 1 FROM companies WHERE id = ?');

    let succeeded = 0;
    const missing: number[] = [];
    const touchedIds: number[] = [];

    const runBatch = db.transaction(() => {
      for (const id of ids) {
        if (!existsStmt.get(id)) {
          missing.push(id);
          continue;
        }
        updateStmt.run(by, notes, id);
        touchedIds.push(id);
        succeeded++;
      }
    });
    runBatch();

    // Hydrate updated rows once outside the transaction.
    const updated = touchedIds.length > 0
      ? db.prepare(`SELECT * FROM companies WHERE id IN (${touchedIds.map(() => '?').join(',')})`).all(...touchedIds)
      : [];

    res.json({
      succeeded,
      failed: missing.length,
      missing,
      updated,
    });
  } catch (err) {
    console.error('Bulk mark-reviewed error:', err);
    res.status(500).json({ error: 'Failed to bulk mark reviewed' });
  }
});

app.post('/api/companies/:id/unmark-reviewed', (req, res) => {
  try {
    db.prepare(`
      UPDATE companies
      SET human_reviewed = 0,
          human_reviewed_at = NULL,
          human_reviewed_by = NULL,
          human_review_notes = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to unmark reviewed' });
  }
});

app.post('/api/companies/:id/restore', (req, res) => {
  try {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id) as { id: number } | undefined;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const newStatus = normalizeOptionalString(req.body.lead_status) || 'ENRICHED';
    if (newStatus === 'DISQUALIFIED') {
      return res.status(400).json({ error: 'Cannot restore to DISQUALIFIED' });
    }

    db.prepare(`
      UPDATE companies
      SET lead_status = ?,
          lead_priority = CASE WHEN lead_priority = 'NOT_A_TARGET' THEN NULL ELSE lead_priority END,
          disqualification_reason = NULL,
          disqualification_category = NULL,
          disqualified_by = NULL,
          disqualified_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newStatus, req.params.id);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Failed to restore company' });
  }
});

app.get('/api/contacts', (req, res) => {
  try {
    const contacts = db.prepare(`
      SELECT c.*, comp.company_name 
      FROM contacts c 
      LEFT JOIN companies comp ON c.company_id = comp.id
      ORDER BY c.created_at DESC
    `).all();
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

app.get('/api/orders', requireAdmin, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT o.*, comp.company_name 
      FROM orders o 
      LEFT JOIN companies comp ON o.company_id = comp.id
      ORDER BY o.order_date DESC
    `).all();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.get('/api/export/customer-tracker', requireAdmin, (req, res) => {
  try {
    const requestedCompanyId = Number(req.query.companyId);
    const companyIdFilter = Number.isFinite(requestedCompanyId) && requestedCompanyId > 0 ? requestedCompanyId : null;

    const companies = (companyIdFilter
      ? db.prepare('SELECT * FROM companies WHERE id = ? ORDER BY company_name ASC').all(companyIdFilter)
      : db.prepare('SELECT * FROM companies ORDER BY company_name ASC').all()) as any[];
    const contacts = (companyIdFilter
      ? db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY created_at ASC').all(companyIdFilter)
      : db.prepare('SELECT * FROM contacts ORDER BY created_at ASC').all()) as any[];
    const activities = (companyIdFilter
      ? db.prepare('SELECT * FROM activities WHERE company_id = ? ORDER BY activity_date ASC, created_at ASC').all(companyIdFilter)
      : db.prepare('SELECT * FROM activities ORDER BY activity_date ASC, created_at ASC').all()) as any[];
    const orders = (companyIdFilter
      ? db.prepare('SELECT * FROM orders WHERE company_id = ? ORDER BY order_date ASC').all(companyIdFilter)
      : db.prepare('SELECT * FROM orders ORDER BY order_date ASC').all()) as any[];

    const headers = [
      'Contacts in chronological order',
      'Company name',
      'Country',
      'Address',
      'website',
      'e-mail address',
      'D-U-N-S Number (if available)',
      'Legal form',
      'Manufacturer / dealer, wholesaler, distributor',
      'Main products manufactured',
      '(Main) industry',
      'Related/affiliated companies',
      'Company size (# employees)',
      'Revenues prior year',
      'Lead Priority (Ahmad)',
      'Name',
      'Job role',
      'How was person contacted',
      'E-Mail address',
      'LinkedIn address?',
      'Telephone number',
      'Main interest in ceramical bearings, reason',
      'Any experiences with ceramic bearings?',
      'Which attempts have been made to solve the existing problem',
      'In which media the bearings are working',
      'Will hybid bearings be an alternative?',
      'First contact (date, time)',
      'Interest in cooperation with us? If not, please give a short explanation, why not.',
      'second contact',
      'Contact from their side',
      'Technical support provided, date',
      'Who provided the tech.support',
      'Quote requested',
      'Quote provided',
      'Samples ordered',
      'Samples delivered',
      'Contacted for clarifying further actions',
      'Order placed, date',
      'Comments',
      // SinterIQ AI fields (appended)
      'Lead Status',
      'Lead Priority (AI)',
      'AI Qualified At',
      'AI Confidence',
      'Approach Strategy (AI)',
      'Opportunity Notes (AI)',
      'Sales Script (AI)',
      'Email Script (AI)',
      'Qualification Notes',
      'Disqualification Category',
      'Disqualification Reason',
      'Disqualified By',
      'Human Reviewed',
    ];

    const timelineActivityTypes = new Set([
      'CALL_MADE',
      'EMAIL_SENT',
      'MEETING_HELD',
      'LINKEDIN_MESSAGE',
      'INBOUND_CONTACT',
      'TECH_SUPPORT',
      'QUOTE_REQUESTED',
      'QUOTE_PROVIDED',
      'SAMPLES_ORDERED',
      'SAMPLES_DELIVERED',
      'CLARIFYING_ACTIONS',
    ]);

    const contactsByCompany = new Map<number, any[]>();
    for (const contact of contacts) {
      const companyContacts = contactsByCompany.get(contact.company_id) || [];
      companyContacts.push(contact);
      contactsByCompany.set(contact.company_id, companyContacts);
    }

    const activitiesByCompany = new Map<number, any[]>();
    const activitiesByContact = new Map<number, any[]>();
    for (const activity of activities) {
      const companyActivities = activitiesByCompany.get(activity.company_id) || [];
      companyActivities.push(activity);
      activitiesByCompany.set(activity.company_id, companyActivities);

      if (activity.contact_id) {
        const contactActivities = activitiesByContact.get(activity.contact_id) || [];
        contactActivities.push(activity);
        activitiesByContact.set(activity.contact_id, contactActivities);
      }
    }

    const ordersByCompany = new Map<number, any[]>();
    const ordersByContact = new Map<number, any[]>();
    for (const order of orders) {
      const companyOrders = ordersByCompany.get(order.company_id) || [];
      companyOrders.push(order);
      ordersByCompany.set(order.company_id, companyOrders);

      if (order.contact_id) {
        const contactOrders = ordersByContact.get(order.contact_id) || [];
        contactOrders.push(order);
        ordersByContact.set(order.contact_id, contactOrders);
      }
    }

    const sortByTimeline = (records: any[], dateField: string, fallbackField: string) =>
      [...records].sort((left, right) => {
        const leftValue = String(left[dateField] || left[fallbackField] || '');
        const rightValue = String(right[dateField] || right[fallbackField] || '');
        return leftValue.localeCompare(rightValue);
      });

    const getActivityDateTime = (activity?: any) =>
      formatExportDateTime(activity?.activity_date || activity?.created_at || '');

    const getFirstMatchingActivity = (activitiesList: any[], activityTypes: string[]) =>
      activitiesList.find((activity) => activityTypes.includes(activity.activity_type));

    const rowEntries = companies.flatMap((company) => {
      const companyContacts = contactsByCompany.get(company.id) || [];
      const companyActivities = sortByTimeline(activitiesByCompany.get(company.id) || [], 'activity_date', 'created_at');
      const companyTimeline = companyActivities.filter((activity) => timelineActivityTypes.has(activity.activity_type));
      const companyOrders = sortByTimeline(ordersByCompany.get(company.id) || [], 'order_date', 'created_at');
      const rowContacts = companyContacts.length > 0 ? companyContacts : [null];

      return rowContacts.map((contact) => {
        const contactActivities = contact
          ? sortByTimeline(activitiesByContact.get(contact.id) || [], 'activity_date', 'created_at')
          : [];
        const scopedTimeline = contactActivities.length > 0
          ? contactActivities.filter((activity) => timelineActivityTypes.has(activity.activity_type))
          : companyContacts.length <= 1
            ? companyTimeline
            : [];
        const firstContact = scopedTimeline[0];
        const secondContact = scopedTimeline[1];
        const inboundContact = getFirstMatchingActivity(scopedTimeline, ['INBOUND_CONTACT']);
        const techSupport = getFirstMatchingActivity(scopedTimeline, ['TECH_SUPPORT']);
        const quoteRequested = getFirstMatchingActivity(scopedTimeline, ['QUOTE_REQUESTED']);
        const quoteProvided = getFirstMatchingActivity(scopedTimeline, ['QUOTE_PROVIDED']);
        const samplesOrdered = getFirstMatchingActivity(scopedTimeline, ['SAMPLES_ORDERED']);
        const samplesDelivered = getFirstMatchingActivity(scopedTimeline, ['SAMPLES_DELIVERED']);
        const clarifyingActions = getFirstMatchingActivity(scopedTimeline, ['CLARIFYING_ACTIONS']);
        const contactOrders = contact ? sortByTimeline(ordersByContact.get(contact.id) || [], 'order_date', 'created_at') : [];
        const selectedOrder = contactOrders[0] || companyOrders[0];

        const address = company.address || [company.city, company.country].filter(Boolean).join(', ');
        const companyEmail = company.company_email || '';
        const businessRole = company.business_role || company.company_type || '';
        const relatedCompanies = company.related_companies || company.corporate_parent || '';
        const employeeCount = company.employee_count ?? '';
        const revenue = company.revenue_eur ?? '';
        const phoneNumber = contact?.phone_direct || contact?.phone_mobile || '';
        const comments = contact?.notes || company.qualification_notes || '';
        const sortValue = String(
          firstContact?.activity_date
          || firstContact?.created_at
          || contact?.created_at
          || company.created_at
          || company.updated_at
          || '',
        );

        return {
          row: [
            '',
            company.company_name || '',
            company.country || '',
            address,
            company.website || '',
            companyEmail,
            company.duns_number || '',
            company.legal_form || '',
            businessRole,
            company.main_products || '',
            company.industry || '',
            relatedCompanies,
            employeeCount,
            revenue,
            company.lead_priority || company.technical_fit || '',
            contact?.full_name || '',
            contact?.job_title || '',
            contact?.contacted_via || '',
            contact?.email || '',
            contact?.linkedin_url || '',
            phoneNumber,
            contact?.interest_reason || '',
            contact?.ceramic_bearing_experience || '',
            contact?.attempted_solution || '',
            contact?.operating_media || '',
            contact?.hybrid_bearing_alternative || '',
            getActivityDateTime(firstContact),
            contact?.cooperation_interest || '',
            getActivityDateTime(secondContact),
            getActivityDateTime(inboundContact),
            getActivityDateTime(techSupport),
            techSupport?.performed_by || '',
            getActivityDateTime(quoteRequested),
            getActivityDateTime(quoteProvided),
            getActivityDateTime(samplesOrdered),
            getActivityDateTime(samplesDelivered),
            getActivityDateTime(clarifyingActions),
            formatExportDateTime(selectedOrder?.order_date || ''),
            comments,
            // SinterIQ AI fields
            company.lead_status || '',
            company.lead_priority || '',
            company.ai_qualified_at ? formatExportDateTime(company.ai_qualified_at) : '',
            company.ai_confidence ?? '',
            (company.approach_strategy || '').replace(/[\r\n]+/g, ' '),
            (company.opportunity_notes || '').replace(/[\r\n]+/g, ' '),
            (company.sales_script || '').replace(/[\r\n]+/g, ' '),
            (company.email_script || '').replace(/[\r\n]+/g, ' '),
            (company.qualification_notes || '').replace(/[\r\n]+/g, ' '),
            company.disqualification_category || '',
            (company.disqualification_reason || '').replace(/[\r\n]+/g, ' '),
            company.disqualified_by || '',
            company.human_reviewed ? 'Yes' : 'No',
          ],
          sortValue,
        };
      });
    });

    rowEntries.sort((left, right) => left.sortValue.localeCompare(right.sortValue));
    const rows = rowEntries.map((entry, index) => {
      entry.row[0] = String(index + 1);
      return entry.row;
    });

    res.json({ headers, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build customer tracker export' });
  }
});

app.post('/api/orders', (req, res) => {
  try {
    const { company_id, order_reference, order_date, order_value_eur, product_type, is_hybrid, payment_received, innovista_contribution } = req.body;

    if (!company_id) return res.status(400).json({ error: 'company_id is required' });
    const orderValue = Number(order_value_eur);
    if (!Number.isFinite(orderValue) || orderValue < 0 || orderValue > 1_000_000_000) {
      return res.status(400).json({ error: 'order_value_eur must be a positive number' });
    }

    let commission_rate = null;
    let commission_eur = null;

    if (!is_hybrid) {
      if (orderValue <= 500) commission_rate = 0.10;
      else if (orderValue <= 3000) commission_rate = 0.07;
      else if (orderValue <= 10000) commission_rate = 0.05;
    }

    if (commission_rate !== null) {
      commission_eur = orderValue * commission_rate;
    }

    const info = db.prepare(`
      INSERT INTO orders (company_id, order_reference, order_date, order_value_eur, product_type, is_hybrid, commission_rate, commission_eur, payment_received, innovista_contribution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company_id, order_reference, order_date, orderValue, product_type, is_hybrid ? 1 : 0, commission_rate, commission_eur, payment_received ? 1 : 0, innovista_contribution);
    
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add order' });
  }
});

app.post('/api/research/contacts', llmRateLimiter, async (req, res) => {
  try {
    const { companyName, website } = req.body;
    const websiteContext = await fetchWebsiteContext(website);
    const rawResponse = await generateJsonWithLlm({
      systemPrompt:
        'You are an expert industrial lead researcher. Return only strict JSON. Do not invent contact details. Use empty strings when data is unknown.',
      userPrompt: `
        Find key contacts for the company "${companyName}" with website "${website}".
        Prioritize decision-makers such as CEO, Maintenance Manager, Production Manager, R&D, Procurement, and Operations.

        ${websiteContext ? `Website context:\n${websiteContext}\n` : 'Website context could not be fetched.\n'}

        Return a JSON array of objects with these keys:
        - full_name
        - job_title
        - email
        - phone_direct
        - linkedin_url
      `,
      useWebSearch: true,
    });

    const contacts = parseJsonResponse<any[]>(rawResponse, []);

    // Log to research history
    try {
      db.prepare(
        'INSERT INTO research_history (company_name, website, contacts_found, results_json) VALUES (?, ?, ?, ?)'
      ).run(companyName, website, contacts.length, JSON.stringify(contacts));
    } catch (e) { /* ignore logging errors */ }

    res.json(contacts);
  } catch (err) {
    console.error(err);
    sendApiError(res, err, 'Failed to research contacts');
  }
});

// Research history
app.get('/api/research/history', (req, res) => {
  try {
    const history = db.prepare(
      'SELECT id, company_name, website, contacts_found, saved_to_company_id, saved_to_company_name, created_at FROM research_history ORDER BY created_at DESC LIMIT 50'
    ).all();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch research history' });
  }
});

// Load previous research results
app.get('/api/research/history/:id', (req, res) => {
  try {
    const entry = db.prepare('SELECT * FROM research_history WHERE id = ?').get(req.params.id) as any;
    if (!entry) return res.status(404).json({ error: 'Not found' });
    entry.results = JSON.parse(entry.results_json || '[]');
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch research entry' });
  }
});

// Add contacts to existing company
app.post('/api/research/add-to-company', (req, res) => {
  try {
    const { companyId, contacts, historyId } = req.body;
    if (!companyId || !Array.isArray(contacts)) return res.status(400).json({ error: 'companyId and contacts are required' });

    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const existingContacts = db.prepare('SELECT full_name FROM contacts WHERE company_id = ?').all(companyId) as any[];
    const existingNames = new Set(existingContacts.map((c: any) => c.full_name?.toLowerCase()));

    const insertContact = db.prepare(
      'INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    let added = 0;
    const addContacts = db.transaction(() => {
      for (const contact of contacts) {
        const name = (contact.full_name || '').trim();
        if (!name) continue;
        if (existingNames.has(name.toLowerCase())) continue;
        insertContact.run(companyId, name, contact.job_title || '', contact.email || '', contact.phone_direct || '', contact.linkedin_url || '', 'Added from Lead Research');
        added++;
      }

      // Update research history if provided
      if (historyId) {
        db.prepare('UPDATE research_history SET saved_to_company_id = ?, saved_to_company_name = ? WHERE id = ?')
          .run(companyId, company.company_name, historyId);
      }
    });
    addContacts();

    res.json({ success: true, companyId, added, companyName: company.company_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add contacts to company' });
  }
});

app.post('/api/research/save', (req, res) => {
  try {
    const { companyName, website, contacts, assignedTo, industry, companyType, technicalFit, qualificationNotes } = req.body;

    const normalizedCompanyName = normalizeRequiredString(companyName);
    if (!normalizedCompanyName) {
      return res.status(400).json({ error: 'companyName is required' });
    }

    const matchedCompany = findExistingCompanyForResearch(companyName, website);
    let companyId: number;
    let matchedBy: 'website' | 'company_name' | 'new' = 'new';

    if (matchedCompany) {
      companyId = matchedCompany.company.id;
      matchedBy = matchedCompany.matchedBy;
      db.prepare(`
        UPDATE companies
        SET website = COALESCE(NULLIF(website, ''), ?),
            assigned_to = COALESCE(NULLIF(assigned_to, ''), ?),
            industry = ?,
            company_type = ?,
            technical_fit = COALESCE(technical_fit, ?),
            qualification_notes = COALESCE(NULLIF(qualification_notes, ''), ?),
            tracking_status = CASE
              WHEN tracking_status IS NULL OR tracking_status = '' OR tracking_status = 'PENDING' THEN 'RESEARCHED'
              ELSE tracking_status
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        normalizeOptionalString(website),
        normalizeOptionalString(assignedTo),
        normalizeRequiredString(industry) || 'Unknown',
        normalizeRequiredString(companyType) || 'Unknown',
        normalizeTechnicalFit(technicalFit),
        normalizeOptionalString(qualificationNotes),
        companyId,
      );
    } else {
      const info = db.prepare(`
        INSERT INTO companies (company_name, website, country, industry, company_type, lead_status, source, assigned_to, technical_fit, qualification_notes, tracking_level, tracking_status)
        VALUES (?, ?, 'Unknown', ?, ?, 'RAW', 'AI_RESEARCH', ?, ?, ?, 'WATCHLIST', 'RESEARCHED')
      `).run(
        normalizedCompanyName,
        normalizeOptionalString(website),
        normalizeRequiredString(industry) || 'Unknown',
        normalizeRequiredString(companyType) || 'Unknown',
        normalizeOptionalString(assignedTo),
        normalizeTechnicalFit(technicalFit),
        normalizeOptionalString(qualificationNotes),
      );
      companyId = Number(info.lastInsertRowid);
    }

    const insertContact = db.prepare(`
      INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateContact = db.prepare(`
      UPDATE contacts
      SET full_name = ?,
          job_title = ?,
          email = ?,
          phone_direct = ?,
          linkedin_url = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const insertActivity = db.prepare(`
      INSERT INTO activities (company_id, activity_type, activity_date, performed_by, subject, details, outcome)
      VALUES (?, 'IMPORT', ?, 'System', 'AI Research Import', ?, 'NEUTRAL')
    `);

    let insertedContacts = 0;
    let updatedContacts = 0;

    db.transaction(() => {
      const existingContacts = db.prepare(`
        SELECT id, full_name, job_title, email, phone_direct, linkedin_url
        FROM contacts
        WHERE company_id = ?
      `).all(companyId) as Array<{
        email: string | null;
        full_name: string;
        id: number;
        job_title: string | null;
        linkedin_url: string | null;
        phone_direct: string | null;
      }>;

      for (const contact of Array.isArray(contacts) ? contacts : []) {
        const fullName = normalizeRequiredString(contact.full_name) || 'Unknown';
        const jobTitle = normalizeOptionalString(contact.job_title) || '';
        const email = normalizeOptionalString(contact.email) || '';
        const phoneDirect = normalizeOptionalString(contact.phone_direct) || '';
        const linkedInUrl = normalizeOptionalString(contact.linkedin_url) || '';

        const matchingContact = existingContacts.find((existingContact) => {
          if (email && normalizeComparableValue(existingContact.email) === email.toLowerCase()) {
            return true;
          }

          if (linkedInUrl && normalizeComparableValue(existingContact.linkedin_url) === linkedInUrl.toLowerCase()) {
            return true;
          }

          return (
            normalizeComparableValue(existingContact.full_name) === fullName.toLowerCase()
            && normalizeComparableValue(existingContact.job_title) === jobTitle.toLowerCase()
          );
        });

        if (matchingContact) {
          updateContact.run(
            matchingContact.full_name || fullName,
            matchingContact.job_title || jobTitle,
            matchingContact.email || email,
            matchingContact.phone_direct || phoneDirect,
            matchingContact.linkedin_url || linkedInUrl,
            matchingContact.id,
          );
          updatedContacts += 1;
          continue;
        }

        const result = insertContact.run(companyId, fullName, jobTitle, email, phoneDirect, linkedInUrl);
        existingContacts.push({
          id: Number(result.lastInsertRowid),
          full_name: fullName,
          job_title: jobTitle,
          email,
          phone_direct: phoneDirect,
          linkedin_url: linkedInUrl,
        });
        insertedContacts += 1;
      }

      insertActivity.run(
        companyId,
        new Date().toISOString().split('T')[0],
        `AI research merged ${insertedContacts} new contacts and updated ${updatedContacts} existing contacts via ${matchedBy}`,
      );
    })();

    // Update most recent research history entry for this company
    try {
      const companyObj = db.prepare('SELECT company_name FROM companies WHERE id = ?').get(companyId) as any;
      db.prepare(
        `UPDATE research_history SET saved_to_company_id = ?, saved_to_company_name = ?
         WHERE id = (SELECT id FROM research_history WHERE company_name = ? ORDER BY created_at DESC LIMIT 1)`
      ).run(companyId, companyObj?.company_name || normalizedCompanyName, normalizedCompanyName);
    } catch (e) { /* ignore */ }

    res.json({ success: true, companyId, insertedContacts, matchedBy, updatedContacts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save research data' });
  }
});

app.post('/api/companies/:id/ai-qualify', llmRateLimiter, async (req, res) => {
  try {
    const companyId = req.params.id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const force = req.query.force === 'true' || req.body?.force === true;
    const skipPrefilter = req.query.skip_prefilter === 'true' || req.body?.skip_prefilter === true;

    if (!force && company.ai_qualified_at) {
      const daysSince = (Date.now() - new Date(company.ai_qualified_at).getTime()) / 86400000;
      if (daysSince < AI_REQUALIFY_GUARD_DAYS) {
        return res.json({ ...company, skipped: true, skipReason: `Qualified ${Math.round(daysSince)}d ago — pass force=true to re-run.` });
      }
    }

    if (aiQualifyInProgress.has(String(companyId))) {
      return res.status(409).json({ error: 'This company is already being qualified — please wait for it to finish.' });
    }
    aiQualifyInProgress.add(String(companyId));

    // Two-pass: cheap pre-classifier first. If it strongly says NOT_A_TARGET, skip the deep prompt.
    if (!skipPrefilter) {
      const localPreCheck = localPreClassifyLead(company);
      if (localPreCheck && localPreCheck.verdict === 'LIKELY_NOT_TARGET' && (localPreCheck.confidence || 0) >= PREFILTER_CONFIDENCE_THRESHOLD) {
        const reason = localPreCheck.reason || 'Local pre-filter identified this as not a target';
        db.prepare(`
          UPDATE companies
          SET lead_score = 0,
              technical_fit = 'NOT_FIT',
              qualification_notes = ?,
              lead_status = 'DISQUALIFIED',
              lead_priority = 'NOT_A_TARGET',
              ai_confidence = ?,
              ai_qualified_at = CURRENT_TIMESTAMP,
              disqualification_reason = ?,
              disqualification_category = ?,
              disqualified_by = 'SinterIQ Local Prefilter',
              disqualified_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          `[Local pre-filter ${localPreCheck.confidence}% confidence] ${reason}`,
          normalizeNullableNumber(localPreCheck.confidence),
          reason,
          localPreCheck.category || 'LOW_FIT',
          companyId,
        );
        const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Record<string, unknown>;
        console.log(`AI Qualify (local SHORT-CIRCUIT) ${company.company_name}: ${localPreCheck.category} @ ${localPreCheck.confidence}%`);
        return res.json({ ...updated, prefiltered: true, local_prefiltered: true });
      }

      const previewContext = await fetchWebsiteContext(company.website, { paths: [''], perPageCap: 800, totalCap: 800 });
      const preCheck = await preClassifyLead(company, previewContext);
      if (preCheck && preCheck.verdict === 'LIKELY_NOT_TARGET' && (preCheck.confidence || 0) >= PREFILTER_CONFIDENCE_THRESHOLD) {
        const reason = preCheck.reason || 'Pre-classifier filtered as not a target';
        db.prepare(`
          UPDATE companies
          SET lead_score = 0,
              technical_fit = 'NOT_FIT',
              qualification_notes = ?,
              lead_status = 'DISQUALIFIED',
              lead_priority = 'NOT_A_TARGET',
              ai_confidence = ?,
              ai_qualified_at = CURRENT_TIMESTAMP,
              disqualification_reason = ?,
              disqualification_category = ?,
              disqualified_by = 'AI Pre-classifier',
              disqualified_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          `[Pre-classified ${preCheck.confidence}% confidence] ${reason}`,
          normalizeNullableNumber(preCheck.confidence),
          reason,
          preCheck.category || 'LOW_FIT',
          companyId,
        );
        const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Record<string, unknown>;
        console.log(`AI Qualify (pre-filter SHORT-CIRCUIT) ${company.company_name}: ${preCheck.category} @ ${preCheck.confidence}%`);
        return res.json({ ...updated, prefiltered: true });
      }
    }

    const websiteContext = await fetchWebsiteContext(company.website);

    const existingContacts = db.prepare(
      'SELECT full_name, job_title, email, linkedin_url FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 10'
    ).all(companyId) as Array<{ full_name: string; job_title?: string; email?: string; linkedin_url?: string }>;

    const recentActivities = db.prepare(
      'SELECT activity_type, activity_date, subject, outcome FROM activities WHERE company_id = ? ORDER BY activity_date DESC LIMIT 5'
    ).all(companyId) as Array<{ activity_type: string; activity_date: string; subject?: string; outcome?: string }>;

    const contactsBlock = existingContacts.length > 0
      ? `\nEXISTING CONTACTS ON FILE (do NOT duplicate these — find ADDITIONAL decision makers only):\n${existingContacts.map((contact) => `- ${contact.full_name}${contact.job_title ? ` — ${contact.job_title}` : ''}${contact.email ? ` <${contact.email}>` : ''}`).join('\n')}\n`
      : '';

    const activitiesBlock = recentActivities.length > 0
      ? `\nRECENT ACTIVITY TIMELINE (use to tune approach_strategy — don't repeat completed outreach):\n${recentActivities.map((activity) => `- ${String(activity.activity_date).slice(0, 10)}: ${activity.activity_type}${activity.subject ? ` — ${activity.subject}` : ''}${activity.outcome ? ` [${activity.outcome}]` : ''}`).join('\n')}\n`
      : '';

    const rawResponse = await generateJsonWithLlm({
      systemPrompt: QUALIFY_SYSTEM_PROMPT,
      userPrompt: buildQualifyUserPrompt(company, contactsBlock, activitiesBlock, websiteContext),
      useWebSearch: true,
    });
    // (AI-qualify prompt now lives in aiPrompts.ts → QUALIFY_SYSTEM_PROMPT / buildQualifyUserPrompt)

    const result = parseJsonResponse<{
      score?: number;
      confidence?: number;
      buying_probability?: number;
      technical_fit?: string;
      product_fit?: string;
      category?: string;
      lead_priority?: string;
      city?: string;
      country?: string;
      website?: string;
      employee_count?: number;
      website_score?: number;
      social_score?: number;
      social_media_active?: boolean;
      social_media_urls?: string[];
      mentions_technology?: boolean;
      reasoning?: string;
      opportunity_notes?: string;
      approach_strategy?: string;
      sales_script?: string;
      email_script?: string;
      social_profiles?: Array<{ platform?: string; url?: string; followers?: string; lastActive?: string; lastPost?: string }>;
      key_contacts?: Array<{ fullName?: string; jobTitle?: string; email?: string; phone?: string; linkedinUrl?: string }>;
    }>(rawResponse, {});

    console.log(`AI Qualify for ${company.company_name}: raw response length=${rawResponse.length}, parsed score=${result.score}, category=${result.category}`);
    if (!result.score && !result.category) {
      console.log('AI Qualify raw response (first 1000 chars):', rawResponse.substring(0, 1000));
    }

    // Map category to lead_status
    let newStatus = 'QUALIFIED';
    if (result.category === 'NO_FIT') newStatus = 'DISQUALIFIED';
    if (result.category === 'LOW_FIT') newStatus = 'ENRICHED';
    if (result.category === 'STRATEGIC_PARTNER') newStatus = 'APPROVED';
    const technicalFit = result.technical_fit === 'NO_FIT' ? 'NOT_FIT' : (result.technical_fit || null);

    // Build dynamic SET clause — update website, employee_count & city only if currently empty
    const websiteUpdate = !company.website && result.website ? result.website : null;
    const employeeUpdate = !company.employee_count && result.employee_count ? result.employee_count : null;
    const cityUpdate = !company.city && result.city ? result.city : null;
    // Backfill country when missing or the import placeholder 'Unknown' — never overwrite a real value.
    const countryUpdate = (!company.country || company.country === 'Unknown') && result.country ? result.country : null;

    const applyQualification = db.transaction(() => {
    db.prepare(`
      UPDATE companies
      SET lead_score = ?, technical_fit = ?, qualification_notes = ?, lead_status = ?,
          product_fit = ?, social_media_urls = ?, social_media_active = ?, mentions_technology = ?,
          website_score = ?, social_score = ?, buying_probability = ?,
          approach_strategy = ?, sales_script = ?, email_script = ?, opportunity_notes = ?,
          social_profiles_json = ?, lead_priority = ?, ai_confidence = ?,
          ${websiteUpdate ? 'website = ?,' : ''}
          ${employeeUpdate ? 'employee_count = ?,' : ''}
          ${cityUpdate ? 'city = ?,' : ''}
          ${countryUpdate ? 'country = ?,' : ''}
          ai_qualified_at = CURRENT_TIMESTAMP,
          tracking_status = CASE
            WHEN ? IN ('APPROVED', 'QUALIFIED') THEN 'QUALIFIED'
            ELSE tracking_status
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      ...[
        normalizeNullableNumber(result.score) || 0,
        technicalFit,
        normalizeOptionalString(result.reasoning),
        newStatus,
        normalizeOptionalString(result.product_fit),
        JSON.stringify(Array.isArray(result.social_media_urls) ? result.social_media_urls : []),
        result.social_media_active ? 1 : 0,
        result.mentions_technology ? 1 : 0,
        normalizeNullableNumber(result.website_score),
        normalizeNullableNumber(result.social_score),
        normalizeNullableNumber(result.buying_probability),
        normalizeOptionalString(result.approach_strategy),
        normalizeOptionalString(result.sales_script),
        normalizeOptionalString(result.email_script),
        normalizeOptionalString(result.opportunity_notes),
        JSON.stringify(Array.isArray(result.social_profiles) ? result.social_profiles : []),
        normalizeOptionalString(result.lead_priority),
        normalizeNullableNumber(result.confidence),
        ...(websiteUpdate ? [websiteUpdate] : []),
        ...(employeeUpdate ? [employeeUpdate] : []),
        ...(cityUpdate ? [cityUpdate] : []),
        ...(countryUpdate ? [countryUpdate] : []),
        newStatus,
        companyId,
      ]
    );

    // Auto-add discovered key contacts
    if (Array.isArray(result.key_contacts) && result.key_contacts.length > 0) {
      const existingContacts = db.prepare('SELECT full_name FROM contacts WHERE company_id = ?').all(companyId) as any[];
      const existingNames = new Set(existingContacts.map((c: any) => c.full_name?.toLowerCase()));
      const insertContact = db.prepare(
        'INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      let added = 0;
      for (const contact of result.key_contacts) {
        if (!contact.fullName?.trim()) continue;
        if (existingNames.has(contact.fullName.trim().toLowerCase())) continue;
        insertContact.run(
          companyId,
          contact.fullName.trim(),
          contact.jobTitle || '',
          contact.email || '',
          contact.phone || '',
          contact.linkedinUrl || '',
          'Added by AI Qualify'
        );
        added++;
      }
      if (added > 0) {
        console.log(`AI Qualify: Added ${added} new contacts for company ${companyId}`);
      }
    }
    });
    applyQualification();

    const updatedCompany = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updatedCompany);
  } catch (error) {
    console.error(`AI Qualification error for company ${req.params.id}:`, error instanceof Error ? error.stack : error);
    sendApiError(res, error, 'AI qualification failed');
  } finally {
    aiQualifyInProgress.delete(String(req.params.id));
  }
});

// Update social profiles (edit URLs, add/remove profiles)
app.put('/api/companies/:id/social-profiles', (req, res) => {
  try {
    const companyId = req.params.id;
    const { profiles } = req.body;
    if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles array required' });

    // Update social_profiles_json and social_media_urls
    const urls = profiles.map((p: any) => p.url).filter(Boolean);
    db.prepare(`
      UPDATE companies SET social_profiles_json = ?, social_media_urls = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(JSON.stringify(profiles), JSON.stringify(urls), companyId);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update social profiles' });
  }
});

type ImportCompanyMatch = {
  company_name: string;
  id: number;
  matchedBy: 'website' | 'name' | 'fuzzy_name';
  source: 'database' | 'upload';
};

function buildCompanyMatchCache() {
  const rows = db.prepare(`
    SELECT id, company_name, company_name_key, website_key
    FROM companies
    WHERE company_name_key IS NOT NULL OR website_key IS NOT NULL
  `).all() as Array<{ id: number; company_name: string; company_name_key: string | null; website_key: string | null }>;

  const websiteMap = new Map<string, ImportCompanyMatch>();
  const nameMap = new Map<string, ImportCompanyMatch>();
  const candidates: Array<{ company_name: string; company_name_key: string; id: number; source: 'database' | 'upload' }> = [];

  const add = (row: { company_name: string; company_name_key?: string | null; id: number; source?: 'database' | 'upload'; website_key?: string | null }) => {
    const source = row.source || 'database';
    if (row.website_key && !websiteMap.has(row.website_key)) {
      websiteMap.set(row.website_key, { id: row.id, company_name: row.company_name, matchedBy: 'website', source });
    }
    if (row.company_name_key) {
      if (!nameMap.has(row.company_name_key)) {
        nameMap.set(row.company_name_key, { id: row.id, company_name: row.company_name, matchedBy: 'name', source });
      }
      candidates.push({ id: row.id, company_name: row.company_name, company_name_key: row.company_name_key, source });
    }
  };

  for (const row of rows) add(row);

  const find = (name: unknown, website: unknown): ImportCompanyMatch | null => {
    const normalizedWebsiteHost = normalizeWebsiteHost(website);
    const normalizedName = normalizeCompanyNameForMatch(name);

    if (normalizedWebsiteHost) {
      const websiteMatch = websiteMap.get(normalizedWebsiteHost);
      if (websiteMatch) return websiteMatch;
    }
    if (!normalizedName) return null;

    const exactNameMatch = nameMap.get(normalizedName);
    if (exactNameMatch) return exactNameMatch;

    const threshold = normalizedName.length < 8 ? FUZZY_THRESHOLD_SHORT : FUZZY_THRESHOLD_LONG;
    const compactInput = normalizedName.replace(/\s+/g, '');
    const compactInputStripped = stripCompactLegalSuffix(compactInput);

    let bestMatch: ImportCompanyMatch & { similarity: number } | null = null;
    for (const c of candidates) {
      const compactCandidate = c.company_name_key.replace(/\s+/g, '');
      const compactCandidateStripped = stripCompactLegalSuffix(compactCandidate);
      const sim = Math.max(
        nameSimilarity(normalizedName, c.company_name_key),
        nameSimilarity(compactInput, compactCandidate),
        nameSimilarity(compactInputStripped, compactCandidateStripped),
        nameSimilarity(compactInputStripped, compactCandidate),
        nameSimilarity(compactInput, compactCandidateStripped),
      );
      if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = {
          id: c.id,
          company_name: c.company_name,
          matchedBy: 'fuzzy_name',
          source: c.source,
          similarity: sim,
        };
      }
    }
    return bestMatch;
  };

  return { add, find };
}

function stripCompactLegalSuffix(value: string) {
  return ['gmbh', 'mbh', 'ag', 'kg', 'co', 'ltd', 'inc', 'llc'].reduce((acc, suffix) => {
    if (acc.endsWith(suffix) && acc.length > suffix.length + 2) return acc.slice(0, -suffix.length);
    return acc;
  }, value);
}

function importString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (value !== null && value !== undefined && String(value).trim() && String(value).trim().toUpperCase() !== 'N/A') {
      return String(value).trim();
    }
  }
  return '';
}

function parseImportInteger(value: unknown) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const parsed = Number(normalized.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function parseImportRevenue(value: unknown) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const text = normalized.replace(/[€$£,\s]/g, '').toLowerCase();
  const match = text.match(/([\d.]+)(bn|b|mio|million|m|k)?/);
  if (!match) return null;
  let amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = match[2] || '';
  if (suffix === 'bn' || suffix === 'b') amount *= 1_000_000_000;
  else if (suffix === 'mio' || suffix === 'million' || suffix === 'm') amount *= 1_000_000;
  else if (suffix === 'k') amount *= 1_000;
  return amount;
}

function inferRegion(country: string) {
  const value = country.trim().toLowerCase();
  if (['uae', 'united arab emirates', 'ae', 'saudi arabia', 'qatar', 'oman', 'bahrain', 'kuwait'].includes(value)) return 'GCC';
  if (['de', 'germany', 'deutschland', 'austria', 'switzerland', 'ch', 'at'].includes(value)) return 'DACH';
  if (['united kingdom', 'uk', 'ireland', 'gb'].includes(value)) return 'UK_IE';
  return 'Unknown';
}

function extractCityFromAddress(address: string) {
  const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

function normalizeImportedContacts(data: Record<string, unknown>) {
  const contacts: Array<{ email: string; full_name: string; job_title: string; linkedin_url: string; phone_direct: string }> = [];
  const rawContacts = Array.isArray((data as any)._contacts) ? (data as any)._contacts : [];

  for (const contact of rawContacts) {
    if (!contact || typeof contact !== 'object') continue;
    const fullName = normalizeOptionalString((contact as any).full_name);
    if (!fullName) continue;
    contacts.push({
      full_name: fullName,
      job_title: normalizeOptionalString((contact as any).job_title) || '',
      email: normalizeOptionalString((contact as any).email) || '',
      phone_direct: normalizeOptionalString((contact as any).phone_direct) || '',
      linkedin_url: normalizeOptionalString((contact as any).linkedin_url) || '',
    });
  }

  const firstName = importString(data, ['First Name']);
  const lastName = importString(data, ['Last Name']);
  const flatName = importString(data, ['Contact Name', 'Contact Full Name', 'Full Name', 'Name']) || `${firstName} ${lastName}`.trim();
  if (flatName) {
    contacts.push({
      full_name: flatName,
      job_title: importString(data, ['Contact Job Title', 'Job Title', 'Title', 'Position']),
      email: importString(data, ['Contact Email', 'Email', 'Email Address']),
      phone_direct: importString(data, ['Phone (Main)', 'Contact Phone', 'Phone', 'Telephone']),
      linkedin_url: importString(data, ['Contact, Phone, LinkedIn,', 'LinkedIn URL', 'Person Linkedin Url', 'Profile URL']),
    });
  }

  const seen = new Set<string>();
  return contacts.filter((contact) => {
    const key = contactIdentityKey(contact);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contactIdentityKey(contact: { email?: string; full_name?: string; job_title?: string; linkedin_url?: string }) {
  const email = normalizeOptionalString(contact.email)?.toLowerCase();
  if (email) return `email:${email}`;
  const linkedin = normalizeOptionalString(contact.linkedin_url)?.toLowerCase().replace(/\/+$/, '');
  if (linkedin) return `linkedin:${linkedin}`;
  const name = normalizeCompanyNameForMatch(contact.full_name);
  if (!name) return '';
  return `name:${name}|${normalizeComparableValue(contact.job_title)}`;
}

function normalizeImportCompany(data: Record<string, unknown>) {
  const companyName = importString(data, ['Company Name', 'Trade Name', 'Company', 'Account Name']);
  const country = importString(data, ['Country/Territory', 'Country', 'Geography', 'Company HQ Country']) || 'Unknown';
  const address = importString(data, ['Address', 'Street Address', 'Company Address']);
  const city = importString(data, ['City', 'Company HQ City']) || extractCityFromAddress(address);
  const region = importString(data, ['Region']) || inferRegion(country);
  const industry = importString(data, ['Primary Industry', 'Industry']) || 'Unknown';
  const companyType = importString(data, ['Type of Activity', 'Company Type', 'Type', 'Business Role']) || 'Unknown';
  const website = importString(data, ['Web Address', 'Website', 'Company Website', 'URL']);
  const notes = importString(data, ['Notes', 'Qualification Notes']);

  return {
    address,
    city,
    companyName,
    companyType,
    contacts: normalizeImportedContacts(data),
    corporateParent: importString(data, ['Global Ultimate Parent', 'Corporate Family', 'Corporate Parent', 'Parent Company']),
    country,
    dunsNumber: importString(data, ['D-U-N-S Number', 'DUNS', 'Duns Number']),
    employeeCount: parseImportInteger(importString(data, ['Number of Employees (Single Site)', 'Employee Count', 'Employees', 'Company Headcount', '# Employees'])),
    industry,
    notes,
    region,
    revenue: parseImportRevenue(importString(data, ['Revenue', 'Sales', 'Annual Revenue'])),
    website,
  };
}

app.post('/api/companies/import', (req, res) => {
  try {
    const companies = Array.isArray(req.body?.companies) ? req.body.companies : null;
    if (!companies) {
      return res.status(400).json({ error: 'companies must be an array' });
    }
    if (companies.length > 10000) {
      return res.status(400).json({ error: 'Import limit is 10,000 rows per upload' });
    }
    
    const insertCompany = db.prepare(`
      INSERT INTO companies (
        company_name, country, address, city, region, industry, company_type,
        employee_count, revenue_eur, website, duns_number, corporate_parent,
        source, lead_status, qualification_notes, company_name_key, website_key, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertContact = db.prepare(`
      INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateExistingCompany = db.prepare(`
      UPDATE companies SET
        employee_count = COALESCE(?, employee_count),
        revenue_eur = COALESCE(?, revenue_eur),
        website = COALESCE(NULLIF(?, ''), website),
        website_key = COALESCE(NULLIF(?, ''), website_key),
        duns_number = COALESCE(NULLIF(?, ''), duns_number),
        corporate_parent = COALESCE(NULLIF(?, ''), corporate_parent),
        address = COALESCE(NULLIF(?, ''), address),
        city = COALESCE(NULLIF(?, ''), city),
        region = COALESCE(NULLIF(?, ''), region),
        industry = CASE WHEN COALESCE(industry, '') IN ('', 'Unknown') THEN COALESCE(NULLIF(?, ''), industry) ELSE industry END,
        company_type = CASE WHEN COALESCE(company_type, '') IN ('', 'Unknown') THEN COALESCE(NULLIF(?, ''), company_type) ELSE company_type END,
        qualification_notes = CASE
          WHEN COALESCE(qualification_notes, '') = '' THEN COALESCE(NULLIF(?, ''), qualification_notes)
          ELSE qualification_notes
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const selectContactKeys = db.prepare('SELECT full_name, job_title, email, linkedin_url FROM contacts WHERE company_id = ?');
    const contactKeysByCompany = new Map<number, Set<string>>();
    const getContactKeys = (companyId: number) => {
      let keys = contactKeysByCompany.get(companyId);
      if (!keys) {
        keys = new Set(
          (selectContactKeys.all(companyId) as Array<{ email: string; full_name: string; job_title: string; linkedin_url: string }>)
            .map(contactIdentityKey)
            .filter(Boolean),
        );
        contactKeysByCompany.set(companyId, keys);
      }
      return keys;
    };

    const matchCache = buildCompanyMatchCache();
    const source = normalizeOptionalString(req.body?.source) || 'DNB_HOOVERS';
    const importer = getRequestUser(req);
    const results: any[] = [];
    const errors: Array<{ error: string; row: number }> = [];
    let skipped = 0;
    let contactsCreated = 0;

    db.transaction(() => {
      for (let index = 0; index < companies.length; index++) {
        try {
          const rawRow = companies[index];
          if (!rawRow || typeof rawRow !== 'object') {
            skipped++;
            continue;
          }

          const data = normalizeImportCompany(rawRow as Record<string, unknown>);
          if (!data.companyName) {
            skipped++;
            continue;
          }

          const existing = matchCache.find(data.companyName, data.website);
          let companyId: number;
          if (existing) {
            companyId = existing.id;
            updateExistingCompany.run(
              data.employeeCount,
              data.revenue,
              data.website,
              normalizeWebsiteHost(data.website),
              data.dunsNumber,
              data.corporateParent,
              data.address,
              data.city,
              data.region,
              data.industry,
              data.companyType,
              data.notes,
              companyId,
            );
            results.push({
              id: companyId,
              name: data.companyName,
              action: 'merged',
              matched_by: existing.matchedBy,
              matched_existing: existing.company_name,
              within_upload: existing.source === 'upload',
            });
          } else {
            const companyNameKey = normalizeCompanyNameForMatch(data.companyName);
            const websiteKey = normalizeWebsiteHost(data.website);
            const info = insertCompany.run(
              data.companyName,
              data.country,
              data.address,
              data.city,
              data.region,
              data.industry,
              data.companyType,
              data.employeeCount,
              data.revenue,
              data.website,
              data.dunsNumber,
              data.corporateParent,
              source,
              'RAW',
              data.notes,
              companyNameKey,
              websiteKey,
              importer,
            );
            companyId = Number(info.lastInsertRowid);
            matchCache.add({
              id: companyId,
              company_name: data.companyName,
              company_name_key: companyNameKey,
              website_key: websiteKey,
              source: 'upload',
            });
            results.push({ id: companyId, name: data.companyName, action: 'created' });
          }

          const contactKeys = getContactKeys(companyId);
          for (const contact of data.contacts) {
            const key = contactIdentityKey(contact);
            if (!key || contactKeys.has(key)) continue;
            insertContact.run(
              companyId,
              contact.full_name,
              contact.job_title,
              contact.email,
              contact.phone_direct,
              contact.linkedin_url,
              data.notes,
            );
            contactKeys.add(key);
            contactsCreated++;
          }
        } catch (error) {
          errors.push({
            row: index + 1,
            error: error instanceof Error ? error.message : 'Unknown import error',
          });
        }
      }
    })();

    const created = results.filter((r) => r.action === 'created').length;
    const merged = results.filter((r) => r.action === 'merged').length;
    const duplicateRows = results.filter((r) => r.within_upload).length;
    res.json({
      success: errors.length === 0,
      partial: errors.length > 0,
      total: companies.length,
      processed: results.length,
      created,
      merged,
      skipped,
      duplicate_rows: duplicateRows,
      contacts_created: contactsCreated,
      failed: errors.length,
      errors: errors.slice(0, 25),
      imported: results.length,
      companies: results.slice(0, 500),
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

// Seed sample data if empty
const count = db.prepare('SELECT COUNT(*) as count FROM companies').get() as { count: number };
if (count.count === 0) {
  const insertCompany = db.prepare(`
    INSERT INTO companies (company_name, country, city, region, industry, company_type, employee_count, revenue_eur, website, qualification_notes, lead_status, technical_fit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertCompany.run("Blässinger Wälzlager GmbH", "DE", "Stuttgart", "DACH", "BEARING_TRADER", "BEARING_TRADER", 45, 8000000, "https://www.blaessinger.de", "20+ year Sintertechnik client (Jochen reference). Bearing trader — buys + sells, needs ST technical expertise.", "QUALIFIED", "HIGH");
  insertCompany.run("Ludwig Meister GmbH & Co. KG", "DE", "Dachau", "DACH", "BEARING_TRADER", "BEARING_TRADER", 250, 50000000, "https://www.ludwigmeister.de", "20+ year Sintertechnik client (Jochen reference). Major bearing distributor, daily RFQs.", "QUALIFIED", "HIGH");
  insertCompany.run("Müller Pharmatechnik GmbH", "DE", "Frankfurt", "DACH", "PHARMA", "MANUFACTURER", 120, 25000000, "https://www.example-pharma.de", "Pharmaceutical equipment manufacturer. Cleanroom applications. Likely ceramic bearing candidate.", "RAW", null);
  insertCompany.run("Al Masaood Industrial Group", "AE", "Abu Dhabi", "GCC", "INDUSTRIAL_DIST", "DISTRIBUTOR", 500, 100000000, "https://www.almasaood.com", "Major UAE industrial distributor. Serves oil & gas, manufacturing. Potential multiplier.", "RAW", null);
}

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
