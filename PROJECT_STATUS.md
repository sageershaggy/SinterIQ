# Innovista Research AI — status

Innovista Research AI replaces the previous sales CRM with project-specific training analysis, lead research and evidence-based qualification, plus per-lead calling assignment and call logging. The work is merged to main.

## Latest change: feedback 4 — status follows the score, evidence for every claim

- **Status mapping.** The server decides the status from the fit score: 50–100 Qualified, 0–49 Not a target, and an exclusion met with a source is Not a target at 0. Needs review is kept for a research or verification blocker only — a website on record that could not be read, evidence about a different company, or an unverified exclusion on a lead scoring 50 or more — and the lead page lists it. Missing details lower the score instead of sending a lead to review. The old override (no website, confidence under 70, any gap or a score under 70 meant review) is gone. The "C1, C2…" in the training graph are only the numbers of the current criteria.
- **Evidence.** A rule counts as met only with a cited page fetched from the web, or with the team's own imported lead-list data, labelled as such. Citations are read back however the model writes them, and a citation of something never supplied no longer discards the run: that claim is not counted and the gap says so. Nonprofit or government status alone never meets an exclusion that also requires something else; the evaluation looks for the project's opportunity first and shows it with its source.
- **Service categories.** The training lists the services a project sells; each qualification rates the lead's fit for each one (good / possible / no need shown, with sources), shown in a Service fit column and filter.
- **Conflicting details.** When the company's own website states a different location, industry or size than the record, the lead page shows both with the quoted sentence, and "Use website value" saves it as a recorded edit. Phase 3 changes this for imported values — see below.
- **Qualification jobs.** Requalifying many leads runs on the server, one lead at a time per project, with progress and Stop qualification; project-wide runs are administrator-only. The 20-lead batch has a Stop button too, and research on a lead continues into its qualification.
- **Lead list.** Six clickable count cards, an AI qualified and a Qualified by AI filter, a shorter Filters panel, sortable column headers.
- **Funnels.** Search, filters and sort, and per-funnel counts Enrolled → Sent → Opened → Replied → Follow-up → Bounced with open and reply rates. Opens are counted with a 1×1 image per funnel message (on by default, switchable per funnel), served publicly at `/e/o/…`.
- **Import.** An optional quick screen of the rows against the published training before importing; only the chosen groups are saved, rejected rows can be downloaded, and the imported leads can be sent straight to the detailed qualification.

### Deploying it

- No new dependencies, environment variables or deploy-file changes: build `main` with the existing Jenkins job.
- New tables and columns are additive and are created on startup (`qualification_jobs`, `qualification_job_items`, `funnel_message_opens`, `funnels.updated_at`/`track_opens`, `leads.service_fit`, `leads.list_data`). Nothing existing is rewritten.
- The open-count image is served under `/e/o/` by the app itself; the host nginx already proxies every path, and `INNOVISTA_TRUST_PROXY=1` in docker-compose.prod.yml keeps its rate limit per visitor.
- After deploying, an administrator opens **Training → Requalify every lead…** once, so results saved under the old status rules are redone under the new ones.

## Phase 3 — researched values are the current values, and leads keep their rating

- **Research wins over imported data (D1).** When qualification finds the company's own website stating a different city, country, industry or size than an imported value, the website's value becomes the lead's current value as the run is saved, and the run stays current. A value someone typed is never replaced: that one stays a visible conflict with "Use website value". Every change of a company detail is recorded with who set it (import, person or research) in the new `lead_field_history` table, so the original imported value is never lost.
- **Evidence apart from the value (D2).** The Company card shows the current value with "Verified by research", the quoted sentence and its page under "Source evidence", and the replaced imported value only inside "Original imported value". The lead's Recent activity lists each replacement.
- **Leads stay, with their rating (D3, D4).** Re-importing a list never creates a second lead and never touches a status, score or run; updating duplicates never puts back a value research verified or a person typed, and the import preview shows each existing lead's status and score. A failed or stopped rerun keeps the previous result. A result that is out of date (the record or the training changed) keeps its decision and score on show, marked out of date, in the list and on the lead page.
- **Deploying.** One additive table, `lead_field_history`, created on startup. On first start it adopts the leads the audit log shows were created or edited on the lead form as typed by the team (every company detail, since an edit never recorded which field it changed), so research does not replace them; leads only ever imported count as the original record, which research may replace; and a value already cited as researched counts as research.

## Remaining

- IMAP is read only far enough to auto-match replies to mail this app sent: bounded plaintext previews of new messages in one folder. Full thread history, attachments, other folders and correspondence the app did not send remain outside it, so anything ambiguous still has to be linked to a lead by hand.
- Assignee notifications are recorded in the app for administrators and project members. Real delivery to the assigned person — email or push, addressed to that account alone — is still missing.
- Opens are approximate by nature: some mail apps load images automatically, others block them, and opening the project's own copy counts too.

See [README.md](README.md) for setup, [docs/upgrade-review.md](docs/upgrade-review.md) for the review and migration behavior, and [docs/legacy/PROJECT_STATUS.md](docs/legacy/PROJECT_STATUS.md) for the previous project history.
