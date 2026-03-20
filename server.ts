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
    const response = await ai.models.generateContent({
      model: settings.model,
      contents: `${systemPrompt}\n\n${userPrompt}`,
      config: {
        responseMimeType: 'application/json',
        ...(useWebSearch && settings.supportsWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
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
    city TEXT,
    region TEXT,
    industry TEXT NOT NULL,
    company_type TEXT NOT NULL,
    employee_count INTEGER,
    revenue_eur REAL,
    website TEXT,
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

    const existingCompany = db
      .prepare('SELECT id FROM companies WHERE lower(company_name) = lower(?)')
      .get(companyName) as { id: number } | undefined;

    if (existingCompany) {
      return res.status(409).json({ error: 'A company with this name already exists' });
    }

    const result = db.prepare(`
      INSERT INTO companies (
        company_name,
        website,
        country,
        city,
        region,
        industry,
        company_type,
        employee_count,
        revenue_eur,
        lead_status,
        technical_fit,
        assigned_to,
        qualification_notes,
        tracking_level,
        tracking_status,
        tracking_notes,
        next_tracking_date,
        source,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'Sageer A. Shaikh')
    `).run(
      companyName,
      normalizeOptionalString(req.body.website),
      country,
      normalizeOptionalString(req.body.city),
      normalizeOptionalString(req.body.region),
      normalizeRequiredString(req.body.industry) || 'BEARING_TRADER',
      normalizeRequiredString(req.body.company_type) || 'BEARING_TRADER',
      normalizeNullableNumber(req.body.employee_count),
      normalizeNullableNumber(req.body.revenue_eur),
      normalizeRequiredString(req.body.lead_status) || 'RAW',
      normalizeTechnicalFit(req.body.technical_fit),
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
      SET company_name = ?, website = ?, country = ?, city = ?, region = ?, industry = ?, company_type = ?, employee_count = ?, revenue_eur = ?, lead_status = ?, technical_fit = ?, assigned_to = ?, qualification_notes = ?, tracking_level = ?, tracking_status = ?, tracking_notes = ?, next_tracking_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      companyName,
      normalizeOptionalString(req.body.website),
      country,
      normalizeOptionalString(req.body.city),
      normalizeOptionalString(req.body.region),
      normalizeRequiredString(req.body.industry) || 'BEARING_TRADER',
      normalizeRequiredString(req.body.company_type) || 'BEARING_TRADER',
      normalizeNullableNumber(req.body.employee_count),
      normalizeNullableNumber(req.body.revenue_eur),
      normalizeRequiredString(req.body.lead_status) || 'RAW',
      normalizeTechnicalFit(req.body.technical_fit),
      normalizeOptionalString(req.body.assigned_to),
      normalizeOptionalString(req.body.qualification_notes),
      normalizeTrackingLevel(req.body.tracking_level),
      normalizeTrackingStatus(req.body.tracking_status),
      normalizeOptionalString(req.body.tracking_notes),
      normalizeOptionalString(req.body.next_tracking_date),
      req.params.id,
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update company' });
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
    const { company_id, full_name, job_title, email, phone_direct, linkedin_url, notes, is_verified, verification_source } = req.body;
    const verified_date = is_verified ? new Date().toISOString() : null;
    const info = db.prepare(`
      INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url, notes, is_verified, verification_source, verified_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company_id, full_name, job_title, email, phone_direct, linkedin_url, notes, is_verified ? 1 : 0, verification_source, verified_date);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

app.put('/api/contacts/:id', (req, res) => {
  try {
    const { full_name, job_title, email, phone_direct, linkedin_url, notes, is_verified, verification_source } = req.body;
    
    const currentContact = db.prepare('SELECT is_verified, verified_date FROM contacts WHERE id = ?').get(req.params.id) as any;
    let verified_date = currentContact?.verified_date;
    if (is_verified && !currentContact?.is_verified) {
      verified_date = new Date().toISOString();
    } else if (!is_verified) {
      verified_date = null;
    }

    db.prepare(`
      UPDATE contacts 
      SET full_name = ?, job_title = ?, email = ?, phone_direct = ?, linkedin_url = ?, notes = ?, is_verified = ?, verification_source = ?, verified_date = ?
      WHERE id = ?
    `).run(full_name, job_title, email, phone_direct, linkedin_url, notes, is_verified ? 1 : 0, verification_source, verified_date, req.params.id);
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

app.put('/api/activities/:id/done', (req, res) => {
  try {
    db.prepare('UPDATE activities SET follow_up_done = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark follow-up as done' });
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
    res.json(contacts);
  } catch (err) {
    console.error(err);
    sendApiError(res, err, 'Failed to research contacts');
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
      systemPrompt:
        'You are an expert B2B lead qualification agent for precision ceramic bearings and electric burner technology. Return only strict JSON.',
      userPrompt: `
        Qualify this lead for SinterIQ.

        Qualification criteria:
        1. Stability of the company based on website quality, scale, and visible credibility.
        2. Strategic fit for ceramic bearings or electric burner technology.
        3. Technical fit for the products.
        4. Social presence and evidence of current activity if available.
        5. Recent news or expansion signals if available.

        Company data:
        - Name: ${company.company_name}
        - Country: ${company.country}
        - Industry: ${company.industry}
        - Type: ${company.company_type}
        - Revenue: ${company.revenue_eur || 'Unknown'}
        - Employees: ${company.employee_count || 'Unknown'}
        - Website: ${company.website || 'Unknown'}
        - Current Notes: ${company.qualification_notes || 'None'}

        ${websiteContext ? `Website context:\n${websiteContext}\n` : 'Website context could not be fetched.\n'}

        Return a JSON object with:
        - score: integer from 0 to 100
        - category: "STRATEGIC_PARTNER", "BEARING_CUSTOMER", "LOW_FIT", or "NO_FIT"
        - technical_fit: "HIGH", "MEDIUM", "LOW", or "NO_FIT"
        - reasoning: detailed paragraph for sales
        - product_fit: "Ceramic Bearings", "E-Burner Technology", "Both", or "None"
        - social_media_urls: array of strings
        - social_media_active: boolean
        - mentions_technology: boolean
      `,
      useWebSearch: true,
    });

    const result = parseJsonResponse<{
      category?: string;
      mentions_technology?: boolean;
      product_fit?: string;
      reasoning?: string;
      score?: number;
      social_media_active?: boolean;
      social_media_urls?: string[];
      technical_fit?: string;
    }>(rawResponse, {});
    
    // Map category to lead_status
    let newStatus = 'QUALIFIED';
    if (result.category === 'NO_FIT' || result.category === 'LOW_FIT') newStatus = 'DISQUALIFIED';
    if (result.category === 'STRATEGIC_PARTNER') newStatus = 'APPROVED';
    const technicalFit = result.technical_fit === 'NO_FIT' ? 'NOT_FIT' : (result.technical_fit || null);
    
    db.prepare(`
      UPDATE companies 
      SET lead_score = ?, technical_fit = ?, qualification_notes = ?, lead_status = ?,
          product_fit = ?, social_media_urls = ?, social_media_active = ?, mentions_technology = ?,
          tracking_status = CASE
            WHEN ? IN ('APPROVED', 'QUALIFIED') THEN 'QUALIFIED'
            ELSE tracking_status
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      normalizeNullableNumber(result.score) || 0, 
      technicalFit, 
      normalizeOptionalString(result.reasoning), 
      newStatus, 
      normalizeOptionalString(result.product_fit),
      JSON.stringify(Array.isArray(result.social_media_urls) ? result.social_media_urls : []),
      result.social_media_active ? 1 : 0,
      result.mentions_technology ? 1 : 0,
      newStatus,
      companyId
    );
      
    const updatedCompany = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updatedCompany);
  } catch (error) {
    console.error('AI Qualification error:', error);
    sendApiError(res, error, 'AI qualification failed');
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

        const info = insertCompany.run(
          data['Company Name'],
          data['Country'] || 'Unknown',
          city,
          data['Country'] === 'UAE' ? 'GCC' : 'Unknown',
          data['Industry'] || 'Unknown',
          data['Type of Activity'] || 'Unknown',
          parseInt(data['Employee Count']) || null,
          revenue,
          data['Website'] || '',
          data['Corporate Family'] || '',
          'DNB_HOOVERS',
          'RAW',
          data['Notes'] || ''
        );

        const companyId = info.lastInsertRowid;

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
