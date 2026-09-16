# Innovista Research AI — status

Innovista Research AI replaces the previous sales CRM with project-specific training analysis, lead research and evidence-based qualification, plus per-lead calling assignment and call logging. The work is merged to main.

## Latest change: a mailbox per project

Email belongs to a project now, not to the workspace. Each project keeps its own SMTP sending settings and its own optional IMAP polling in `project_mailboxes`, with its own inbox cursor, its own mail folders, its own one-send-per-minute funnel pacing and its own last error. Mailbox settings and mail folders are project-scoped and administrator-only, while the replies shown on a lead stay open to that project's team. Reply matching considers only mail the same project sent, so a reply can never appear on a lead in another project. A failing provider is reported and skipped instead of pausing delivery for everyone.

Upgrading copies the old workspace mailbox to every existing project so sending keeps working, but leaves polling enabled for only the oldest project, because two projects polling one inbox each ingest their own copy of every message. The legacy workspace settings remain in the database, unread.

## Remaining

- IMAP is read only far enough to auto-match replies to mail this app sent: bounded plaintext previews of new messages in one folder. Full thread history, attachments, other folders and correspondence the app did not send remain outside it, so anything ambiguous still has to be linked to a lead by hand.
- There is no calls overview page. Calling assignment and the append-only call log are reachable per lead only, not as one list across a project.
- Assignee notifications are recorded in the app for administrators and project members. Real delivery to the assigned person — email or push, addressed to that account alone — is still missing.
- Leads imported without a usable website keep an empty website and wait for a researcher to type the real address. Automatic website discovery for those leads is not built.

See [README.md](README.md) for setup, [docs/upgrade-review.md](docs/upgrade-review.md) for the review and migration behavior, and [docs/legacy/PROJECT_STATUS.md](docs/legacy/PROJECT_STATUS.md) for the previous project history.
