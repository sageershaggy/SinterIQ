# SinterIQ — Project Status

_Last updated: 2026-05-25_

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
| Customer-tracker Excel export | Working — now includes AI fields (Phase 3) |
| CSV exports (All / Filtered / Qualified / Approved / Disqualified / Selected) | Working — adds AI Qualified Yes/No + disqualification context (Phase 3) |
| **GCC Marketing tab** | New — region=GCC + QUALIFIED/APPROVED, marketing-pack CSV |
| **Disqualification flow** | New — required reason + 11-category taxonomy (Phase 1) |
| **Not-a-Target tab** | New — unified AI-flagged + human-disqualified list |
| **Review Queue tab** | New — human QC for low-confidence AI qualifications (Phase 2) |
| **Import dedup** | Hardened — umlaut/suffix/website normalization (Phase 4) |
| **AI token optimization** | New — cheap pre-classifier short-circuits obvious NOT_A_TARGETs (Phase 5) |

---

## Session log — 2026-05-25

### Phase 1 — Disqualification + Not-a-Target UI
**Goal:** Force a reason when marking leads disqualified so future QC reviewers see why.

**Schema:** 4 new columns on `companies` (`disqualification_reason`, `disqualification_category`, `disqualified_by`, `disqualified_at`).

**Endpoints:**
- `POST /api/companies/:id/disqualify` — required `{ reason, category, by }`; sets status=DISQUALIFIED, lead_priority=NOT_A_TARGET, auto-marks human_reviewed
- `POST /api/companies/:id/restore` — clears all disqualification fields, reverts status to ENRICHED
- `PATCH /companies/:id/status`, `PUT /companies/:id`, `PATCH /companies/:id` — now reject lead_status=DISQUALIFIED from any other state

**Frontend:** `DisqualifyModal` with category-aware quick-pick reasons; `NotATargetTab` (combined AI-flagged + human-disqualified, with restore); banner on `CompanyDetail` when applicable.

### Phase 2 — Manual Review Queue
**Goal:** Sales team systematically QC the AI's output instead of trusting blindly.

**Schema:** 4 new columns (`human_reviewed`, `human_reviewed_at`, `human_reviewed_by`, `human_review_notes`).

**Endpoints:** `POST /:id/mark-reviewed`, `POST /:id/unmark-reviewed`.

**Frontend:** `ReviewQueueTab` lists AI-qualified leads with confidence <70% (or null) not yet reviewed. Per-card actions: "Looks good", "Disqualify" (opens modal), inline "+ Add note" (Phase 2 + addendum). Marking either way removes from queue.

### Phase 3 — Export fixes
**Excel customer-tracker:** appended 13 AI columns at the end (Lead Status, Lead Priority AI, AI Qualified At, AI Confidence, Approach Strategy AI, Opportunity Notes AI, Sales Script AI, Email Script AI, Qualification Notes, Disqualification Category/Reason/By, Human Reviewed).

**CSV exports:** added explicit "AI Qualified Yes/No" column + AI confidence + full disqualification context. New filter dropdown options: "Qualified but never AI-qualified" (diagnostic for the user's complaint about missing notes) and "Needs human review".

### Phase 4 — Import dedup
**Goal:** Stop creating duplicates when the same company appears with umlaut/suffix variants.

`normalizeCompanyNameForMatch()`: German umlaut transliteration (ü↔ue, ö↔oe, ä↔ae, ß↔ss), expanded legal-suffix list (GmbH, mbH, KG, AG, OHG, eG, e.K., Vertriebs-GmbH, Ltd, Inc, LLC, Holding, Group, Deutschland, etc.).

`findExistingCompanyByMatch(name, website)` — single helper now used by both `POST /companies` and `POST /companies/import`. Returns `{ id, company_name, matchedBy: 'name'|'website' }`.

Import response now includes `total`, `created`, `merged` counts; UI surfaces both.

**Bonus bugs fixed:**
- Pre-existing INSERT bug: 25 `?` placeholders vs 24 bound values in `POST /api/companies` was throwing 500 on every new-company create
- Double-push in import response counting

### Phase 6 — Cleanup + hardening
**Goal:** finish remaining items from the punch list — identity propagation, encryption at rest, fuzzy dedup, indexed lookups.

**Identity propagation:**
- Frontend installs a global fetch wrapper that attaches `X-User-Name` header to every `/api/*` call
- Backend `getRequestUser(req)` reads it; falls back to `body.by` then `'System'`
- Removed hardcoded `'Sageer A. Shaikh'` from `POST /companies`; import endpoint also records caller now

**Encryption at rest:**
- AES-256-GCM, format `enc:v1:<base64(iv|authTag|ciphertext)>`
- Master key from `SINTERIQ_ENCRYPTION_KEY` env or auto-generated `.sinteriq-encryption-key` (gitignored, mode 0600)
- Startup migration encrypts any legacy plaintext key found in `app_settings`
- `GET /api/settings/llm` returns masked preview only (`sk-o••••2e94`)

**Dedup overhaul:**
- Stored normalized keys: `company_name_key`, `website_key` columns + indexes (idx_companies_name_key, idx_companies_website_key)
- Backfill on startup for any row missing them; insert/update paths populate going forward
- `findExistingCompanyByMatch` switches from O(N) full scan to O(log N) indexed lookup
- Levenshtein fuzzy fallback (threshold 0.85 long / 0.92 short) catches concatenated-word variants
- Suffix-stripped compact comparison handles cases like "Phase6TestCoGmbH" ↔ "Phase6 Test Co"

**Cleanup:**
- Removed 4 dead files (App.tsx, ContactsTab.tsx, UsersTab.tsx, TrackingTab.tsx)
- 8 FK indexes added for hot join paths
- `scripts/audit_duplicates.mjs` standalone audit script
- Review Queue gets bulk-select + bulk-approve

**Smoke tested end-to-end:** all five paths verified — identity, encryption migration, exact dedup, fuzzy dedup, false-positive guard.

### Phase 5 — Token optimization
**Goal:** Cut LLM cost on `/ai-qualify`. The deep prompt is ~25k chars per call.

**Pre-classifier (Pass A):** Cheap call with only `name + country + industry + 800-char website snippet`. No web search. Asks: target / uncertain / not_target with category and confidence. If verdict=LIKELY_NOT_TARGET and confidence≥75, auto-disqualifies with `disqualified_by='AI Pre-classifier'` and skips the deep prompt entirely.

**Bypass:** `?skip_prefilter=true` query param forces deep pass.

**Website context (Pass B):** Reduced from 6000 chars / 9 paths → 3000 chars / 4 paths. ~50% saving on the largest variable input.

**Expected savings:** roughly half of obvious-no leads will short-circuit at ~10% the cost of a deep call. Real numbers need an A/B against Ahmad's QC list.

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

Required for AI features: add a key in the Settings tab UI or configure `.env.local`. Gemini uses `GEMINI_API_KEY`/`GEMINI_MODEL`; OpenRouter, Qwen, DeepSeek, Kimi/Moonshot, GLM/Z.AI, and other OpenAI-compatible providers use `LLM_API_KEY`/`LLM_MODEL`/`LLM_BASE_URL`/`LLM_PROVIDER_NAME`. Settings saved in the UI take priority over env.
