# Innovista Research AI

A project-based workspace for training analysis, lead research and evidence-led qualification. Sintertechnik is the starter project; create additional projects for other businesses or research briefs.

## Start locally

Requires Node.js 22.16+ and npm. Node.js 24 is also supported.

```sh
npm install
npm run dev
```

Open [the sign-in page](http://localhost:3000). The public screen always shows username and password login. The app listens only on `127.0.0.1` by default. Default passwords and sessions from the previous system no longer work.

For a fresh installation, start the app once, then run `npm run admin:init` in another terminal on the server computer. This creates the initial `admin` account with a unique random password displayed once in that terminal. It refuses to replace existing accounts. Optional username and display name: `npm run admin:init -- your-username "Your Name"`. Account provisioning is separate from the login screen; additional accounts are created by an administrator inside **Workspace settings**.

Configure Gemini or a public HTTPS OpenAI-compatible provider in **Workspace settings**, or copy `.env.example` to `.env.local` and configure the server environment. AI keys are never included in the browser bundle.

## Research workflow

1. As an administrator, open **Workspace settings → Workspace administration → Create research project** and enter its business website and research objective.
2. **Build the training library** using PDF, DOCX, Markdown, text, written notes and captured public website pages. Open a source to inspect the extracted text or download the original document.
3. **Analyze training** to generate a proposed rubric. Review the business context, positive criteria, exclusions and open questions. Save the draft, resolve open questions and choose **Approve & publish**.
4. **Add or import leads** into that project. CSV, TSV, JSON and XLSX support company, website, location, industry, contact and notes fields. Import up to 5,000 rows / 4 MB; only the name is required. Duplicate matching stays within the project; choose whether to skip or update matches. Invalid rows and unusable websites are reported.
5. **Qualify leads** individually or in batches of up to 20. The app captures the lead website and up to two relevant internal links, evaluates every training rule, and stores the evidence and result.
6. **Review the reasoning** and source excerpts. Record a human decision with written reasoning. Export the project's qualification results as CSV when needed.

Fit scores are computed from the proportion of positive criteria that match. Confirmed exclusions set the fit score to zero. Low-confidence, missing-evidence and uncertain results go to review. Changing training or lead context marks earlier results for requalification; previous analyses and human reviews remain available.

Training here means approved project context and qualification rules supplied to the AI, not model fine-tuning. No fabricated demo results are used in the live app. Calling assignments, append-only call logs and email outreach accompany qualification; commissions, orders and CRM pipelines remain outside the product.

## Email funnels and responses

1. An administrator configures the shared SMTP mailbox and **Copy every outreach email to** in Workspace settings. Copies use BCC. Passwords remain encrypted on the server.
2. Open a project's **Email funnels**, create a named audience and edit up to three messages. Choose the first delay after enrollment and subsequent delays after the previous accepted message (for example 0, 3 and 7 days). Merge fields are checked before enrollment and sending.
3. Add current qualified leads in the funnel or select them in Lead research and choose **Add to funnel**. Enrollment is atomic, duplicate enrollment is skipped and a recipient can have only one active sequence.
4. Review the sequence and explicitly start it. Starting requires `INNOVISTA_ORIGIN` set to the public HTTPS app origin, a configured mailbox and a copy address. Keep the app server running and that origin reachable for unsubscribe links. Local drafts can be prepared without delivery setup.
5. The server processes at most one due message per minute, persists progress across restarts, and supports pause/resume. There is no catch-up burst. Pausing cannot recall messages already handed to SMTP.
6. Open **Mailbox** for Inbox, Outbox, Sent and your private drafts. An administrator connects SMTP for sending and optionally enables incoming IMAP in **Workspace settings**. Click **Verify & sync** to verify the saved incoming connection. Matched replies appear on their lead and stop applicable follow-ups; link unmatched mail to its company before replying. Record interest, conversion and unsubscribe requests deliberately in the lead's **Email** tab. Qualification remains unchanged. Unsubscribe links suppress further emails automatically after confirmation or an email client's one-click POST.

Every lead's **Email** button opens its saved draft or the **Support email** template. Edit it, choose another project/starter template or use the block designer, then click **Send**. Connecting email never sends saved drafts automatically. See [mailbox setup](docs/mailbox-setup.md) for incoming authentication, sync limits and provider requirements.

Individual outreach and funnels share a maximum of three accepted or uncertain sends per recipient across the workspace. Opt-outs and send counts survive lead deletion and reimport. A changed lead, training version or project assignment blocks scheduled delivery pending review. Failed or interrupted SMTP attempts are never automatically retried when delivery may already have happened; inspect the mailbox before contacting again.

See [the meeting review](docs/meeting-updates.md) for the mapped requests and unresolved form/ticket integration references.

## Existing data from the previous system

First startup reads `sintertechnik.db` without modifying it and imports every company into Sintertechnik. The original company row and previous reasoning are retained as historical context. Contacts, activities, notes and research sessions are copied into immutable, project-scoped reference records. Their original fields and dates remain visible in each lead's **Existing research** section, and earlier activity appears in Research history. Orders and every original record remain in the old database.

Existing Innovista installations receive this reference restoration once on restart. It preserves current company edits, source documents, training versions and decisions. Lead revisions advance once so earlier qualifications can be refreshed with the additional context. Subsequent restarts do not duplicate the records or keep invalidating research.

Sintertechnik's overview retains its brand, product families and target applications. Its company details, product opportunities and technical observations are available as explicitly historical, unverified evidence in new qualification runs. Contact name, email and phone fields stay out of AI requests. Previous decisions never become current decisions automatically; approved training and current website evidence remain required. Other projects retain their own context.

The original qualification handbook is attached to Sintertechnik. Its official website is captured on first startup when reachable. The migrated rubric requires review and publication before qualification; old qualification statuses are not treated as results of the new training.

The active database is `data/innovista.db`. API keys use AES-256-GCM encryption with `data/.innovista-encryption-key`, unless a master key is configured in the environment. **Back up the database and its encryption key together.** Losing the key makes stored provider credentials unreadable. Stop the app before copying the data directory, or use SQLite's online backup API; do not copy just a live WAL-mode database file.

Legacy provider settings are migrated when possible. An encrypted legacy key needs the previous system’s own key, which is still named `.sinteriq-encryption-key` / `SINTERIQ_ENCRYPTION_KEY` because that is what exists on disk and in existing environments. If it cannot be decrypted, re-enter the provider key in settings. The original database remains unchanged.

`GET /api/health` queries the active database's initialization record. It returns HTTP 200 with `database: "connected"` when readable, or HTTP 503 with `database: "unavailable"` if that check fails. It does not expose file paths, records or raw database errors.

## Security and deployment

All business APIs require an authenticated server session. Passwords use salted scrypt hashes. Sessions expire after 12 hours and are revoked on logout, password changes or account deactivation. Writes require CSRF and request-verification headers. Administrator privileges are explicit roles, not inferred from names.

Researchers can access only assigned projects. Administrators manage project creation, settings and team assignments. Project-scoped queries separate research context within one organization; this is not a multi-tenant client portal. Every member can change their own password from Workspace settings.

For production:

```sh
npm run build
npm start
```

Set `INNOVISTA_ORIGIN` to the exact HTTPS origin, configure TLS at the reverse proxy, and supply `INNOVISTA_SETUP_TOKEN` for initial remote account creation. Set `HOST` explicitly if binding beyond localhost. Set `INNOVISTA_TRUST_PROXY=1` only behind one trusted reverse proxy. Production cookies require HTTPS. The app refuses production startup without an HTTPS origin.

Use OS permissions and encrypted storage/backups for company data and documents. File modes are restrictive on POSIX; on Windows, apply an ACL limiting the data directory to the server account. Only provider API keys and mailbox passwords are encrypted by the application itself. Keep data and secrets out of source control.

Website requests reject private/reserved networks, validate redirects and pin validated DNS addresses. Provider endpoints must use public HTTPS and cannot redirect requests containing credentials. AI requests have timeouts and concurrency/rate limits. Public pages only are supported; paste text when a page is blocked, requires JavaScript or needs authentication.

[The deployment runbook](docs/DEPLOYMENT.md) covers the containerized deployment: the Docker image, the isolated Compose stack, the host nginx vhost and TLS, the Jenkins pipeline, first-administrator setup and volume backups.

See [the upgrade review](docs/upgrade-review.md) for findings, remediation, migration details and operating limits. Removing the old database from tracking does not erase previous Git history or distributed copies.

## Development and validation

```sh
npm run lint     # Strict TypeScript checks
npm test         # API, security, migration and document-extraction tests
npm run build    # Production frontend
npm run check    # Type check, tests and build
npm audit        # Dependency advisories
```

Tests use temporary databases and mocked AI responses, with real PDF and DOCX extraction. They never read `.env.local` or call a paid AI provider. For a disposable browser test environment, build and run `node --import tsx tests/browser-preview.ts`; its source documents clearly labeled test credentials and fixtures. This server is separate from the real data directory and uses port 3100.

A CI workflow runs checks and the dependency audit on pushes and pull requests. Runtime secrets and databases are ignored by Git. The legacy database deletion in this change is a removal from version control; its working copy is preserved.

## Code map

| Location                                     | Responsibility                                                    |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `server.ts`                                  | Startup, development frontend and production static serving       |
| `server/app.ts`                              | Project, training, source, lead and review API                    |
| `server/auth.ts`                             | Accounts, passwords, sessions, CSRF and roles                     |
| `server/database.ts`                         | Schema, transactional legacy migration and audit events           |
| `server/bootstrap.ts`                        | One-time starter website capture                                  |
| `server/ai.ts`                               | Provider requests, training analysis and qualification validation |
| `server/network.ts`                          | Safe public website access and source-link discovery              |
| `server/documents.ts` / `document-worker.ts` | Isolated document extraction                                      |
| `server/secrets.ts`                          | Encrypted provider-key storage                                    |
| `shared/types.ts`                            | Shared project, source, training and qualification types          |
| `src/App.tsx`                                | Project library, project overview and navigation                  |
| `src/Training.tsx`                           | Sources, training analysis, rubric editor and versions            |
| `src/Leads.tsx`                              | Lead research, import/export, evidence and review                 |
| `src/Settings.tsx`                           | Provider, account and team settings                               |
| `tests/`                                     | Regression tests and disposable browser fixture                   |
| `docs/legacy/`                               | Archived documentation for the old CRM                            |
