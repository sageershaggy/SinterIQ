# SinterIQ - B2B Sales Intelligence Platform

## Overview
SinterIQ is a B2B sales intelligence and lead management platform built for **Sintertechnik GmbH** (Germany), a manufacturer of precision ceramic bearings, hybrid bearings, and ceramic components. It provides AI-powered lead qualification, contact discovery, pipeline management, and sales enablement.

## Tech Stack
- **Frontend**: React 19 + TypeScript, Vite 6.2, Tailwind CSS 4.1, Recharts, Lucide icons, XLSX
- **Backend**: Express.js 4.21 + TypeScript (tsx), better-sqlite3
- **Database**: SQLite3 (`sintertechnik.db`, auto-created)
- **AI/LLM**: Google Gemini (@google/genai) with web search, OpenAI-compatible fallback
- **Default LLM model**: gemini-2.5-flash

## Running the App
```bash
npm install
npm run dev       # Start dev server on http://localhost:3000
npm run build     # Production build (Vite → dist/)
npm run lint      # TypeScript type check (tsc --noEmit)
```

## Environment Variables
```env
GEMINI_API_KEY=       # Required for AI features (primary provider)
GEMINI_MODEL=         # Optional, defaults to gemini-2.5-flash
LLM_API_KEY=          # Optional OpenAI-compatible fallback
LLM_MODEL=            # Optional, defaults to gpt-4.1-mini
LLM_BASE_URL=         # Optional, defaults to https://api.openai.com/v1
```
LLM settings can also be configured via the UI Settings tab (stored in `app_settings` table). DB settings take priority over env vars.

## Project Structure
```
server.ts                    # Express backend — REST API, SQLite, LLM integration (~2700 lines)
src/
  main.tsx                   # React entry point
  AppRoot.tsx                # Main app shell: sidebar nav, dashboard KPIs, company list, filters, exports
  App.tsx                    # (dead) Legacy dashboard — unreachable
  CompanyDetail.tsx          # Multi-tab company detail with disqualification + human-review banners
  CompanyCreateModal.tsx     # New company creation form
  KanbanBoard.tsx            # Drag-and-drop pipeline (DISQUALIFIED column triggers reason modal)
  GccMarketingTab.tsx        # GCC marketing-ready leads (region=GCC + QUALIFIED/APPROVED)
  ReviewQueueTab.tsx         # Human QC queue for low-confidence AI qualifications
  NotATargetTab.tsx          # Combined view of AI-flagged + human-disqualified leads
  DisqualifyModal.tsx        # Required-reason modal with category quick-picks
  ResearchTab.tsx            # AI-powered lead research and contact discovery
  ContactsTab.tsx            # (dead) Global contacts management — unreachable
  FollowUpsTab.tsx           # Follow-up scheduling, snooze/complete
  CommissionAdmin.tsx        # Commission tiers and calculation
  CommissionsTab.tsx         # Commission display
  ImportTab.tsx              # Bulk import (D&B, LinkedIn, generic CSV) with normalized dedup
  SettingsTab.tsx            # LLM provider configuration UI
  UsersTab.tsx               # (dead) Team user management — unreachable
  TrackingTab.tsx            # (dead) Company tracking levels — unreachable
  LoginScreen.tsx            # Authentication
  Toast.tsx                  # Notification system
  ErrorBoundary.tsx          # React error handling
  appTypes.ts                # TypeScript interfaces (Company, AppUser, LlmSettings)
  companyData.ts             # Shared constants incl. disqualificationCategoryOptions
  formatters.ts              # Formatting utilities (EUR, dates)
  index.css                  # Minimal CSS (Tailwind)
```

## Sidebar tabs (active in AppRoot)
1. **Dashboard** — KPIs + follow-ups
2. **Companies** — main list with filters, bulk delete, bulk AI qualify
3. **Pipeline** — kanban drag-and-drop (DISQUALIFIED column opens DisqualifyModal)
4. **GCC Marketing** — region=GCC + QUALIFIED/APPROVED, marketing-pack CSV export
5. **Review Queue** — AI-qualified leads with confidence <70% awaiting human spot-check
6. **Not a Target** — unified view: `lead_priority='NOT_A_TARGET'` OR `status='DISQUALIFIED'`, supports restore
7. **Lead Research** — AI contact discovery
8. **Import Data** — bulk import with normalized dedup
9. **Commissions** (admin only) — commission tiers
10. **Settings** — LLM provider config

## Database Schema (SQLite)

### companies (~56 columns)
Core lead/company record. Key fields:
- Identity: `company_name`, `country`, `city`, `region`, `industry`, `company_type`
- Sizing: `employee_count`, `revenue_eur`
- Legal: `legal_form`, `duns_number`, `corporate_parent`, `is_subsidiary`
- Lead intelligence: `lead_score` (0-100), `lead_status`, `technical_fit`, `lead_priority`, `qualification_notes`
- AI qualification: `ai_qualified_at`, `ai_confidence` (0-100), `website_score`, `social_score`, `buying_probability`, `approach_strategy`, `sales_script`, `email_script`, `opportunity_notes`, `social_profiles_json`
- **Disqualification (Phase 1)**: `disqualification_reason`, `disqualification_category`, `disqualified_by`, `disqualified_at`
- **Human review (Phase 2)**: `human_reviewed` (0/1), `human_reviewed_at`, `human_reviewed_by`, `human_review_notes`
- Tracking: `tracking_level` (WATCHLIST/ACTIVE/HIGH_PRIORITY/STRATEGIC), `tracking_status`, `next_tracking_date`
- Metadata: `assigned_to`, `created_by`, `source` (DNB_HOOVERS/MANUAL/AI_RESEARCH), `created_at`, `updated_at`

### contacts (~19 columns)
Per-company contacts with engagement tracking:
- `company_id`, `full_name`, `job_title`, `department`, `email`, `phone_direct`, `linkedin_url`
- Engagement: `contacted_via`, `cooperation_interest`, `ceramic_bearing_experience`, `attempted_solution`
- Verification: `is_verified`, `verified_date`, `is_primary`

### activities (~13 columns)
Activity log per company/contact:
- Types: CALL_MADE, EMAIL_SENT, MEETING_HELD, LINKEDIN_MESSAGE, INBOUND_CONTACT, TECH_SUPPORT, QUOTE_REQUESTED, QUOTE_PROVIDED, SAMPLES_ORDERED, SAMPLES_DELIVERED, CLARIFYING_ACTIONS, IMPORT
- Follow-up: `follow_up_date`, `follow_up_done`

### orders (~15 columns)
Order and commission tracking:
- `order_reference`, `order_date`, `order_value_eur`, `product_type`, `is_hybrid`
- Commission: auto-calculated (10% <=500, 7% 500-3K, 5% >3K), `commission_paid`, `payment_received`

### users, notes, app_settings, research_history
Supporting tables for team, internal notes, LLM config, and AI research audit trail.

## Key API Endpoints

### Companies
- `GET /api/companies` — List all (with contact counts, follow-up dates)
- `POST /api/companies` — Create (uses normalized dedup — see "Import dedup" below)
- `GET /api/companies/:id` — Detail (with contacts, activities, orders)
- `PUT /api/companies/:id` — Full update (rejects status=DISQUALIFIED from any other state)
- `PATCH /api/companies/:id` — Inline single-field update (same DISQUALIFIED guard)
- `DELETE /api/companies/:id` — Cascade delete (contacts, activities, orders, notes)
- `PATCH /api/companies/:id/status` — Update lead_status (rejects DISQUALIFIED — use /disqualify)
- `POST /api/companies/:id/disqualify` — **Phase 1.** Required `{ reason, category, by }`; sets status=DISQUALIFIED, lead_priority=NOT_A_TARGET, marks human_reviewed
- `POST /api/companies/:id/restore` — **Phase 1.** Clears all disqualification fields, reverts status
- `POST /api/companies/:id/mark-reviewed` — **Phase 2.** Marks human_reviewed=1 with `{ by, notes }`
- `POST /api/companies/:id/unmark-reviewed` — **Phase 2.** Reverse of mark-reviewed
- `POST /api/companies/merge` — Merge two companies
- `POST /api/companies/import` — Bulk import; response: `{ total, created, merged, companies }`
- `POST /api/companies/:id/ai-qualify` — AI qualification with web search
  - **Phase 5:** Runs cheap pre-classifier first; short-circuits LIKELY_NOT_TARGET at >=75% confidence
  - Query params: `?force=true` (re-run within 7d), `?skip_prefilter=true` (force deep pass)

### Disqualification categories (Phase 1)
`COMPETITOR`, `WHOLESALER_TRADER`, `UTILITY_OR_SOFTWARE`, `SERVICE_MRO`, `GLOBAL_ENTERPRISE`, `SALES_BRANCH`, `EPC_INTEGRATOR`, `SMALL_END_USER`, `LOW_FIT`, `DUPLICATE`, `OTHER`. Aligned 1:1 with Ahmad's 10 exclusion rules in the AI prompt.

### Import dedup (Phase 4)
`findExistingCompanyByMatch(name, website)` powers both `POST /companies` and `POST /companies/import`. Matching:
- Website: protocol/www/trailing-slash normalized, lowercase host comparison
- Name: German umlaut transliteration (ü↔ue, ö↔oe, ä↔ae, ß↔ss), legal-suffix stripping (GmbH, AG, KG, Vertriebs-GmbH, mbH, Ltd, Inc, etc.), punctuation/whitespace normalized, tokenized

Returns `{ id, company_name, matchedBy: 'name'|'website' }` or `null`.

### Contacts
- `GET /api/contacts` — All contacts with company names
- `POST /api/contacts` — Add contact
- `PUT /api/contacts/:id` — Update
- `DELETE /api/contacts/:id` — Delete
- `POST /api/contacts/enrich` — AI enrichment (job title, email, LinkedIn)

### Activities & Follow-ups
- `POST /api/activities` — Log activity
- `GET /api/activities/follow-ups` — Pending follow-ups
- `PUT /api/activities/:id/snooze` — Snooze by N days
- `PUT /api/activities/:id/done` — Mark complete
- `GET /api/activities/recent` — Recent 15 activities

### Orders & Commissions
- `GET /api/orders` — All orders with company names
- `POST /api/orders` — Create (auto-calculates commission)

### Research & AI
- `POST /api/research/contacts` — AI contact discovery
- `GET /api/research/history` — Past research sessions
- `POST /api/research/save` — Save research as new/existing company

### Export
- `GET /api/export/customer-tracker` — Comprehensive Excel export

### Settings & Users
- `GET/PUT /api/settings/llm` — LLM provider config
- `GET/POST/PUT /api/users` — User management

## AI Qualification Logic

### How It Works
1. Fetches company data from DB + website HTML snapshot
2. Sends to LLM (Gemini with web search enabled) with detailed prompt
3. LLM returns structured JSON: score, fit, priority, contacts, sales scripts
4. Updates company record and auto-adds discovered contacts

### Lead Status Flow
`RAW` -> `ENRICHED` -> `QUALIFIED` -> `APPROVED` -> `IN_OUTREACH` -> `CONTACTED` -> `OPPORTUNITY` -> `WON`
Side paths: `DISQUALIFIED`, `LOST`

### AI Category -> Status Mapping
- STRATEGIC_PARTNER -> APPROVED
- BEARING_CUSTOMER -> QUALIFIED
- LOW_FIT -> ENRICHED
- NO_FIT -> DISQUALIFIED

### Lead Priority Classification (by Ahmad Khan)
- **HIGH_PRIORITY**: 20-2000 employees, OEM/Manufacturer (of products that USE bearings), extreme environments, R&D capability, industry multiplier potential
- **STRONG**: 20-2000 employees, manufacturer OR distributor/bearing trader, some but not all key features
- **LOW_PRIORITY**: Some relevance but lower level, occasional bearing needs
- **NOT_A_TARGET**: Competitors, pure service providers, wholesalers/retailers without manufacturing

### Critical Exclusion Rules
1. **Competitors**: Companies that MANUFACTURE bearings as their primary product = NOT_A_TARGET (score 0). Bearing manufacturers, producers with in-house ceramic/hybrid bearing lines.
2. **Non-manufacturing wholesalers/retailers**: Mail-order, general distributors without engineering = NOT_A_TARGET (score 0).
3. **Subsidiaries of competitors**: Also NOT_A_TARGET.
4. **Note**: Bearing TRADERS/DISTRIBUTORS who RESELL (not manufacture) bearings ARE valid prospects as sales channel partners.

### Known Not-A-Target Examples (from QC feedback)
- M+W Dental Muller & Weygandt GmbH — dental mail-order/wholesaler, no manufacturing
- Artur Kupper GmbH & Co. KG — direct competitor (conveyor bearings)
- HQW Precision GmbH — direct competitor (precision ceramic/hybrid bearings)
- HWG Horst Weidner GmbH — direct competitor (full ceramic and hybrid bearings)
- RWG Germany GmbH (Kaman Corp) — direct competitor (aerospace bearings)

## Sintertechnik Product Context
- **Full ceramic bearings**: ZrO2, Si3N4, Al2O3 — for corrosive, hygienic, high-temp environments
- **Hybrid ceramic bearings**: Steel races + ceramic balls — higher speed, longer life, reduced maintenance
- **Ceramic components**: Shafts, bushings, rollers, seal seats
- **Key applications**: Pumps, food processing, pharma, chemical, desalination, oil & gas, vacuum, cryogenic, electroplating

## Default Team Members
Sageer A. Shaikh, Ahmad Khan, Dr. Jochen Langguth, Dr. Juergen Schellenberger, Christoph Langguth, Patton Lucas, Dr. Kathrin Langguth

## Key Industries
Bearing Traders/Distributors, Oil & Gas, Food & Beverage, Pharma, Chemical, Desalination, Cement, Power Generation, Mining, Automotive, Textile, Vacuum, Cryogenic, Universities, Robotics, Electroplating, Industrial Distributors
