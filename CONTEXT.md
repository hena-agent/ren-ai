# ren-ai

A service where people text fictional personas over iMessage. The repo also carries the quality-gate machinery it was created from, so the glossary covers both the product and the enforcement vocabulary used when changing its code.

## Language

### Product

**Persona**:
A fictional character the service plays in iMessage.
_Avoid_: bot, character, agent (an agent is the OpenCode mechanism that implements a persona)

**User**:
A person who has onboarded and texts a persona.
_Avoid_: recipient, contact, customer

**Handle**:
An iMessage address: a phone number in international format or an Apple ID email.
_Avoid_: contact, number, address

**Service handle**:
The handle every persona texts from, currently hi@hena.dev.
_Avoid_: persona handle, sender, bot account

**Onboarding**:
Submitting a handle at msg.hena.dev to become a user.
_Avoid_: signup, registration

**Greeting**:
The first message a persona sends a new user, triggered by onboarding.
_Avoid_: welcome message, intro

**Conversation**:
The 1:1 iMessage thread between one user and one persona.
_Avoid_: chat, thread, session (a session is OpenCode's)

**Memory**:
What a persona remembers of one conversation: the latest messages word for word and a summary of everything older. Nothing in it carries over to another conversation.
_Avoid_: context, history, session

**Waitlist**:
The emails of people whose handle can't receive iMessage.
_Avoid_: queue, signup list

### Enforcement

**Gate**:
A single automated check that blocks a merge when it fails. There are eight, listed in `README.md`.
_Avoid_: rule, check, lint (a lint rule is one implementation of a gate, not a synonym)

**Silent false pass**:
A gate that exits 0 while enforcing nothing, usually because its inputs failed to resolve. The failure mode the gate machinery is designed around, and the reason `verify-gates` exists.
_Avoid_: false negative, silent failure

**Exception**:
A named, reasoned, human-approved waiver of one gate for one path. Lives in `quality-exceptions.json` when it covers a whole file, or as an inline suppression carrying `-- <reason>` when it covers a single line.
_Avoid_: ignore, suppression, disable, override, waiver

**Tier**:
Where a gate runs: pre-commit, pre-push, or CI. Tiers exist because gates differ by orders of magnitude in cost, not because they differ in importance.
_Avoid_: stage, level, phase

### Structure

**Archetype**:
One of the two shapes a workspace package may take. A **library** lives in `packages/` and is consumed by other workspace packages; an **application** lives in `apps/` and is the thing that runs.
_Avoid_: kind, category, template (overloaded here), project

**Just-in-Time package**:
A workspace package whose `exports` points at TypeScript source, with no build step and no emitted `dist/`. The only package shape this repo supports.
_Avoid_: source package, unbuilt package, internal package

**Trust boundary**:
A function that accepts untrusted input as `unknown` and narrows it before anything downstream sees it. The only place `unknown` may be declared, and the only accepted justification for suppressing the `unknown` ban.
_Avoid_: validator, parser, guard (a type guard is a tool used at a trust boundary, not the boundary itself)
