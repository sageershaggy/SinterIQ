# Innovista Research AI upgrade review

The application now centers on project knowledge, training analysis, lead qualification and evidence. Sintertechnik is the initial project; new projects use their own documents, websites, rules and leads.

## What changed

| Previous application                                          | Innovista Research AI                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sintertechnik-specific CRM and AI prompt                      | Reusable projects with independent training libraries                                         |
| Hardcoded product rules and exclusion prefilter               | Human-approved, versioned criteria and exclusions                                             |
| Qualification fields overwritten on companies                 | Append-only analysis history with exact training version, lead revision and source excerpts   |
| Confidence without reliable source provenance                 | Validated source references and explicit missing-evidence routing                             |
| Pipeline, outreach, contacts, orders, commissions, follow-ups | Project overview, training, lead research, review queue and research history                  |
| XLSX import/export                                            | Bounded, validated CSV import and formula-safe qualification export                           |
| Frontend credentials and predictable account passwords        | First-run administrator setup, hashed passwords, revocable server sessions and explicit roles |

Training is a project knowledge workflow: sources are analyzed into proposed rules, reviewed, saved and published. It does not fine-tune the underlying provider model. Every qualification includes the approved source snapshot and rubric in its context.

## Qualification decisions

The provider must evaluate every positive criterion and exclusion in the same order as the approved rubric. Every non-unknown finding needs source references that exist in the captured evidence. Invalid JSON, incomplete assessments and invented source IDs fail without changing the lead.

The server computes the fit score as the percentage of positive criteria that match. A supported exclusion forces a score of zero. Automated qualification requires at least 70% fit, at least 70% confidence, no unknown exclusions or reported gaps, readable public website evidence, and website support for matched rules. Missing website evidence, low confidence or unsupported findings route to human review. A supported exclusion with sufficient evidence can yield `NOT_A_TARGET`.

Confidence remains a model estimate, not a calibrated probability. Source-reference validation checks that a cited source was actually supplied; it does not prove that the source's statements are true or that every inference is correct. Human review is retained for that purpose. Reviews preserve the original AI result and require written reasoning.

Changing project context, sources or rules invalidates the current training readiness. Changing lead context invalidates its qualification. Old runs retain their original snapshots. A run cannot overwrite a newer training version, lead edit, qualification or review that arrived during analysis.

## Security findings and remediation

| Finding in previous code                                             | Change                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Predictable `firstname@135` credentials shown in the login UI        | Removed all default team credentials; administrator creates real accounts                                    |
| Auth bypass environment flag                                         | Removed; all project APIs require a server session                                                           |
| Role inferred from a name containing `sageer` or `admin`             | Explicit `admin` / `researcher` roles, enforced on the server                                                |
| Identity fallbacks to `X-User-Name` and request body                 | Actor comes solely from the authenticated account                                                            |
| Signed cookies remain usable after logout                            | Random session tokens stored only as hashes; logout, password changes and deactivation revoke sessions       |
| Cookie missing `Secure` in production                                | HTTP-only, SameSite Strict, 12-hour expiry; Secure required in production                                    |
| Browser-stored identity allowed offline entry                        | Fail-closed session checks; no localStorage authentication                                                   |
| Vite config could inject the Gemini key into browser code            | Removed secret definitions and restricted dev-file access                                                    |
| Website redirects and a second DNS resolution could bypass IP checks | Public-address checks, DNS pinning, validation on every redirect, standard ports and bounded responses       |
| Credentials could be forwarded through arbitrary provider redirects  | Public HTTPS provider URLs; POST redirects refused; changing provider origin requires a new key              |
| Unbounded HTML reads and 25 MB JSON bodies                           | 1 MB JSON/remote responses, website excerpts, upload limits and bounded AI concurrency                       |
| Unsafe file parsing surface                                          | File signatures, UTF-8 checks, ZIP expansion limits, PDF page limits and isolated timed extraction processes |
| AI failure fallback could mask incomplete results                    | Strict output validation; no qualification is stored on malformed or failed provider responses               |
| 15 dependency advisories in the baseline                             | Removed unused vulnerable packages and updated remaining dependencies; audit re-run during validation        |
| Business database tracked by Git                                     | Original database retained locally and removed from the Git index; runtime databases and keys ignored        |

Additional controls include CSRF tokens, same-origin and Host validation, security headers, production CSP, login/API/upload/AI rate limits, project-scoped queries, transactional imports, optimistic revision checks, encrypted API keys, and no raw provider errors returned to clients.

## Data migration

First launch creates `data/innovista.db`. The old database is opened read-only. All companies are migrated to the Sintertechnik project, with their full original rows retained in `legacy_json`. Useful identity, product and sizing information becomes research context. Previous qualification and human review notes remain visible as historical context. Migrated leads begin unreviewed so old decisions are not mistaken for results of the new training system.

All original contacts, activities, orders, commissions, notes and research history remain in the original database and are not deleted. Contacts, activities, notes and research history also have immutable copies in the redesigned workspace, scoped to their original project and company. They are reference material for research; the previous sales workflows remain retired. The old technical documentation is archived in `docs/legacy`.

The additive reference migration works on existing installations, preserves current edits and decisions, and runs once. It advances affected lead revisions so previous results are marked for requalification with the newly available historical context. Original company fields, previous qualification reasoning, product opportunities, contact details and technical observations are visible in lead details. Sintertechnik's overview restores its branding and product/application brief; new projects do not inherit this business identity.

Earlier company research and technical observations may be supplied to AI as historical, unverified evidence and retained in the new run's evidence snapshot. Contact name, email and phone fields are excluded. Current evidence and approved training still control qualification; previous scores and statuses are retained only as reference.

The original qualification instructions become a training document. The official Sintertechnik website is captured once on first launch; if unavailable, the project history records that it must be captured later. The starter rubric stays a draft until its open questions are resolved and a person approves it.

Stored LLM settings are migrated. Encrypted legacy keys need the original `.sinteriq-encryption-key` or `SINTERIQ_ENCRYPTION_KEY`. If unavailable, the new app records a migration notice and requires the key to be re-entered. The old database is unchanged.

Migration is transactional and idempotent. Restarting never imports a company twice. Preserve the old database until the migration has been reviewed.

## Validation and operating limits

Automated tests cover authentication, CSRF/origin/Host checks, session revocation, authorization, source/lead project boundaries, training requirements, snapshots, stale writes, concurrent qualification, malformed AI output, missing evidence, imports, formula-safe exports, encryption, migration, public URL checks, and real PDF/DOCX extraction. AI-provider responses and website content in the API tests are deterministic fixtures; the tests do not incur provider charges.

Browser validation uses a disposable database with clearly labeled QA companies and a mock AI provider. The real starter website fetch is checked separately. A live paid-provider qualification requires configured credentials and approved training; it is not implied by the mock tests.

The product is a shared-team workspace with per-project assignment: a researcher reaches only the projects an administrator assigned to them, and administrators manage accounts, assignments and provider settings. Assignment is enforced on every project-scoped route, and an unassigned project answers 404 rather than 403 so membership cannot be probed by ID. It is an access boundary within one organization's workspace, not a tenancy boundary between independent client organizations sharing a deployment.

Qualification also captures a business contact when — and only when — the captured website evidence itself published one; a name cited to lead notes, earlier research or nothing at all is discarded and recorded as a gap. Contacts are personal data: they are stored per lead, exported with the qualification, and erasable from the lead detail. Earlier research and contact channels migrated from SinterIQ are still excluded from AI requests.

The server derives the outreach band from its own fit score: 80–100 call-ready, 70–79 email, 50–69 review with the client, and nothing below 50. An unresolved decision is always a review regardless of score, and a superseded result advertises no outreach step. The generated call opener is a starting point grounded in the captured evidence; it is not a verified claim about the company, and the researcher checks it before contacting anyone.

A qualified lead can be assigned to one researcher for calling. Assignment is refused for an account that cannot already reach the project, so it never widens access. Assigned leads appear in the review queue, and each researcher can filter to the leads assigned to them. Calls are logged there with an outcome and notes; the log is append-only and never changes the qualification, the fit score or the decision. Lead records also carry city, employee count and a contact person with phone and email — entered by a researcher or filled from the website when the company publishes them — and these travel with the CSV import and export.

Lead feedback records a reviewer's correction as project knowledge. It never rewrites the stored analysis, the lead's decision or a human review. Adding feedback invalidates the published training; the next published version folds the accumulated corrections into its snapshot and the analysis step rewrites the criteria and exclusions around them.

The current implementation researches supplied company websites and relevant internal links. It does not perform broad prospect discovery, generate contact details, or crawl authenticated sites. JavaScript-only, scanned, blocked or unavailable sources need readable source text. Website sources retain captured excerpts, not a continuously refreshed mirror.

Production requires an HTTPS origin, TLS termination and restricted filesystem access. Rate limits and work concurrency are local to one server process; use a shared limiter/queue before scaling horizontally. Database content and uploaded documents are not encrypted by the app; protect storage and backups at the OS/volume layer. API keys are encrypted separately.

Removing the old database from tracking does not remove it from existing Git history or previously distributed copies. History cleanup, secret rotation if any were exposed, and deployment-specific penetration testing remain separate operational work; no history rewrite or deployment is performed by this upgrade.

Security reference material: [Express production security](https://expressjs.com/en/advanced/best-practice-security/) and [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). The seeded website is [Sintertechnik's official site](https://www.sintertechnik.com/).
