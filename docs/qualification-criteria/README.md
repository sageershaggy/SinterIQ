# Qualification criteria documents

These are starting drafts of the qualification criteria for the categories the team searches around.
Each one is written to be uploaded to a project's Training library as a source. Train AI reads it and
proposes a draft training version (summary, criteria, exclusions, open questions); nothing is used for
qualification until someone approves and publishes that version.

The documents are meant to be edited. Change the wording, add examples of good and bad leads, and
upload the new version; each upload becomes a new source and each Train AI run a new draft.

## The documents

1. `ai-app-development.md` — companies building apps with AI, and the AI engineers behind them.
2. `marketing-assistant.md` — companies with an active marketing function, reached through the
   marketing assistant or marketing manager.
3. `event-participants.md` — companies exhibiting at, sponsoring or attending a named event.
4. `funded-companies.md` — companies that have recently received significant investment.
5. `criteria-template.md` — a blank template for a new category.

## How a criteria document is used

- Every criterion is evaluated for every lead as **Meets**, **Does not meet** or **Unable to verify**,
  with the evidence quoted. Unable to verify is only allowed after the research pass has looked.
- An exclusion that matches makes the lead Not a target, whatever else it scores.
- Before judging a lead, the system researches its missing details (website, industry, location) from
  the company name, the email domain and the company's own website, and keeps a citation for every
  fact it adds.
- The open questions are what the AI could not decide from the documents. Answer them in the next
  version of the document.

## What the fit score means

The fit score (0 to 100) says how strongly the evidence matches the criteria.

- **80 to 100 — call-ready.** Most criteria are met with evidence and no exclusion applies. These go
  to the high-quality campaign and are worth a call.
- **70 to 79 — send an email.** A good fit with one or two criteria unverified. These go to the email
  campaign.
- **50 to 69 — review with the client.** Mixed evidence. A person decides before any outreach.
- **Below 50 — not a fit for now.** These are archived, not deleted, and can be restored.

## What the system can and cannot check today

Research reads the company's own website (home page plus the contact, team, about, careers and news
pages it can find) and the data in the lead record. It does not search the wider web, LinkedIn,
funding databases or event sites. So:

- Evidence that lives on the company's own site (products, careers, press releases, team pages) can
  be verified and cited.
- Evidence that lives elsewhere (an event's exhibitor list, a funding database) should come in with
  the lead list: import the exhibitor list or the funding export as the leads, with the event or the
  round in a column, and the criteria can use it as provided data.

Each document says which of its criteria depend on imported data.
