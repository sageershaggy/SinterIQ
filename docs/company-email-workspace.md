# Company and email workspace — review and concept

Reviewed against the five annotated screenshots on 15 September 2026. The screenshot notes are product feedback; they do not authorize sending real emails or connecting a personal mailbox.

## Pull request review

The repository's available PR, [#1 — [codex] Fix review queue imports and AI cost guards](https://github.com/sageershaggy/SinterIQ/pull/1), was already merged on 3 June. Its old application files have since been replaced. The current implementation review therefore covers the uncommitted workspace on `main`, rather than treating that historical patch as an open PR to merge.

Current findings and changes:

- The lead filter opened and filtered correctly by mouse in the local build. The reported dead click was not reproduced. Replaced the custom listbox with a full-width native select for reliable keyboard and pointer interaction.
- The export menu's “Assigned to me” shortcut sent an unsupported filter value. It now uses the same `ASSIGNED` + `assigned_to=me` query as the list and current-view export.
- Qualification was disabled when training was unpublished. Controls now offer “Set up qualification” and take the user to training. Published training remains required; ready projects can run AI qualification individually or in batches.
- Email creation was buried in a modal, and drafts were not persisted. Every row now has an Email action. The company page provides templates, private saved drafts and a campaign entry point regardless of qualification status.
- Older asynchronous preview responses could replace a newer edit's preview. Superseded responses are now ignored.
- Mailbox draft metadata included configuration details unnecessary for researchers. It now returns only sender identity and readiness.
- The human-review form could appear without a qualification run and on unrelated tabs. It is now shown only for the current, usable result in the research tab.

## Working concept

**Lead list → Company workspace → Email & templates → Campaign → Response history.**

Each company has a bookmarkable URL with Overview, Email & templates, Campaigns, Reasoning, Source evidence, Analysis history, Training feedback and Calls. Returning to the lead list keeps its current search, filter and page while the list remains mounted.

The overview gathers company details, captured contacts, current fit, assignment, outreach status, campaign progress and recent activity. Qualification and outreach remain separate: a reply or conversion stops the appropriate follow-ups without changing the research decision.

The email workspace offers:

1. Starter templates, project templates and a blank block editor on every lead.
2. A **Save draft** action. Drafts are private to the signed-in person and persist across reloads and server restarts. Save before changing tabs; this version does not autosave. Concurrent tabs cannot silently replace one another's saved draft.
3. **Save as template** for sharing reusable content within the current project. The library is limited to 100 saved templates per project in this first version.
4. Desktop/phone email previews using the existing server renderer, merge fields and validation.
5. An **Add to campaign** path. Current qualification and an eligible address are required for enrollment. Choose an existing sequence; administrators can create sequences using saved template text and links. Campaigns keep their existing deliberate activation and delivery safeguards.

Notifications appear in the top bar for lead creation, calling assignments, research/review results, calls, sent/refused emails and team-recorded responses. They link directly to the relevant company tab, have per-person read state and refresh every 30 seconds while the page is visible. Access is rechecked after project membership changes. They do not represent a new chat or task system.

## Shared mailbox implementation

The administrator-only SMTP configuration supports deliberate sending, sender identity, a copy address, opt-out and delivery history. Each lead's Email button now opens its existing draft or a ready-to-edit **Support email** template. Change template and Save as template retain the existing block designer and project library.

**Mailbox** now provides Inbox, Outbox, Sent and private drafts, searchable by company, subject or email. Optional encrypted IMAP configuration enables read-only incoming sync. Matching app-generated message references and sender addresses links replies to companies; unmatched messages can be linked explicitly. Linked conversations support deliberate replies with threading headers. Incoming replies append history and stop applicable follow-ups, preserving qualification and terminal outcomes. The worker syncs first and pauses automatic deliveries if an enabled incoming connection fails.

This implementation supports TLS IMAP password/app-password authentication. OAuth-only accounts require a separate provider integration; no actual mailbox has been connected or externally contacted during development. Read [mailbox setup](mailbox-setup.md) for connection steps, permissions and size/history limits.

## Verification

- `npm run check`: TypeScript, 60 tests, production build; `npm audit --audit-level=high`: no vulnerabilities reported.
- Disposable database tests cover draft persistence, incomplete drafts, concurrent edits, per-user ownership, project template isolation, CSRF, notification reads/revocation, campaign summaries and response synchronization.
- Local UI preview uses simulated AI, website evidence and mail transport on `127.0.0.1:3100`. It never loads the real database or mailbox settings.
- Shared mailbox checks: read a matched reply, send a simulated threaded reply, open its company and Support template, change templates, verify incoming sync, link an unmatched enquiry using company search, and inspect scheduled Outbox entries. The 390px mailbox layout fits within the page width.
- Browser checks passed for filtering unreviewed/qualified leads, email entry on an unreviewed lead, saving/reopening a private draft, saving a project template, returning to the same filtered list, merged campaign previews, draft enrollment, cross-project notification links/read state and the training setup action. The 390px company/email layout fits without horizontal page overflow, and recipient autofill was checked visually.

Changes remain uncommitted on the existing local `main` branch. The user's unrelated `.claude/launch.json` is preserved.
