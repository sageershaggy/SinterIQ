# Innovista Research AI

This is a project-based training, lead research and qualification workspace. Sintertechnik is one starter project, not the hardcoded identity of the platform.

## Product scope

- Projects, source libraries, training analysis, approved versioned rubrics, lead research, evidence-backed qualification, human review and history.
- Per-project team assignment, website-published business contacts, fit-score outreach bands with a call opener, lead-level training feedback, per-lead calling assignment and an append-only call log.
- One mailbox per project, with no workspace mailbox behind it: per-lead email composed from the qualification, sent deliberately from that project's own address, logged sent or refused.
- Project email funnels: up to three scheduled messages sent through the project's own mailbox, deliberate administrator activation, copy recipient, response history and recipient opt-out. No CRM pipeline, commissions, orders or unrestricted bulk email blasting.
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
- All workspace state changes require CSRF and same-origin request validation. Public email unsubscribe is a separate recipient-owned POST authorized only by an unguessable scoped token; GET never changes preferences.
- Provider keys stay server-side and encrypted at rest. Never add secret values to Vite define or VITE_ environment variables.
- Public URL fetches must use server/network.ts, including validation on redirects and DNS pinning. Never send provider credentials over redirects or private-network endpoints.
- Uploaded documents are untrusted. Retain size, signature, ZIP expansion, page-count, timeout and process-isolation limits.
- Training analysis proposes rules; only explicit publication makes a version usable.
- Lead feedback is project knowledge, never an edit: it must not rewrite a stored run, a lead decision or a review. It invalidates the published training and is folded into the next published snapshot.
- Calling assignment never widens access: only an account that can already reach the project may hold one. Logging a call must not change the qualification, fit score or decision, and the call log is append-only.
- Email: a mailbox belongs to exactly one project (project_mailboxes, keyed by project_id). Reading, saving, testing and browsing it is administrator-only and project-scoped under /api/projects/:projectId/mailbox: 403 without the administrator role, 404 for a project the caller cannot reach. The password is encrypted at rest and never returned. Resolve the sender from the project that owns the lead; there is no workspace sender to fall back to, so a project without a configured mailbox simply cannot send. Treat the SMTP host as an outbound target — public addresses on a submission port only. Strip CR/LF from every header value, escape all body interpolation, keep a named sender and a working opt-out in every message, and record refused sends rather than discarding them. Never return a raw transport error.
- Funnels stay drafts until explicitly activated. Activation requires a public HTTPS origin and that project's own configured mailbox and copy address. Recheck membership, qualification, lead revision, recipient and suppression before delivery. Enrolled sequences cannot be edited. Pace due messages to one per minute per project (meta key 'funnel_last_tick:<projectId>') so one project's queue never waits behind another's, and never retry ambiguous SMTP acceptance automatically.
- Individual mail and funnels share a three-email recipient limit and durable suppression, including after lead deletion/reimport. Both are keyed by recipient address and stay workspace-wide: separate project mailboxes must never become a way to mail the same person again. Record outreach outcomes separately from qualification and preserve their append-only history. Explicitly enabled incoming IMAP sync may record matched replies; conversion and interest remain team decisions. Unsubscribe links stop future sends automatically.
- Incoming mail: administrator-only, project-scoped TLS IMAP configuration with encrypted credentials, public DNS pinning, read-only access, bounded messages and no raw transport logs. Recheck configuration revision and the enabling administrator before saving a sync. Each project keeps its own cursor and its own account key, so two projects pointed at one inbox keep separate histories — and each ingests its own copy of every message. Keep saying so: IncomingSettings.shared_with names the other projects already polling that inbox.
- Reply matching cannot cross the project boundary. Auto-matching considers only mail the polling project itself sent: match app-generated Message-ID references and the original sender, leaving ambiguous mail for explicit linking. Linking takes a lead_id alone and that lead must belong to the project whose mailbox received the message, so a reply never reaches a lead in another project. Inbox, Outbox, Sent and drafts are narrowed to the project and browsing them is administrator-only; the per-lead reply list stays open to project members. Preserve terminal outcomes and stop applicable queued follow-ups without changing qualification. Never render inbound HTML or fetch its images. A failing mailbox records its own last_error and is reported and skipped, because one bad provider must not pause polling or delivery for every other project. It does pause its OWN project's automatic deliveries: while an enabled inbox is failing, replies are not being ingested, so the "they already replied" stop cannot fire and a sequence would keep mailing someone who has asked to be left alone.
- A contact is personal data. Keep it only when the captured website evidence cited it, never from lead notes, earlier research or inference, and keep it erasable from the lead.
- Lead research (server/enrich.ts) fills only blank fields, from the company's own website, and may never invent one. A value is recorded only if the model quotes a sentence that is really on the fetched page AND that sentence contains the value itself: the page text is in the prompt, so quoting it is free, and a check on the quote alone lets an invented phone number ride in on a real "Contact us today". Phones compare digit by digit, a headcount needs a sentence about people, and a summary field needs most of its words in the quote.
- A website is never taken on the model's word and never verifies itself. A candidate domain is fetched through server/network.ts, must still be on the guessed domain after redirects (a for-sale page prints the very name being searched for), must not be a parked, for-sale or placeholder page, and must name the company in whole words — one shared common word is not identification. There is no search provider: when nothing verifies, say so and write nothing.
- Applying research is an ordinary recorded edit, made inside a transaction against a freshly read lead: never overwrite a value someone typed while the pass was running, always pass the same validators the lead form uses, bump the revision and clear the review so the previous verdict goes stale. A discovered website that already belongs to another lead in the project refuses the whole run, because the record is probably a duplicate of that one.
- Every applied value keeps its citation in lead_research_citations, so a contact on a record can always be traced to the page and sentence it came from. Erasing a lead's contact deletes its contact citations too, because the quote usually contains the personal detail. A later qualification run must never blank a contact already on the record.
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
- Mailbox adoption (server/mailbox-schema.ts, guarded by meta key 'project_mailboxes_v1') runs once and is additive: the old workspace SMTP settings are copied to every existing project so sending keeps working, while IMAP polling, if it was enabled at all, stays enabled for only the first project (lowest id), because two projects polling one inbox would each ingest a copy and show one project's replies to another project's members. That project also inherits the legacy IMAP cursor and the mail already received. The legacy settings rows ('smtp_%' and 'imap_config') are deliberately left in place, unread.
- Starter training: docs/sintertechnik-training.md, captured official website and a draft rubric requiring human approval.
- Environment settings: .env.example. Production requires HTTPS INNOVISTA_ORIGIN and a bootstrap token for remote setup.
- Tests must use disposable directories and deterministic AI/website fixtures. Never modify the user's real database to verify behavior.
