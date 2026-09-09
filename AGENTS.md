# Innovista Research AI

This is a project-based training, lead research and qualification workspace. Sintertechnik is one starter project, not the hardcoded identity of the platform.

## Product scope

- Projects, source libraries, training analysis, approved versioned rubrics, lead research, evidence-backed qualification, human review and history.
- Per-project team assignment, website-published business contacts, fit-score outreach bands with a call opener, lead-level training feedback, per-lead calling assignment and an append-only call log.
- No CRM pipeline, commissions, orders, follow-up scheduling or bulk email sending.
- Read README.md and docs/upgrade-review.md for architecture, migration and security details.

## Stack and commands

- React 19, TypeScript strict mode, Vite 8, plain CSS and Lucide.
- Express 5, better-sqlite3, Zod, Gemini or OpenAI-compatible AI.
- Node.js 22.16+.
- npm run dev: local app on 127.0.0.1:3000. The public page is always sign-in.
- npm run admin:init: server-side initial administrator provisioning with a unique generated password; refuses to overwrite any existing accounts.
- npm run lint, npm test, npm run build; npm run check runs all three.
- npm audit for dependency verification. Prettier configuration is included.

## Required invariants

- Every source, lead, run and training lookup is scoped to its project. Never query a child record by ID alone.
- All business APIs require authenticated server sessions. Never add default passwords, auth bypasses, browser credential storage or identity-header fallbacks.
- Administrator rights use the persisted role. A researcher reaches only assigned projects; an unassigned project must answer 404 on every project-scoped route so membership cannot be probed by ID. Only administrators create projects and change assignments.
- All state changes require CSRF and same-origin request validation.
- Provider keys stay server-side and encrypted at rest. Never add secret values to Vite define or VITE_ environment variables.
- Public URL fetches must use server/network.ts, including validation on redirects and DNS pinning. Never send provider credentials over redirects or private-network endpoints.
- Uploaded documents are untrusted. Retain size, signature, ZIP expansion, page-count, timeout and process-isolation limits.
- Training analysis proposes rules; only explicit publication makes a version usable.
- Lead feedback is project knowledge, never an edit: it must not rewrite a stored run, a lead decision or a review. It invalidates the published training and is folded into the next published snapshot.
- Calling assignment never widens access: only an account that can already reach the project may hold one. Logging a call must not change the qualification, fit score or decision, and the call log is append-only.
- A contact is personal data. Keep it only when the captured website evidence cited it, never from lead notes, earlier research or inference, and keep it erasable from the lead.
- The server derives the outreach band from its own fit score. A stale or non-qualified lead has no outreach step, and a non-target keeps no call script.
- Qualification uses the approved snapshot and current lead revision. Validate every criterion/exclusion and source ID before saving.
- The server computes the fit score and conservative final decision. Missing evidence must remain visible.
- Never overwrite qualification history or the original AI result during human review.
- Training edits, lead edits and concurrent reviews must not be silently overwritten by in-flight analyses.
- Import validation is atomic. Duplicate matching is confined to a project. CSV exports neutralize spreadsheet formulas.
- Do not log raw provider errors, keys, complete prompts or uploaded document contents.

## Data and migration

- Active data: data/innovista.db and data/.innovista-encryption-key (both gitignored).
- Original sintertechnik.db is retained locally and read-only during the one-time migration. Do not delete it or its legacy encryption key.
- Migrated company rows retain legacy_json. Contacts, activities, notes and prior research have immutable project-scoped copies in preserved_research, displayed as reference material. Orders and all original records remain in the legacy database. Never overwrite existing lead edits or replace current decisions with historical ones during restoration.
- Starter training: docs/sintertechnik-training.md, captured official website and a draft rubric requiring human approval.
- Environment settings: .env.example. Production requires HTTPS INNOVISTA_ORIGIN and a bootstrap token for remote setup.
- Tests must use disposable directories and deterministic AI/website fixtures. Never modify the user's real database to verify behavior.
