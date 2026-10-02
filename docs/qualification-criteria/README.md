# Qualification criteria documents

These are starting drafts of the qualification criteria for the categories the team searches around.
Each one is written to be uploaded to a project's Training library as a source. Train AI reads it and
proposes a draft training version (summary, criteria, exclusions, service categories, open
questions); nothing is used for qualification until someone approves and publishes that version.

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
- **Meets** counts only with a source retrieved from the web (a page of the company's own site or
  what research found there) or with **your lead list**: the extra columns imported with the lead,
  such as the event or the funding round, cited as "Your lead list". The list can show exactly the
  facts it states; it is the team's data, not checked on the web. The lead record's own fields and
  notes never count: a rule only they support is Unable to verify.
- An exclusion that matches with a retrieved source or your lead list makes the lead Not a target,
  whatever else it scores. An exclusion matches only when every part of it is shown: a nonprofit is not excluded by
  "non-commercial organization with no approved commercial opportunity" unless the evidence also
  shows there is no opportunity for the offering.
- Before judging a lead, the system researches its missing details (website, industry, location) from
  the company name, the email domain and the company's own website, and keeps a citation for every
  fact it adds.
- The open questions are what the AI could not decide from the documents. Answer them in the next
  version of the document.
- A criteria document usually describes one service category. With several in the library, Train AI
  proposes a category for each offer ("AI app development: …", "Marketing support: …"), and every
  lead is rated a good fit, possible fit or no need shown for each one, beside the fit score. Like a
  met criterion, a good or possible fit needs a source retrieved from the web or your lead list.

## What the fit score means

The fit score (0 to 100) is the share of the criteria the evidence shows the company meets.

The status follows from it:

- **50 to 100 — Qualified.**
- **0 to 49 — Not a target.** Missing information (no website, unknown industry or location) lowers
  the score; it does not send a lead to review.
- **Needs review** only when research or verification is blocked: the website on record could not be
  read, the evidence describes another company or a name several companies share, the site is
  parked or the company closed, or a lead scoring 50 or more has an exclusion that could not be
  checked. The lead page lists the reason under "Why it needs review".

Within Qualified, the score also sets the outreach step:

- **80 to 100 — call-ready.** Most criteria are met with evidence and no exclusion applies. These go
  to the high-quality campaign and are worth a call.
- **70 to 79 — send an email.** A good fit with one or two criteria unverified. These go to the email
  campaign.
- **50 to 69 — review with the client.** Mixed evidence. A person decides before any outreach.
- **Below 50 — not a fit for now.** These are archived, not deleted, and can be restored.

## What the system can and cannot check today

Research reads the company's own website and the data in the lead record: the home page, up to two
about, company, product or engineering pages, and up to three contact, team, imprint or about pages
linked from it. It does not read careers or news pages on its own, and it does not search the wider
web, LinkedIn, funding databases or event sites. So:

- Evidence on those pages of the company's own site (products, applications, team, contacts, what
  the about page says about size or history) can be verified and cited.
- Evidence that usually sits on a careers or news page (open roles, a funding announcement) is only
  found when the home or about page mentions it. Otherwise put it in the lead list.
- Evidence that lives elsewhere (an event's exhibitor list, a funding database) should come in with
  the lead list: import the exhibitor list or the funding export as the leads, and put the event or
  the round in its own column. It is kept with the lead and can be cited as "Your lead list", so a
  rule about exactly that fact (taking part in the event, having raised the round) can be met and
  adds to the score. A column whose header names a person or a way to reach one, and any value
  holding an email address or phone number, is left out; up to 25 columns are kept per lead.

Each document says which of its criteria depend on imported data.
