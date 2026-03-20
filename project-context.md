# Sintertechnik Lead Analyzer & Company Research Tool
## Technical Specification Document v1.0
### Date: 19 March 2026 | Author: Sageer A. Shaikh — Innovista Digital Solutions LLC

---

## 1. PROJECT CONTEXT

Sintertechnik GmbH is a German precision ceramics/bearings manufacturer expanding into new markets (DACH, GCC, UK/IE). Innovista Digital Solutions LLC (Sageer) handles data mining, lead research, qualification, and regional sales representation.

The team currently works with D&B Hoovers for company/contact extraction, Excel for data management, and manual processes for tracking. This tool replaces manual Excel workflows with a structured, searchable, trackable system.

### Business Problem
- No centralized system to track lead lifecycle from raw extraction → qualification → outreach → deal closure
- No visibility into which leads were contacted, when, by whom, and what happened
- Commission tracking is manual — need automated calculation based on signed agreement tiers
- Team is distributed (Germany, Russia, Pakistan, UAE, Philippines) — need shared visibility
- Quality assurance on lead data has no structured process
- No way to measure pipeline health or forecast potential revenue

### Users
| User | Role | Primary Actions |
|------|------|----------------|
| Sageer (UAE) | Data Mining & Regional Rep | Import leads, enrich data, track outreach, view commissions |
| Ahmad (Pakistan) | Technical Qualification | Validate technical fit, score leads, approve/reject |
| Jürgen (Russia) | Sales Coordination | View qualified pipeline, assign to sales, track outcomes |
| Jochen (Germany) | CEO / Strategic | Dashboard overview, pipeline health, revenue tracking |

---

## 2. HIGH-LEVEL ARCHITECTURE

### Tech Stack (Prototype)
```
Frontend:  React (Vite) + Tailwind CSS + shadcn/ui components
Backend:   Node.js + Express (lightweight API)
Database:  SQLite (prototype) → PostgreSQL (production)
Charts:    Recharts
File I/O:  SheetJS (xlsx parsing), PapaParse (CSV)
Auth:      Simple role-based (4 users, no OAuth needed for prototype)
Deploy:    Local / Docker for prototype
```

### System Diagram
```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND (React)                   │
│                                                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │Dashboard │ │ Company  │ │ Contact  │ │ History │ │
│  │& Pipeline│ │ Research │ │ Manager  │ │ Tracker │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘ │
│       │             │            │             │      │
│  ┌────┴─────────────┴────────────┴─────────────┴────┐│
│  │              State Management (Context)           ││
│  └───────────────────────┬───────────────────────────┘│
└──────────────────────────┼────────────────────────────┘
                           │ REST API
┌──────────────────────────┼────────────────────────────┐
│                    BACKEND (Express)                   │
│                                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Import   │ │ Company  │ │ Activity │ │Commission│ │
│  │ Service  │ │ Scoring  │ │ Logger   │ │Calculator│ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │             │            │             │       │
│  ┌────┴─────────────┴────────────┴─────────────┴────┐ │
│  │                  SQLite Database                   │ │
│  └───────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

---

## 3. DATABASE SCHEMA

### Tables

#### companies
```sql
CREATE TABLE companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name    TEXT NOT NULL,
  country         TEXT NOT NULL,          -- DE, AT, CH, AE, SA, QA, BH, OM, KW, GB, IE
  city            TEXT,
  region          TEXT,                    -- DACH, GCC, UK_IE
  industry        TEXT NOT NULL,           -- From target industries list
  company_type    TEXT NOT NULL,           -- BEARING_TRADER, MANUFACTURER, DISTRIBUTOR, UNIVERSITY
  employee_count  INTEGER,
  revenue_eur     REAL,
  website         TEXT,
  corporate_parent TEXT,                   -- Parent company name if subsidiary
  is_subsidiary   BOOLEAN DEFAULT FALSE,
  duns_number     TEXT,                    -- D&B DUNS number
  source          TEXT DEFAULT 'DNB_HOOVERS', -- DNB_HOOVERS, LINKEDIN, FASTBASE, MANUAL, REFERRAL
  lead_score      INTEGER DEFAULT 0,       -- 0-100 calculated score
  lead_status     TEXT DEFAULT 'RAW',      -- RAW, ENRICHED, QUALIFIED, APPROVED, IN_OUTREACH, CONTACTED, OPPORTUNITY, WON, LOST, DISQUALIFIED
  qualification_notes TEXT,                -- One-line why this company is a target
  technical_fit   TEXT,                    -- Ahmad's assessment: HIGH, MEDIUM, LOW, NOT_FIT
  assigned_to     TEXT,                    -- Who is working this lead
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by      TEXT                     -- Who imported/created this
);
```

#### contacts
```sql
CREATE TABLE contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  full_name       TEXT NOT NULL,
  job_title       TEXT,
  department      TEXT,
  contact_role    TEXT,                    -- MAINTENANCE_MGR, PRODUCTION_MGR, RD_MGR, CTO, CEO, PURCHASING_MGR, OWNER, OTHER
  contact_priority TEXT,                   -- HIGHEST, HIGH, MEDIUM, LOW, AVOID (per ST targeting strategy)
  email           TEXT,
  phone_direct    TEXT,
  phone_mobile    TEXT,
  linkedin_url    TEXT,
  is_verified     BOOLEAN DEFAULT FALSE,   -- Has this contact been verified on LinkedIn/website?
  verified_date   DATETIME,
  verification_source TEXT,                -- LINKEDIN, COMPANY_WEBSITE, DNB_HOOVERS, PHONE_CALL
  is_primary      BOOLEAN DEFAULT FALSE,   -- Primary contact for this company
  notes           TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### activities (History Tracking — CORE FEATURE)
```sql
CREATE TABLE activities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  contact_id      INTEGER REFERENCES contacts(id),  -- NULL if company-level activity
  activity_type   TEXT NOT NULL,           -- See Activity Types below
  activity_date   DATETIME NOT NULL,
  performed_by    TEXT NOT NULL,           -- Sageer, Ahmad, Jürgen, Jochen
  subject         TEXT,                    -- Brief description
  details         TEXT,                    -- Full notes
  outcome         TEXT,                    -- POSITIVE, NEUTRAL, NEGATIVE, NO_RESPONSE, FOLLOW_UP_NEEDED
  follow_up_date  DATETIME,               -- When to follow up
  follow_up_done  BOOLEAN DEFAULT FALSE,
  attachments     TEXT,                    -- JSON array of file references
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### orders (Commission Tracking)
```sql
CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  contact_id      INTEGER REFERENCES contacts(id),
  order_reference TEXT,                    -- Sintertechnik order number
  order_date      DATETIME NOT NULL,
  order_value_eur REAL NOT NULL,
  product_type    TEXT,                    -- CERAMIC_BEARING, HYBRID_BEARING, CERAMIC_COMPONENT, OTHER
  is_hybrid       BOOLEAN DEFAULT FALSE,   -- Hybrid = separate commission terms
  commission_rate REAL,                    -- Auto-calculated from tiers, overridable
  commission_eur  REAL,                    -- Auto-calculated
  payment_received BOOLEAN DEFAULT FALSE,  -- ST received payment from customer?
  payment_date    DATETIME,
  commission_paid BOOLEAN DEFAULT FALSE,   -- Commission paid to Innovista?
  commission_paid_date DATETIME,
  innovista_contribution TEXT,             -- LEAD_GEN, INTRODUCTION, ACTIVE_SUPPORT (for "demonstrable contribution" tracking)
  notes           TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### import_batches (Track what was imported when)
```sql
CREATE TABLE import_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_name      TEXT NOT NULL,           -- e.g., "DACH_Bearing_Traders_Batch_1"
  source          TEXT NOT NULL,           -- DNB_HOOVERS, FASTBASE, LINKEDIN, MANUAL
  region          TEXT,                    -- DACH, GCC, UK_IE
  industry_focus  TEXT,                    -- Which industry this batch targeted
  total_imported  INTEGER DEFAULT 0,
  total_qualified INTEGER DEFAULT 0,
  imported_by     TEXT NOT NULL,
  imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes           TEXT
);
```

---

## 4. FEATURE SPECIFICATIONS

### 4.1 Dashboard (Home Screen)
The main dashboard gives an instant overview of pipeline health.

### 4.2 Company Research & Analysis
Filterable, sortable table with columns and detailed company pages.

### 4.3 Lead Scoring Engine
Automatic score (0-100) calculated from weighted factors.

### 4.4 Activity Logger & History Tracker
Log Activity Form, Activity Timeline View, and Follow-Up Queue.

### 4.5 Commission Calculator
Based on Amendment No. 1 signed terms.

### 4.6 Import / Export
Import from Excel (D&B Hoovers Export) and Export to Excel.

### 4.7 Search & Quick Actions
Global Search Bar and Quick Actions (Keyboard shortcuts).

---

## 5. UI/UX SPECIFICATIONS
- **Colors:** Navy (#1B3A5C) primary, Blue (#2563EB) accent, Green (#10B981) success/positive, Red (#DC2626) danger/negative, Orange (#EA580C) warning, Gray (#64748B) muted
- **Font:** Inter or system font stack
- **Cards:** White background, subtle shadow, 8px border radius
- **Status badges:** Colored pills with status text
- **Tables:** Zebra striping, sticky headers, sortable columns

---

## 6. API ENDPOINTS
- `/api/companies`
- `/api/contacts`
- `/api/activities`
- `/api/orders`
- `/api/dashboard`
- `/api/import`

---

## 7. TARGET INDUSTRIES REFERENCE DATA
Seed data for the industry dropdown, contact roles, lead statuses, regions, and commission tiers.

---

## 8. IMPLEMENTATION PHASES
- Phase 1: Core MVP (Week 1-2)
- Phase 2: Intelligence Layer (Week 3-4)
- Phase 3: Commission & Reporting (Week 5-6)
- Phase 4: Polish & Extend (Week 7+)

---

## 9. SAMPLE DATA FOR TESTING
Pre-load the prototype with 15-20 sample companies across DACH industries.

---

## 10. CLAUDE CODE INSTRUCTIONS
Instructions for building the app with Vite + React + TypeScript + Tailwind CSS + shadcn/ui + SQLite.

---

## 11. GLOSSARY
Definitions for DACH, GCC, ST, Lead Score, Technical Fit, Demonstrable Contribution, Bearing Trader, and D&B Hoovers.
