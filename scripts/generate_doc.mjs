import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, BorderStyle, AlignmentType } from 'docx';
import fs from 'fs';

const BLUE = '2563EB';
const DARK = '1E293B';
const GRAY = '64748B';
const GREEN = '16A34A';
const RED = 'DC2626';
const ORANGE = 'EA580C';

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, spacing: { before: 300, after: 100 }, children: [new TextRun({ text, bold: true, color: DARK, size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 26 : 22 })] });
}

function para(text, opts = {}) {
  return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, size: 20, color: opts.color || DARK, bold: opts.bold, italics: opts.italic, ...opts })] });
}

function bullet(text, opts = {}) {
  return new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text, size: 20, color: DARK, ...opts })] });
}

function tableRow(cells, isHeader = false) {
  return new TableRow({
    children: cells.map(text => new TableCell({
      width: { size: 100 / cells.length, type: WidthType.PERCENTAGE },
      shading: isHeader ? { fill: '1E293B' } : undefined,
      children: [new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: String(text), size: 18, bold: isHeader, color: isHeader ? 'FFFFFF' : DARK })] })],
    })),
  });
}

function makeTable(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [tableRow(headers, true), ...rows.map(r => tableRow(r))],
  });
}

const doc = new Document({
  styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
  sections: [{
    properties: {},
    children: [
      // Title
      new Paragraph({ spacing: { after: 50 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'SinterIQ', size: 56, bold: true, color: BLUE })] }),
      new Paragraph({ spacing: { after: 20 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Precision Lead Intelligence Platform', size: 28, color: GRAY, italics: true })] }),
      new Paragraph({ spacing: { after: 300 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Technical Documentation — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, size: 20, color: GRAY })] }),

      // 1. Architecture
      heading('1. Architecture Overview'),
      para('SinterIQ is a full-stack lead intelligence CRM built for Sintertechnik GmbH (Germany) bearing sales in the Middle East.'),
      bullet('Frontend: React 19 + TypeScript + Tailwind CSS + Vite 6'),
      bullet('Backend: Express.js server (server.ts) with SQLite via better-sqlite3'),
      bullet('AI Engine: Gemini API (with Google Search grounding) — configurable to OpenAI, Claude, DeepSeek, Groq, Mistral, xAI'),
      bullet('Hosting: Firebase Hosting (sinteriq.web.app) or any Node.js host'),
      bullet('Database: SQLite file (sintertechnik.db) — portable, no external DB needed'),

      // 2. Database Schema
      heading('2. Database Schema'),
      heading('2.1 Companies Table', HeadingLevel.HEADING_2),
      para('Core table storing all lead/company data including AI qualification results.'),
      makeTable(['Column', 'Type', 'Description'], [
        ['id', 'INTEGER PK', 'Auto-increment primary key'],
        ['company_name', 'TEXT NOT NULL', 'Company name (unique constraint on create)'],
        ['country', 'TEXT NOT NULL', 'Country code or name'],
        ['city', 'TEXT', 'City name'],
        ['region', 'TEXT', 'DACH, GCC, UAE, Saudi Arabia, etc.'],
        ['industry', 'TEXT', 'Industry classification'],
        ['company_type', 'TEXT', 'Bearing Trader, OEM, Distributor, etc.'],
        ['employee_count', 'INTEGER', 'Number of employees'],
        ['revenue_eur', 'REAL', 'Annual revenue in EUR'],
        ['website', 'TEXT', 'Company website URL'],
        ['duns_number', 'TEXT', 'D&B DUNS number'],
        ['corporate_parent', 'TEXT', 'Parent company name'],
        ['is_subsidiary', 'INTEGER', '0 or 1'],
        ['source', 'TEXT', 'DNB_HOOVERS, AI_RESEARCH, MANUAL, LINKEDIN'],
        ['lead_score', 'INTEGER', 'AI-generated score 0-100'],
        ['lead_status', 'TEXT', 'RAW → ENRICHED → QUALIFIED → APPROVED → IN_OUTREACH → CONTACTED → OPPORTUNITY → WON → LOST → DISQUALIFIED'],
        ['technical_fit', 'TEXT', 'HIGH, MEDIUM, LOW, NOT_FIT'],
        ['product_fit', 'TEXT', 'Ceramic Bearings, Hybrid Bearings, etc.'],
        ['buying_probability', 'INTEGER', '0-100 likelihood of purchase'],
        ['website_score', 'INTEGER', '0-100 website quality'],
        ['social_score', 'INTEGER', '0-100 social media presence'],
        ['social_media_active', 'INTEGER', '0 or 1'],
        ['social_media_urls', 'TEXT', 'JSON array of URLs'],
        ['social_profiles_json', 'TEXT', 'JSON array with followers, lastPost etc.'],
        ['mentions_technology', 'INTEGER', '0 or 1 — mentions bearings/ceramics'],
        ['qualification_notes', 'TEXT', 'AI strategic analysis'],
        ['opportunity_notes', 'TEXT', 'AI opportunity & pain points'],
        ['approach_strategy', 'TEXT', 'AI recommended approach'],
        ['sales_script', 'TEXT', 'AI-generated sales call script'],
        ['email_script', 'TEXT', 'AI-generated cold outreach email'],
        ['ai_qualified_at', 'DATETIME', 'Timestamp of last AI qualification'],
        ['assigned_to', 'TEXT', 'Team member name'],
        ['created_by', 'TEXT', 'Who created the record'],
        ['tracking_level', 'TEXT', 'WATCHLIST, ACTIVE, PRIORITY'],
        ['tracking_status', 'TEXT', 'PENDING, QUALIFIED, IN_PROGRESS, DONE'],
        ['tracking_notes', 'TEXT', 'Free-text tracking notes'],
        ['next_tracking_date', 'DATETIME', 'Next follow-up date for tracking'],
        ['created_at', 'DATETIME', 'Auto-set on create'],
        ['updated_at', 'DATETIME', 'Auto-updated on every change'],
      ]),

      heading('2.2 Contacts Table', HeadingLevel.HEADING_2),
      makeTable(['Column', 'Type', 'Description'], [
        ['id', 'INTEGER PK', 'Auto-increment'],
        ['company_id', 'INTEGER FK', 'References companies.id'],
        ['full_name', 'TEXT NOT NULL', 'Contact full name'],
        ['job_title', 'TEXT', 'Role — priority scored (Maintenance=HIGHEST, Purchasing=AVOID)'],
        ['email', 'TEXT', 'Unique per company (duplicate check on insert)'],
        ['phone_direct', 'TEXT', 'Direct phone number'],
        ['linkedin_url', 'TEXT', 'LinkedIn profile URL'],
        ['is_verified', 'INTEGER', '0 or 1'],
        ['verification_source', 'TEXT', 'How verified (LinkedIn, Company website, etc.)'],
        ['verified_date', 'DATETIME', 'When verified'],
      ]),

      heading('2.3 Activities Table', HeadingLevel.HEADING_2),
      para('Tracks all interactions: calls, emails, meetings, LinkedIn messages.'),
      makeTable(['Column', 'Type', 'Description'], [
        ['id', 'INTEGER PK', 'Auto-increment'],
        ['company_id', 'INTEGER FK', 'References companies.id'],
        ['contact_id', 'INTEGER FK', 'References contacts.id (optional)'],
        ['activity_type', 'TEXT', 'CALL_MADE, EMAIL_SENT, MEETING_HELD, LINKEDIN_MESSAGE, NOTE'],
        ['activity_date', 'DATE', 'When the activity happened'],
        ['performed_by', 'TEXT', 'Team member who performed it'],
        ['subject', 'TEXT', 'Activity subject line'],
        ['details', 'TEXT', 'Full activity details'],
        ['outcome', 'TEXT', 'POSITIVE, NEUTRAL, NEGATIVE, FOLLOW_UP_NEEDED'],
        ['follow_up_date', 'DATE', 'Optional follow-up date'],
        ['follow_up_done', 'INTEGER', '0 or 1 — marks follow-up complete'],
      ]),

      heading('2.4 Other Tables', HeadingLevel.HEADING_2),
      bullet('orders — Order tracking with commission calculations (Amendment No. 1 tiers)'),
      bullet('notes — Team communication threads per company'),
      bullet('users — Team members (Dr. Langguth, Ahmad Khan, Sageer A. Shaikh, etc.)'),
      bullet('app_settings — Key-value store for LLM configuration'),
      bullet('research_history — Saved AI research sessions'),

      // 3. API Endpoints
      heading('3. API Endpoints'),
      heading('3.1 Companies', HeadingLevel.HEADING_2),
      makeTable(['Method', 'Endpoint', 'Description'], [
        ['GET', '/api/companies', 'List all companies with contact counts'],
        ['GET', '/api/companies/:id', 'Get company detail + contacts + activities + orders'],
        ['POST', '/api/companies', 'Create company (duplicate check by name + website)'],
        ['PUT', '/api/companies/:id', 'Full update — saves ALL fields including DUNS, source, etc.'],
        ['PATCH', '/api/companies/:id', 'Partial update — single field inline edit'],
        ['DELETE', '/api/companies/:id', 'Delete company + all related data (cascade)'],
        ['PATCH', '/api/companies/:id/status', 'Update lead status only (for pipeline drag)'],
        ['POST', '/api/companies/:id/ai-qualify', 'Run AI qualification (score, scripts, social)'],
        ['POST', '/api/companies/import', 'Bulk import from D&B Hoovers XLSX (with duplicate merge)'],
        ['POST', '/api/companies/merge', 'Merge two companies (moves contacts/activities)'],
        ['PUT', '/api/companies/:id/social-profiles', 'Update social media profiles'],
        ['GET/POST', '/api/companies/:id/notes', 'Team notes per company'],
      ]),
      heading('3.2 Contacts & Activities', HeadingLevel.HEADING_2),
      makeTable(['Method', 'Endpoint', 'Description'], [
        ['GET', '/api/contacts', 'All contacts with company names'],
        ['POST', '/api/contacts', 'Add contact (unique email check per company)'],
        ['PUT', '/api/contacts/:id', 'Update contact'],
        ['DELETE', '/api/contacts/:id', 'Delete contact'],
        ['POST', '/api/activities', 'Log activity (call, email, meeting, note)'],
        ['GET', '/api/activities/follow-ups', 'Pending follow-ups sorted by date'],
        ['GET', '/api/activities/recent', 'Last 15 activities across all companies'],
        ['PUT', '/api/activities/:id/done', 'Mark follow-up as done'],
        ['PUT', '/api/activities/:id/snooze', 'Snooze follow-up by days'],
      ]),
      heading('3.3 AI & Research', HeadingLevel.HEADING_2),
      makeTable(['Method', 'Endpoint', 'Description'], [
        ['POST', '/api/research/contacts', 'AI-powered contact search (Gemini + web)'],
        ['GET', '/api/research/history', 'Research session history'],
        ['POST', '/api/research/save', 'Save research results to company'],
        ['POST', '/api/research/add-to-company', 'Link research contacts to existing company'],
        ['POST', '/api/contacts/enrich', 'AI enrich a single contact'],
        ['GET/PUT', '/api/settings/llm', 'Get/update LLM provider configuration'],
      ]),

      // 4. AI Qualification
      heading('4. AI Qualification Engine'),
      para('The AI Qualify endpoint performs deep company research using Gemini with Google Search grounding:'),
      bullet('Searches the web for the company — website, LinkedIn, social media, news'),
      bullet('Scores: Lead Score (0-100), Buying Probability (0-100), Website Score (0-100), Social Score (0-100)'),
      bullet('Classification: STRATEGIC_PARTNER, BEARING_CUSTOMER, LOW_FIT, NO_FIT'),
      bullet('Technical Fit: HIGH, MEDIUM, LOW, NOT_FIT'),
      bullet('Generates: Strategic Analysis, Opportunity Notes, Approach Strategy'),
      bullet('Generates: Sales Call Script (5-8 bullet talking points)'),
      bullet('Generates: Cold Outreach Email (subject + body, personalized)'),
      bullet('Finds & saves social media profiles with follower counts'),
      bullet('Auto-adds discovered contacts to the company'),
      bullet('Auto-updates lead status based on qualification category'),

      // 5. Commission Tiers
      heading('5. Commission Tracking (Admin Only)'),
      para('Per Amendment No. 1 to the Cooperation Agreement. Visible only to Sageer (admin role).'),
      makeTable(['Order Value', 'Commission Rate', 'Notes'], [
        ['≤ €500', '10%', 'Standard ceramic bearing orders'],
        ['≤ €3,000', '7%', 'Medium orders'],
        ['≤ €10,000', '5%', 'Larger orders'],
        ['> €10,000', 'Case-by-case', 'Negotiated individually'],
        ['Hybrid bearings', 'Case-by-case', 'Separate agreements per Amendment No. 1'],
      ]),
      bullet('Commission payable only after Sintertechnik receives payment from customer'),
      bullet('Applies only where Innovista made "demonstrable contribution"'),

      // 6. RBAC
      heading('6. Role-Based Access Control'),
      makeTable(['Role', 'Access', 'Users'], [
        ['Admin', 'Full access + Commission Tracking', 'Sageer A. Shaikh'],
        ['Sales', 'All except Commissions', 'Ahmad Khan, Dr. Langguth, Christoph, Patton, Dr. Schellenberger, Dr. Kathrin'],
      ]),
      para('Role detection: username contains "sageer" or "admin" → admin role. All others → sales role.'),

      // 7. Lead Pipeline
      heading('7. Lead Pipeline Stages'),
      para('The pipeline follows a defined lifecycle from data mining to deal closure:'),
      makeTable(['Stage', 'Description', 'Action'], [
        ['RAW', 'Imported from D&B Hoovers or manually created', 'Needs initial review'],
        ['ENRICHED', 'AI-qualified with low/medium fit', 'Review AI analysis'],
        ['QUALIFIED', 'AI confirms bearing/ceramic fit', 'Assign to sales team'],
        ['APPROVED', 'Strategic partner identified', 'Priority outreach'],
        ['IN_OUTREACH', 'First contact initiated', 'Track response'],
        ['CONTACTED', 'Response received', 'Schedule meeting'],
        ['OPPORTUNITY', 'Active sales opportunity', 'Prepare quote'],
        ['WON', 'Deal closed', 'Track commission'],
        ['LOST', 'Deal lost', 'Log reason'],
        ['DISQUALIFIED', 'No fit for ceramic bearings', 'Archive'],
      ]),

      // 8. Contact Role Priority
      heading('8. Contact Role Priority (Per Reference Guide)'),
      makeTable(['Priority', 'Roles', 'Color'], [
        ['HIGHEST', 'Head of Maintenance, R&M Manager, Instandhaltung', 'Red'],
        ['HIGH', 'Production Manager, R&D Manager, Fertigung', 'Orange'],
        ['MEDIUM', 'CTO, Technical Director, Owner, Geschäftsführer', 'Yellow'],
        ['LOW', 'CEO, Managing Director, Leiter', 'Blue'],
        ['AVOID', 'Purchasing Manager, Einkauf, Procurement', 'Gray'],
      ]),

      // 9. Import/Export
      heading('9. Data Import & Export'),
      heading('9.1 Import Sources', HeadingLevel.HEADING_2),
      bullet('D&B Hoovers — XLSX/CSV upload with field mapping (primary source)'),
      bullet('LinkedIn — Sales Navigator CSV export'),
      bullet('Manual CSV — Generic CSV with custom column mapping'),
      para('Import includes duplicate detection: matches by company name OR website. Duplicates are merged (updates existing data, adds new contacts).'),

      heading('9.2 Export', HeadingLevel.HEADING_2),
      para('Full CSV export with 35 columns including:'),
      bullet('Company details: Name, Type, Country, City, Region, Industry, Employees, Revenue, Website, DUNS'),
      bullet('AI scores: Lead Score, Tech Fit, Product Fit, Buying Probability, Website Score, Social Score'),
      bullet('AI content: Strategic Analysis, Opportunity Notes, Approach Strategy, Sales Script, Email Script'),
      bullet('Tracking: Level, Status, Next Date, Notes'),
      bullet('Metadata: Assigned To, Created By, Created At, Updated At, AI Qualified At'),
      para('Export respects current filters and sort order. UTF-8 BOM for Excel compatibility.'),

      // 10. Environment Config
      heading('10. Environment Configuration'),
      para('System-level API keys via .env.local (takes precedence when no UI-saved key):'),
      bullet('GEMINI_API_KEY — Gemini API key (recommended, includes web search)'),
      bullet('GEMINI_MODEL — Model override (default: gemini-2.5-flash)'),
      bullet('LLM_API_KEY — OpenAI-compatible API key (fallback)'),
      bullet('LLM_BASE_URL — Custom endpoint URL'),
      bullet('LLM_MODEL — Model name for OpenAI-compatible'),
      bullet('LLM_PROVIDER_NAME — Display name'),

      heading('11. Supported AI Providers'),
      makeTable(['Provider', 'Models', 'Web Search'], [
        ['Google Gemini', '3.1 Pro, 3.1 Flash, 2.5 Pro, 2.5 Flash', 'Yes (Google Search grounding)'],
        ['OpenAI', 'GPT-5.4, GPT-5.4-mini, GPT-4.1, GPT-4.1-mini, o4-mini', 'No'],
        ['Anthropic', 'Claude Opus 4.7, Sonnet 4.7, Opus 4, Sonnet 4, Haiku 3.5', 'No'],
        ['Groq', 'Llama 4 Maverick, Llama 4 Scout, Llama 3.3 70B, DeepSeek R1', 'No'],
        ['DeepSeek', 'V3 (0324), R1', 'No'],
        ['Mistral', 'Large 2025, Small 2025', 'No'],
        ['xAI', 'Grok 3, Grok 3 Mini', 'No'],
        ['Ollama', 'Any local model', 'No'],
      ]),

      // Footer
      new Paragraph({ spacing: { before: 400 }, children: [] }),
      para('— End of Document —', { italic: true, color: GRAY }),
      para(`Generated ${new Date().toISOString().split('T')[0]} by SinterIQ Documentation Generator`, { color: GRAY, size: 16 }),
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
const outPath = 'SinterIQ_Technical_Documentation.docx';
fs.writeFileSync(outPath, buffer);
console.log(`Document generated: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
