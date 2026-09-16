# Meeting updates — 14 September 2026

The supplied transcript contains unrelated conversation and transcription errors. This review uses the clear product requests and leaves uncertain references explicit.

| Request from the call                                           | Current gap                                                         | Implementation                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Multiple funnels by industry, audience or occasion              | Only individual emails exist                                        | Project funnels with named audiences and up to three editable messages                                   |
| Send later messages after days or weeks                         | No persistent schedule or queue                                     | Durable enrollments, delays from the previous successful send, pause/resume and visible next-send time   |
| Add qualified contacts to a funnel                              | No enrollment action                                                | Selected qualified leads, atomic eligibility checks, one active enrollment per recipient                 |
| Copy the owner on messages                                      | No copy address                                                     | Administrator-configured copy address; required before a funnel can run                                  |
| No more than three emails; stop when asked                      | Footer only, no suppression                                         | Shared recipient send limit, durable suppression, recipient unsubscribe and immediate queue cancellation |
| Show conversions on the lead                                    | Qualification is the only outcome                                   | Separate outreach outcome and notes; interested/replied/converted contacts stop follow-ups               |
| Notify Hari and Catherine on form entry; avoid repeated tickets | No identified form, integration or ticket system in this repository | Awaiting clarification: which form/system, recipients and duplicate-matching rule                        |
| “This part is not working”                                      | The transcript does not identify the failing screen or error        | Audit the existing email flow; ask for the exact failure without guessing                                |

## Delivery contract

- Creating a funnel leaves it in draft. An administrator must explicitly start a reviewed funnel; enrollment in an already active funnel can schedule delivery immediately. This implementation is tested with disposable databases and fake transports; it sends no real campaign emails during development.
- A public HTTPS application origin, a configured mailbox for that project and a copy address are required for activation. The server processes at most one due message per minute per project, choosing the project first so one busy project cannot starve another, and it stops sending for a project whose own inbox is failing. There is no catch-up burst after downtime.
- Each recipient receives at most three accepted or uncertain sends across the workspace, including individual outreach and other funnels. Suppression and counters survive lead deletion and reimport.
- Each enrollment/step has a unique delivery key. Concurrent workers cannot reserve it twice. An ambiguous SMTP result is held for review, never retried automatically.
- Recheck project membership, lead revision, qualification, recipient and opt-out before sending. Editing a lead, removing access or recording a response blocks further automatic delivery.
- Enrolled sequences are immutable; create another funnel to change their messages. Qualification and training history remain independent of outreach outcomes.
- Update, 15 September: optional administrator-enabled IMAP synchronization now records matched replies, with a shared mailbox for administrators and per-company incoming messages for assigned researchers. Conversion and unsubscribe requests still need a team decision; recipient unsubscribe links operate directly. See [mailbox setup](mailbox-setup.md).

## Validation completed

- `npm run check`: strict TypeScript, all 50 tests and the production build passed.
- `npm audit --omit=dev --audit-level=high`: no production dependency vulnerabilities reported.
- Browser verification in a disposable database: create a draft, choose qualified leads, preview merged content, enroll, record conversion, verify the lead's unchanged qualification, and verify the setup gate before starting.
- Desktop and 390px phone layouts inspected; no page overflow or browser warning/error logs observed.
- New regression tests cover delayed delivery, persistence, duplicate/atomic enrollment, access/CSRF, stale training, opt-outs after reimport, send limits after deletion, concurrent response handling, partial SMTP acceptance and interrupted-delivery recovery.

No live mailbox or customer database was used to test this work. Configure the real copy address and public origin before activating a reviewed sequence. The form/ticket integration and the unidentified failing feature remain awaiting the details requested above.
