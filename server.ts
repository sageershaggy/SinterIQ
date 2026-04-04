import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';

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

const app = express();
const PORT = 3000;

app.use(express.json());

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

function normalizeCompanyNameForMatch(value: unknown) {
  const normalizedValue = normalizeRequiredString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalizedValue) {
    return '';
  }

  const ignoredTokens = new Set([
    'gmbh',
    'llc',
    'ltd',
    'limited',
    'inc',
    'corp',
    'corporation',
    'co',
    'company',
    'kg',
    'ag',
    'bv',
    'sa',
    'sarl',
    'pte',
    'plc',
    'the',
  ]);

  return normalizedValue
    .split(/\s+/)
    .filter((token) => token && !ignoredTokens.has(token))
    .join(' ');
}

function sendApiError(res: any, error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;

  if (message.includes('LLM_API_KEY') || message.includes('GEMINI_API_KEY')) {
    return res.status(503).json({ error: message });
  }

  return res.status(500).json({ error: message || fallbackMessage });
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
  const storedApiKey = normalizeOptionalString(getSettingValue('llm.api_key'));
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

async function fetchWebsiteContext(value: unknown) {
  const websiteUrl = normalizeWebsiteUrl(value);
  if (!websiteUrl) {
    return null;
  }

  try {
    const response = await fetch(websiteUrl, {
      headers: { 'User-Agent': 'SinterIQ/1.0' },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const text = stripHtmlToText(html).slice(0, 4000);
    return text || null;
  } catch {
    return null;
  }
}

async function generateJsonWithLlm({
  systemPrompt,
  userPrompt,
  useWebSearch,
}: {
  systemPrompt: string;
  userPrompt: string;
  useWebSearch: boolean;
}) {
  const settings = getLlmSettings();
  ensureLlmConfigured(settings);

  if (settings.providerType === 'gemini') {
    const ai = new GoogleGenAI({ apiKey: settings.apiKey! });
    const usingWebSearch = useWebSearch && settings.supportsWebSearch;
    const response = await ai.models.generateContent({
      model: settings.model,
      contents: `${systemPrompt}\n\n${userPrompt}${usingWebSearch ? '\n\nIMPORTANT: Your entire response must be valid JSON only — no markdown, no code fences, no explanation.' : ''}`,
      config: {
        // responseMimeType is incompatible with tool use (googleSearch) — only set it when not using tools
        ...(!usingWebSearch ? { responseMimeType: 'application/json' } : {}),
        ...(usingWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
      },
    });

    return response.text || '';
  }

  const response = await fetch(`${settings.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${userPrompt}\n\nReturn only valid JSON.` },
      ],
    }),
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

function parseJsonResponse<T>(rawText: string, fallbackValue: T) {
  if (!rawText) {
    return fallbackValue;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]) as T;
      } catch {}
    }

    const objectMatch = rawText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch {}
    }
  }

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

// Add new columns to companies if they don't exist
try { db.exec("ALTER TABLE companies ADD COLUMN product_fit TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_media_urls TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_media_active BOOLEAN DEFAULT 0;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN mentions_technology BOOLEAN DEFAULT 0;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN follow_up_date DATETIME;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN tracking_level TEXT DEFAULT 'WATCHLIST';"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN tracking_status TEXT DEFAULT 'PENDING';"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN tracking_notes TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN next_tracking_date DATETIME;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN address TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN company_email TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN legal_form TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN business_role TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN main_products TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN related_companies TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN contacted_via TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN interest_reason TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN ceramic_bearing_experience TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN attempted_solution TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN operating_media TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN hybrid_bearing_alternative TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN cooperation_interest TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN website_score INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_score INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN buying_probability INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN approach_strategy TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN sales_script TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN email_script TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN ai_qualified_at DATETIME;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN opportunity_notes TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_profiles_json TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN lead_priority TEXT;"); } catch (e) {}

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
    const storedApiKey = normalizeOptionalString(getSettingValue('llm.api_key'));

    res.json({
      provider_type: settings.providerType,
      provider_name: settings.providerName,
      model: settings.model,
      base_url: settings.baseUrl || '',
      api_key: storedApiKey || '',
      has_api_key: Boolean(settings.apiKey),
      source: settings.source,
      supports_web_search: settings.supportsWebSearch,
    });
  } catch (error) {
    sendApiError(res, error, 'Failed to load LLM settings');
  }
});

app.put('/api/settings/llm', (req, res) => {
  try {
    const providerType = normalizeOptionalString(req.body.provider_type);
    if (providerType !== 'gemini' && providerType !== 'openai_compatible') {
      return res.status(400).json({ error: 'provider_type must be gemini or openai_compatible' });
    }

    saveSettings({
      'llm.provider_type': providerType,
      'llm.provider_name': normalizeOptionalString(req.body.provider_name) || (providerType === 'gemini' ? 'Gemini' : 'OpenAI-Compatible'),
      'llm.model': normalizeOptionalString(req.body.model) || (providerType === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini'),
      'llm.base_url': providerType === 'openai_compatible'
        ? normalizeOptionalString(req.body.base_url) || 'https://api.openai.com/v1'
        : '',
      'llm.api_key': normalizeOptionalString(req.body.api_key) || '',
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

app.post('/api/users', (req, res) => {
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

app.put('/api/users/:id', (req, res) => {
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

app.get('/api/companies', (req, res) => {
  const companies = db.prepare(`
    SELECT
      c.*,
      COUNT(DISTINCT con.id) as contact_count,
      MIN(CASE WHEN a.follow_up_done = 0 AND a.follow_up_date IS NOT NULL THEN a.follow_up_date END) as follow_up_date
    FROM companies c
    LEFT JOIN contacts con ON c.id = con.company_id
    LEFT JOIN activities a ON c.id = a.company_id
    GROUP BY c.id
    ORDER BY c.updated_at DESC, c.company_name ASC
  `).all();
  res.json(companies);
});

app.post('/api/companies', (req, res) => {
  try {
    const companyName = normalizeRequiredString(req.body.company_name);
    const country = normalizeRequiredString(req.body.country);

    if (!companyName || !country) {
      return res.status(400).json({ error: 'company_name and country are required' });
    }

    const website = normalizeOptionalString(req.body.website);
    const existingByName = db
      .prepare('SELECT id, company_name FROM companies WHERE lower(company_name) = lower(?)')
      .get(companyName) as { id: number; company_name: string } | undefined;
    const existingByWebsite = website ? db
      .prepare('SELECT id, company_name FROM companies WHERE lower(website) = lower(?) OR lower(website) = lower(?)')
      .get(website, website.replace(/^https?:\/\//, '').replace(/\/$/, '')) as { id: number; company_name: string } | undefined : undefined;

    const duplicate = existingByName || existingByWebsite;
    if (duplicate) {
      return res.status(409).json({
        error: `Duplicate found: "${duplicate.company_name}" (ID: ${duplicate.id}). Use merge if these are the same company.`,
        duplicate_id: duplicate.id,
        duplicate_name: duplicate.company_name,
      });
    }

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
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'Sageer A. Shaikh')
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

    db.prepare(`
      UPDATE companies
      SET company_name = ?, website = ?, company_email = ?, country = ?, address = ?, city = ?, region = ?, industry = ?, company_type = ?,
          employee_count = ?, revenue_eur = ?, legal_form = ?, business_role = ?, main_products = ?, related_companies = ?,
          lead_status = ?, technical_fit = ?, lead_priority = ?, assigned_to = ?, qualification_notes = ?, tracking_level = ?, tracking_status = ?, tracking_notes = ?,
          next_tracking_date = ?, duns_number = ?, corporate_parent = ?, is_subsidiary = ?, source = ?,
          created_by = ?, updated_at = CURRENT_TIMESTAMP
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
      normalizeOptionalString(req.body.created_by),
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

    values.push(companyId);
    db.prepare(`UPDATE companies SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updated);
  } catch (err) {
    console.error('Patch company error:', err);
    res.status(500).json({ error: 'Failed to update field' });
  }
});

app.post('/api/contacts/enrich', async (req, res) => {
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
    db.prepare('UPDATE companies SET lead_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
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

app.get('/api/orders', (req, res) => {
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

app.get('/api/export/customer-tracker', (req, res) => {
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
    
    let commission_rate = null;
    let commission_eur = null;
    
    if (!is_hybrid) {
      if (order_value_eur <= 500) commission_rate = 0.10;
      else if (order_value_eur <= 3000) commission_rate = 0.07;
      else if (order_value_eur <= 10000) commission_rate = 0.05;
    }
    
    if (commission_rate !== null) {
      commission_eur = order_value_eur * commission_rate;
    }

    const info = db.prepare(`
      INSERT INTO orders (company_id, order_reference, order_date, order_value_eur, product_type, is_hybrid, commission_rate, commission_eur, payment_received, innovista_contribution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company_id, order_reference, order_date, order_value_eur, product_type, is_hybrid ? 1 : 0, commission_rate, commission_eur, payment_received ? 1 : 0, innovista_contribution);
    
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add order' });
  }
});

app.post('/api/research/contacts', async (req, res) => {
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

app.post('/api/companies/:id/ai-qualify', async (req, res) => {
  try {
    const companyId = req.params.id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const websiteContext = await fetchWebsiteContext(company.website);

    const rawResponse = await generateJsonWithLlm({
      systemPrompt: `You are an expert B2B sales intelligence agent for Sintertechnik GmbH (Germany), a manufacturer of precision ceramic bearings, hybrid bearings, and ceramic components. Your job is to deeply qualify leads and generate actionable sales intelligence. Return only strict JSON with no markdown or code fences.`,
      userPrompt: `
Perform a comprehensive lead qualification and sales intelligence analysis for the following company.

COMPANY DATA:
- Name: ${company.company_name}
- Country: ${company.country}
- City: ${company.city || 'Unknown'}
- Industry: ${company.industry}
- Company Type: ${company.company_type}
- Revenue (EUR): ${company.revenue_eur ? `€${(company.revenue_eur/1000000).toFixed(1)}M` : 'Unknown'}
- Employees: ${company.employee_count || 'Unknown'}
- Website: ${company.website || 'Unknown — search the web to find it'}
- Existing Notes: ${company.qualification_notes || 'None'}

${websiteContext ? `WEBSITE CONTENT SNAPSHOT:\n${websiteContext.substring(0, 2000)}\n` : 'Website could not be fetched — use web search to gather information.\n'}

SINTERTECHNIK PRODUCTS:
- Full ceramic bearings (ZrO2, Si3N4, Al2O3) — ideal for corrosive/hygienic/high-temp environments
- Hybrid ceramic bearings (steel races + ceramic balls) — higher speed, longer life, reduced maintenance
- Ceramic components (shafts, bushings, rollers, seal seats)
- Key applications: pumps, food processing, pharma, chemical, desalination, oil & gas, vacuum, cryogenic, electroplating

RESEARCH TASKS:
1. Search the web for this company — find their website, LinkedIn, social media, recent news
2. Assess their industry fit for ceramic bearings (pump manufacturers, bearing distributors, food/pharma/chemical end-users are top fits)
3. Estimate employee fit (20-2000 employees = ideal addressable range; larger = longer procurement process)
4. Check if they have active social media and recent posts
5. Look for signals: expansion, new facilities, sustainability goals, engineering team presence, bearing mentions

CRITICAL EXCLUSION RULES (apply FIRST, before any scoring):
1. COMPETITORS: If the company manufactures or sells bearings (ball bearings, roller bearings, ceramic bearings, hybrid bearings, precision bearings, spindle bearings) as their PRIMARY product, they are a DIRECT COMPETITOR to Sintertechnik. Mark as NOT_A_TARGET with score 0. Examples: bearing manufacturers, bearing producers with in-house ceramic/hybrid bearing lines.
2. WHOLESALERS / RETAILERS / MAIL-ORDER: If the company is primarily a wholesaler, retailer, or mail-order supplier that does NOT manufacture or engineer products (e.g., dental supply firms, general consumable distributors), they are NOT_A_TARGET with score 0. They lack the proprietary engineering and manufacturing requirements for Sintertechnik's solutions.
3. SUBSIDIARIES OF COMPETITORS: If the company is a subsidiary or brand of a known bearing manufacturer competitor, mark as NOT_A_TARGET.

Note: Bearing TRADERS / DISTRIBUTORS who RESELL bearings (but do not manufacture them) are VALID prospects — they can become sales channel partners. Only exclude companies that MANUFACTURE bearings as competitors.

LEAD PRIORITY CLASSIFICATION (by Ahmad Khan):
Classify the company into one of these four categories based on the criteria below:
- HIGH_PRIORITY: Company size 20–2000 employees, is an OEM/Manufacturer (NOT a bearing manufacturer — they must manufacture OTHER products that USE bearings), operates in extreme environments, has technical/R&D capability, and has industry multiplier potential (one win = large-scale or repeat custom project). These are companies actively manufacturing something using complex machinery where bearings are required repeatedly and in large quantities.
- STRONG: Company size 20–2000, may be manufacturer (of non-bearing products) OR technical distributor/bearing trader, involved in industrial supply. May have some but not all features: extreme operating environment, technical/R&D capability, industry multiplier. Still valuable prospects.
- LOW_PRIORITY: May have some relevance but at a lower level. Manufacturing outside most relevant industries, requiring bearings only occasionally or in smaller quantities. May include small-scale traders with limited relevance.
- NOT_A_TARGET: Competitors (bearing manufacturers), pure service providers, wholesalers/retailers with no manufacturing, no visible production activity, or no relevant industrial requirement. Also includes companies whose core business is producing the same products Sintertechnik sells.

Key features to evaluate:
1. Is this a COMPETITOR? (bearing manufacturer = automatic NOT_A_TARGET)
2. Is this a non-manufacturing wholesaler/retailer? (automatic NOT_A_TARGET)
3. Company Size (20–2000 employees ideal)
4. OEM / Manufacturer status (of products that USE bearings, not MAKE bearings)
5. Bearing Trader / Distributor status (resellers are valid prospects)
6. Extreme Operating Environment (corrosive, high-temp, hygienic, vacuum, cryogenic)
7. Technical / R&D Capability
8. Industry Multiplier (potential for one win to turn into large-scale or repeat custom project)

Return a JSON object with EXACTLY these fields:
{
  "score": <integer 0-100, overall lead quality>,
  "buying_probability": <integer 0-100, likelihood they need ceramic bearings in next 12 months>,
  "technical_fit": <"HIGH" | "MEDIUM" | "LOW" | "NOT_FIT">,
  "product_fit": <"Ceramic Bearings" | "Hybrid Bearings" | "Ceramic Components" | "Multiple Products" | "None">,
  "category": <"STRATEGIC_PARTNER" | "BEARING_CUSTOMER" | "LOW_FIT" | "NO_FIT">,
  "lead_priority": <"HIGH_PRIORITY" | "STRONG" | "LOW_PRIORITY" | "NOT_A_TARGET">,
  "city": <string or null, the city/town where the company headquarters is located — search the web if unknown>,
  "website": <string, the company's main website URL if found — IMPORTANT if company has no website set>,
  "employee_count": <integer or null, estimated employee count if found>,
  "website_score": <integer 0-100, website quality and activity level>,
  "social_score": <integer 0-100, social media presence and activity>,
  "social_media_active": <boolean>,
  "social_media_urls": <array of strings, LinkedIn/Twitter/Facebook/Instagram/YouTube URLs found>,
  "social_profiles": <array of objects with {platform, url, followers, lastActive, lastPost} — for each social media account found. platform is "LinkedIn"/"Facebook"/"Instagram"/"YouTube"/"Twitter/X". followers is a string like "5.2K" or "12,340" or "unknown". lastActive is approximate date string like "March 2026" or "Active" or "unknown". lastPost is a short description of their most recent post or "unknown">,
  "mentions_technology": <boolean, do they mention bearings, ceramics, precision components>,
  "reasoning": <string, 3-5 sentence strategic analysis explaining the score and fit — written for a sales manager>,
  "opportunity_notes": <string, specific opportunities or pain points relevant to ceramic bearings — be specific to their industry>,
  "approach_strategy": <string, 2-3 sentence recommended approach: who to contact, what angle to use, timing>,
  "sales_script": <string, 5-8 bullet talking points for a sales call — specific to this company and industry, mention their applications>,
  "email_script": <string, complete cold outreach email — subject line + body, max 150 words, personalized to this company, mention a specific product application relevant to their industry>,
  "key_contacts": <array of objects with {fullName, jobTitle, email, phone, linkedinUrl} — find 2-5 key decision makers (CEO, procurement, maintenance, engineering) from web/LinkedIn search. Leave fields as empty string if unknown>
}`,
      useWebSearch: true,
    });

    const result = parseJsonResponse<{
      score?: number;
      buying_probability?: number;
      technical_fit?: string;
      product_fit?: string;
      category?: string;
      lead_priority?: string;
      city?: string;
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

    db.prepare(`
      UPDATE companies
      SET lead_score = ?, technical_fit = ?, qualification_notes = ?, lead_status = ?,
          product_fit = ?, social_media_urls = ?, social_media_active = ?, mentions_technology = ?,
          website_score = ?, social_score = ?, buying_probability = ?,
          approach_strategy = ?, sales_script = ?, email_script = ?, opportunity_notes = ?,
          social_profiles_json = ?, lead_priority = ?,
          ${websiteUpdate ? 'website = ?,' : ''}
          ${employeeUpdate ? 'employee_count = ?,' : ''}
          ${cityUpdate ? 'city = ?,' : ''}
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
        ...(websiteUpdate ? [websiteUpdate] : []),
        ...(employeeUpdate ? [employeeUpdate] : []),
        ...(cityUpdate ? [cityUpdate] : []),
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

    const updatedCompany = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updatedCompany);
  } catch (error) {
    console.error('AI Qualification error:', error);
    sendApiError(res, error, 'AI qualification failed');
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

app.post('/api/companies/import', (req, res) => {
  try {
    const { companies } = req.body;
    
    const insertCompany = db.prepare(`
      INSERT INTO companies (company_name, country, city, region, industry, company_type, employee_count, revenue_eur, website, corporate_parent, source, lead_status, qualification_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertContact = db.prepare(`
      INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const results: any[] = [];

    db.transaction(() => {
      for (const data of companies) {
        if (!data['Company Name']) continue;

        // Parse revenue (e.g., "25.31M" -> 25310000)
        let revenue = null;
        if (data.Revenue) {
          const match = String(data.Revenue).match(/([\d.]+)([MBK]?)/i);
          if (match) {
            let val = parseFloat(match[1]);
            if (match[2]?.toUpperCase() === 'M') val *= 1000000;
            if (match[2]?.toUpperCase() === 'B') val *= 1000000000;
            if (match[2]?.toUpperCase() === 'K') val *= 1000;
            revenue = val;
          }
        }

        // Extract city from address if possible
        let city = '';
        if (data.Address) {
          const parts = data.Address.split(',');
          if (parts.length > 1) {
            city = parts[parts.length - 2].trim();
          }
        }

        // Duplicate check by name or website
        const compName = data['Company Name'].trim();
        const compWebsite = (data['Website'] || '').trim();
        const existingByName = db.prepare('SELECT id FROM companies WHERE lower(company_name) = lower(?)').get(compName) as any;
        const existingByWeb = compWebsite
          ? db.prepare('SELECT id FROM companies WHERE lower(website) = lower(?) OR lower(website) = lower(?)').get(compWebsite, compWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '')) as any
          : null;
        const existing = existingByName || existingByWeb;

        let companyId: number;
        if (existing) {
          // Update existing instead of creating duplicate
          companyId = existing.id;
          db.prepare(`
            UPDATE companies SET employee_count = COALESCE(?, employee_count), revenue_eur = COALESCE(?, revenue_eur),
            website = COALESCE(NULLIF(?, ''), website), corporate_parent = COALESCE(NULLIF(?, ''), corporate_parent),
            city = COALESCE(NULLIF(?, ''), city), updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(parseInt(data['Employee Count']) || null, revenue, compWebsite, data['Corporate Family'] || '', city, companyId);
          results.push({ id: companyId, name: compName, action: 'merged' });
        } else {
          const info = insertCompany.run(
            compName,
            data['Country'] || 'Unknown',
            city,
            data['Country'] === 'UAE' ? 'GCC' : 'Unknown',
            data['Industry'] || 'Unknown',
            data['Type of Activity'] || 'Unknown',
            parseInt(data['Employee Count']) || null,
            revenue,
            compWebsite,
            data['Corporate Family'] || '',
            'DNB_HOOVERS',
            'RAW',
            data['Notes'] || ''
          );
          companyId = info.lastInsertRowid as number;
          results.push({ id: companyId, name: compName, action: 'created' });
        }

        if (data['Contact Name'] && data['Contact Name'] !== 'N/A') {
          insertContact.run(
            companyId,
            data['Contact Name'],
            data['Contact Job Title'] || '',
            data['Contact Email'] && data['Contact Email'] !== 'N/A' ? data['Contact Email'] : '',
            data['Phone (Main)'] && data['Phone (Main)'] !== 'N/A' ? data['Phone (Main)'] : '',
            data['Contact, Phone, LinkedIn,'] && data['Contact, Phone, LinkedIn,'] !== 'N/A' ? data['Contact, Phone, LinkedIn,'] : '',
            data['Notes'] || ''
          );
        }
        
        results.push({ id: companyId, name: data['Company Name'] });
      }
    })();

    res.json({ success: true, imported: results.length, companies: results });
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
