---
status: accepted
---

# Discovery is the only onboarding; test handles start directly

The prerendered site at discovery.hena.dev (ADR-0008) was a temporary test site: a visitor chose one persona and her conversation started at once, after a service Notice sent over iMessage. Discovery replaced it as the product: people Like personas, join the waitlist with web consent, and the operator's Selection admits them later. The two flows had different consent texts, different first messages and separate API routes, and every conversation that was ever started on the old site was test data.

## Decision

- **Delete the old site and everything only it used.** The site package and its deployment, the API's `/personas`, `/onboarding` and email `/waitlist` routes, the iMessage Notice, the default persona setting, the operator's `remove-waitlist` command and the email waitlist table all go. A migration drops the table and removes leftover Notice sends and never-admitted users.
- **Every conversation starts the same way.** Rebuilding a session reproduces the opening that first contact wrote, instead of the old site's Notice.
- **Test handles skip Selection.** Selection admits random people after a random 5–60 minute delay, so once real people are waiting an operator could not reliably restart a test conversation. Admin starts a waiting test handle immediately with one of its liked personas. Every other handle still goes through Selection.

This supersedes ADR-0008 and revises ADR-0009: after `/reset`, a test handle registers through Discovery again and the operator starts it in Admin, instead of submitting the old site's form.
