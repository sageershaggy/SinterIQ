import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { GoogleGenAI, Type } from '@google/genai';

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

function createAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  return new GoogleGenAI({ apiKey });
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
    follow_up_date DATETIME
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
`);

// Add new columns to companies if they don't exist
try { db.exec("ALTER TABLE companies ADD COLUMN product_fit TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_media_urls TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN social_media_active BOOLEAN DEFAULT 0;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN mentions_technology BOOLEAN DEFAULT 0;"); } catch (e) {}
try { db.exec("ALTER TABLE companies ADD COLUMN follow_up_date DATETIME;"); } catch (e) {}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/companies', (req, res) => {
  const companies = db.prepare(`
    SELECT c.*, COUNT(con.id) as contact_count 
    FROM companies c 
    LEFT JOIN contacts con ON c.id = con.company_id 
    GROUP BY c.id
  `).all();
  res.json(companies);
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
    const { company_name, website, country, city, region, industry, company_type, lead_status, technical_fit, assigned_to, qualification_notes } = req.body;
    db.prepare(`
      UPDATE companies 
      SET company_name = ?, website = ?, country = ?, city = ?, region = ?, industry = ?, company_type = ?, lead_status = ?, technical_fit = ?, assigned_to = ?, qualification_notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(company_name, website, country, city, region, industry, company_type, lead_status, technical_fit, assigned_to, qualification_notes, req.params.id);
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

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `
      You are an expert lead researcher. Find the professional contact details for:
      Name: ${full_name}
      Company: ${company_name}
      
      Return the best available information. If a field cannot be found, return an empty string.
      Do not hallucinate.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            job_title: { type: Type.STRING },
            email: { type: Type.STRING },
            linkedin_url: { type: Type.STRING }
          },
          required: ["job_title", "email", "linkedin_url"]
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    res.json(result);
  } catch (error) {
    console.error('Contact enrichment error:', error);
    res.status(500).json({ error: 'Contact enrichment failed' });
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
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const { companyName, website } = req.body;
    const prompt = `
      Find key contacts (e.g., CEO, Maintenance Manager, Production Manager, R&D Manager, Purchasing) 
      for the company "${companyName}" with website "${website}".
      Return a JSON array of objects with the following keys:
      - full_name
      - job_title
      - email (if available, otherwise empty string)
      - phone_direct (if available, otherwise empty string)
      - linkedin_url (if available, otherwise empty string)
      
      Only return the raw JSON array, no markdown formatting or other text.
    `;
    
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        tools: [{ googleSearch: {} }]
      }
    });

    const text = response.text || '[]';
    let contacts = [];
    try {
      contacts = JSON.parse(text);
    } catch (e) {
      // fallback if it didn't return pure JSON
      const match = text.match(/\\[[\\s\\S]*\\]/);
      if (match) contacts = JSON.parse(match[0]);
    }
    
    res.json(contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to research contacts' });
  }
});

app.post('/api/research/save', (req, res) => {
  try {
    const { companyName, website, contacts, assignedTo, industry, companyType, technicalFit, qualificationNotes } = req.body;
    
    // Check if company exists
    let company = db.prepare('SELECT id FROM companies WHERE company_name = ?').get(companyName) as any;
    let companyId;
    
    if (company) {
      companyId = company.id;
      // Update website and assigned_to if missing
      db.prepare('UPDATE companies SET website = COALESCE(NULLIF(website, ""), ?), assigned_to = COALESCE(NULLIF(assigned_to, ""), ?), industry = ?, company_type = ?, technical_fit = ?, qualification_notes = ? WHERE id = ?').run(website, assignedTo || null, industry || 'Unknown', companyType || 'Unknown', technicalFit || 'UNASSESSED', qualificationNotes || '', companyId);
    } else {
      // Create new company
      const info = db.prepare(`
        INSERT INTO companies (company_name, website, country, industry, company_type, lead_status, source, assigned_to, technical_fit, qualification_notes)
        VALUES (?, ?, 'Unknown', ?, ?, 'RAW', 'AI_RESEARCH', ?, ?, ?)
      `).run(companyName, website, industry || 'Unknown', companyType || 'Unknown', assignedTo || null, technicalFit || 'UNASSESSED', qualificationNotes || '');
      companyId = info.lastInsertRowid;
    }
    
    // Insert contacts
    const insertContact = db.prepare(`
      INSERT INTO contacts (company_id, full_name, job_title, email, phone_direct, linkedin_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const insertActivity = db.prepare(`
      INSERT INTO activities (company_id, activity_type, activity_date, performed_by, subject, details, outcome)
      VALUES (?, 'IMPORT', ?, 'System', 'AI Research Import', ?, 'NEUTRAL')
    `);
    
    db.transaction(() => {
      for (const contact of contacts) {
        insertContact.run(
          companyId, 
          contact.full_name || 'Unknown', 
          contact.job_title || '', 
          contact.email || '', 
          contact.phone_direct || '', 
          contact.linkedin_url || ''
        );
      }
      insertActivity.run(
        companyId, 
        new Date().toISOString().split('T')[0], 
        `Imported ${contacts.length} contacts via AI Research`
      );
    })();
    
    res.json({ success: true, companyId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save research data' });
  }
});

app.post('/api/companies/:id/ai-qualify', async (req, res) => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const companyId = req.params.id;
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const prompt = `
      You are an expert AI lead qualification agent for a German technology company (est. 1962).
      
      OUR PITCH & CRITERIA:
      We sell precision ceramic bearings and electric burner technology for decarbonization.
      We are seeking long-term strategic partners in the Middle East to jointly build an industrial ecosystem, as well as standard bearing customers.
      
      We need to qualify this lead based on the following criteria:
      1. Is it a stable company? (Check social media access, website working fine, number of employees, positive reviews).
      2. Are there any recent news related to the company? Are they purchasing or applying for things from their social media?
      3. Do they fit our strategic partner profile or bearing customer profile?
      4. What is their technical fit for our specific products (Precision Ceramic Bearings and Electric Burner Technology)?
      5. Do they mention ceramic technology or e-burner technology on their website or social media?
      
      LEAD COMPANY DATA:
      Name: ${company.company_name}
      Country: ${company.country}
      Industry: ${company.industry}
      Type: ${company.company_type}
      Revenue: ${company.revenue_eur}
      Employees: ${company.employee_count}
      Website: ${company.website}
      Current Notes: ${company.qualification_notes}
      
      Use the Google Search tool to look up the company's recent news, social media presence, and reviews.
      
      Provide a JSON response with:
      - score: 0-100 integer. Calculate out of 100 points based on: Has working website (15pts), Active social media (15pts), Mentions relevant technology (30pts), Good revenue/size (20pts), Positive news/reviews (20pts).
      - category: "STRATEGIC_PARTNER", "BEARING_CUSTOMER", "LOW_FIT", or "NO_FIT"
      - technical_fit: "HIGH", "MEDIUM", "LOW", or "NO_FIT" based on specific product alignment.
      - reasoning: A detailed paragraph explaining why this lead has been qualified (or disqualified), mentioning their stability, recent news, social media presence, and how sales should approach them.
      - product_fit: "Ceramic Bearings", "E-Burner Technology", "Both", or "None"
      - social_media_urls: Array of strings containing found social media profiles (LinkedIn, Twitter, etc.)
      - social_media_active: Boolean indicating if they have posted recently
      - mentions_technology: Boolean indicating if they mention ceramic bearings or e-burners
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER },
            category: { type: Type.STRING },
            technical_fit: { type: Type.STRING },
            reasoning: { type: Type.STRING },
            product_fit: { type: Type.STRING },
            social_media_urls: { type: Type.ARRAY, items: { type: Type.STRING } },
            social_media_active: { type: Type.BOOLEAN },
            mentions_technology: { type: Type.BOOLEAN }
          },
          required: ["score", "category", "technical_fit", "reasoning", "product_fit", "social_media_urls", "social_media_active", "mentions_technology"]
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    
    // Map category to lead_status
    let newStatus = 'QUALIFIED';
    if (result.category === 'NO_FIT' || result.category === 'LOW_FIT') newStatus = 'DISQUALIFIED';
    if (result.category === 'STRATEGIC_PARTNER') newStatus = 'APPROVED';
    
    db.prepare(`
      UPDATE companies 
      SET lead_score = ?, technical_fit = ?, qualification_notes = ?, lead_status = ?,
          product_fit = ?, social_media_urls = ?, social_media_active = ?, mentions_technology = ?
      WHERE id = ?
    `).run(
      result.score, 
      result.technical_fit, 
      result.reasoning, 
      newStatus, 
      result.product_fit,
      JSON.stringify(result.social_media_urls || []),
      result.social_media_active ? 1 : 0,
      result.mentions_technology ? 1 : 0,
      companyId
    );
      
    const updatedCompany = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    res.json(updatedCompany);
  } catch (error) {
    console.error('AI Qualification error:', error);
    res.status(500).json({ error: 'AI Qualification failed' });
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
