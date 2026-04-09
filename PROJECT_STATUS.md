# SinterIQ — Project Status

_Last updated: 2026-04-09_

A running snapshot of where the project is, what was done in the most recent session, and where to pick up next.

---

## What this project is
B2B sales-intelligence and lead-management platform for **Sintertechnik GmbH** (Germany) — manufacturer of precision ceramic, hybrid, and full-ceramic bearings + ceramic components. Provides AI-powered lead qualification, contact discovery, pipeline management, and sales enablement. Stack: React 19 + TS / Vite / Tailwind front, Express + better-sqlite3 back, Gemini 2.5 Flash for LLM (with web search).

For deeper architecture and conventions see [CLAUDE.md](CLAUDE.md).

---

## Current state — high level

| Area | Status |
|---|---|
| Auth / login | Working |
| Companies CRUD + bulk delete | Working |
| Pipeline kanban (drag & drop) | Working |
| Lead Research (AI contact discovery) | Working |
| AI Qualification (Gemini + web search) | Working — prompt freshly updated with QC feedback |
| Import (Excel / CSV from D&B Hoovers) | Working |
| Follow-ups, activities, notes | Working |
| Commissions admin + display | Working |
| Settings (LLM provider config) | Working |
| Users / team management | Working |
| Customer-tracker Excel export | Working |
| CSV exports (All / Filtered / Qualified / Approved / Disqualified / Selected) | Working |

---

## Session log — 2026-04-09

### 1. Export "Selected" option added to Companies tab
**Why:** When the user has rows checkbox-selected (e.g. for bulk delete), they also want a quick way to export just those rows.

**What changed:**
- [src/AppRoot.tsx:822-836](src/AppRoot.tsx#L822-L836) — added a new **Export Selected (N)** button at the top of the Export dropdown, conditionally rendered when `selectedIds.size > 0`. Reuses the existing `exportFilteredCSV` helper. Filters from `sortedCompanies`, which is safe because `selectedIds` is auto-cleared on filter changes ([src/AppRoot.tsx:325](src/AppRoot.tsx#L325)).
- Type-check (`npm run lint`) clean.

### 2. Investigation: "Qualified 208" vs Pipeline "Qualified 146" mismatch
The user noticed Companies → Export dropdown showed `Export Qualified Only (208)` while the Pipeline kanban Qualified column showed `146`. Both views use the **identical filter** (`companies.filter(c => c.lead_status === 'QUALIFIED')` — see [src/AppRoot.tsx:317](src/AppRoot.tsx#L317) and [src/KanbanBoard.tsx:78](src/KanbanBoard.tsx#L78)). Sum of statuses in the dropdown (208 + 62 + 126) already exceeded the total 349, which is mathematically impossible against a single dataset. **Conclusion:** stale data in one of the two browser tabs. Recommendation to user: hard refresh both pages — they should converge. **No code change needed.**

### 3. AI Qualifier prompt expanded with QC feedback
**Why:** Ahmad Khan's QC pass on the German lead list surfaced ~20 new false-positive patterns where the AI was over-qualifying companies. The prompt needed to encode these patterns so future qualification runs catch them automatically.

**What changed in [server.ts:1982-2055](server.ts#L1982-L2055)** (the AI-qualify prompt body):
- Restructured exclusion logic into **6 hard rules**, each with explicit named examples drawn from the QC list.
- **Rule 1 — Direct bearing competitors** now lists by name: HQW Precision, HWG Horst Weidner, RWG Germany (Kaman), Artur Küpper, TKF Thüringer Kugellagerfabrik, Wälzlagertechnik GmbH, WSW Wälzlager Wolfgang Streich, ASK-Kugellagerfabrik Artur Seyfert. Plain-bearing makers (Gleitlagertechnik Essen) flagged as adjacent.
- **Rule 2 — Subsidiaries of competitors** kept and tightened.
- **Rule 3 — Non-manufacturing wholesalers / mail-order / dealers** broken into 7 named subcategories (3a–3g): dental mail-order, plumbing/heating wholesalers, building-materials traders, construction-machinery dealers/rental, specialty-chemicals distributors, fuel/petroleum distributors, packaging consultants. Each with at least one named example from the QC list (Kurt König, M+W Dental, Elmer Bönen, Cl. Bergmann, Georg C. Hansen, Diez Fördertechnik, Atlas-Kern, Azelis, Carlofon, Erik Walther, Knüppel Verpackung).
- **Rule 4 — Utility operators** new — companies that operate energy/water/infrastructure but don't build mechanical equipment. Example: ENTEGA Plus.
- **Rule 5 — Pure service providers** new — diagnostic-lab and packaging-pooling services that USE machines but don't make them. Examples: amedes Medizinische Dienstleistungen, Cartonplast Group.
- **Rule 6 — Global enterprises outside SME profile** new — >5,000-employee companies with centralized global procurement (Fresenius Medical Care, Dow Produktions). Carve-out: KEYENCE Deutschland-style local sales/support hubs of global tech firms should be **LOW_PRIORITY** rather than NOT_A_TARGET because the right answer is "no spec authority", not "not a fit".
- **LOW_PRIORITY definition** expanded with named patterns for: static-product manufacturers (PE-PACKAGING, Artemide, OBO Bettermann), solid-state electronics (Riello UPS), solar/EPC integrators (SUNfarming), medical-textile makers using only standard rollers (Raguse), plain-bearing specialists (Gleitlagertechnik Essen), and global tech sales hubs (KEYENCE).
- **Decision checklist** restructured to 11 ordered steps so the model walks the exclusion rules before scoring.
- Type-check clean.

**Status table for the QC list (what's now encoded):**

| Pattern | Encoded under | Named in prompt |
|---|---|---|
| Bearing manufacturers (rolling) | Rule 1 | ✓ 8 named |
| Plain-bearing manufacturers | Rule 1 + LOW_PRIORITY note | ✓ |
| Bearing-competitor subsidiaries | Rule 2 | inherited |
| Dental mail-order / wholesale | Rule 3a | ✓ |
| Plumbing / heating wholesalers | Rule 3b | ✓ 3 named |
| Building-materials wholesalers | Rule 3c | (pattern only) |
| Construction-machinery dealers / forklift dealers / rental | Rule 3d | ✓ 3 named |
| Specialty-chemicals distributors | Rule 3e | ✓ 3 named |
| Petroleum / fuel distributors | Rule 3f | ✓ |
| Packaging consultants / wholesalers | Rule 3g | ✓ |
| Energy utility operators | Rule 4 | ✓ |
| Lab service providers | Rule 5 | ✓ |
| Reusable packaging pooling services | Rule 5 | ✓ |
| Global enterprises >5k emps with centralized procurement | Rule 6 | ✓ 2 named |
| Static-product manufacturers (cable trays, lighting, films) | LOW_PRIORITY | ✓ 3 named |
| Solid-state electronics manufacturers | LOW_PRIORITY | ✓ |
| Solar EPC / integrators | LOW_PRIORITY | ✓ |
| Medical textile manufacturers | LOW_PRIORITY | ✓ |
| Global tech sales/support hubs in DE | LOW_PRIORITY (Rule 6 carve-out) | ✓ |

---

## Where to pick up next

### Immediate verification work
- [ ] **Re-run AI qualification** on a sample of 10-20 of the QC-flagged companies to verify the new prompt catches them as NOT_A_TARGET / LOW_PRIORITY. Watch especially for the borderline cases (KEYENCE, OBO Bettermann, Gleitlagertechnik Essen).
- [ ] After hard-refreshing both browser tabs, **confirm Pipeline Qualified count and Companies → Export Qualified count match**. If they still diverge, dig into the API response from `GET /api/companies` directly.
- [ ] **Smoke-test "Export Selected"** in the Companies tab — select a few rows, open Export dropdown, click new option, verify CSV contents.

### Outstanding items / known gaps
- The CLAUDE.md "Known Not-A-Target Examples" list is still the older 5-company set. Consider syncing it with the expanded list now baked into the AI prompt for human-readable parity.
- No automated tests yet for the qualifier prompt — every prompt update requires manual sample-runs against the QC list.
- Customer-tracker Excel export and CSV exports are separate code paths — any new column needs to be added in both places ([src/AppRoot.tsx:180](src/AppRoot.tsx#L180) for CSV, server.ts for Excel).

### Suggested next features (not started)
- Persisted "qualifier review" workflow: when a human marks a company as NOT_A_TARGET that the AI scored higher, capture the reason and feed it back into the prompt automatically.
- Pipeline view filter (currently Pipeline shows ALL companies, doesn't honor the Companies-tab filter set).
- Bulk re-qualify action on selected companies.

---

## How to run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm run lint     # tsc --noEmit
```

Required env: `GEMINI_API_KEY`. Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`), `LLM_API_KEY`/`LLM_MODEL`/`LLM_BASE_URL` for OpenAI-compatible fallback. LLM settings can also be configured via the Settings tab UI (DB takes priority over env).
