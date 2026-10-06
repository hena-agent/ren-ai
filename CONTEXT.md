# ren-ai

A service where people text fictional personas over iMessage. The repo also carries the quality-gate machinery it was created from, so the glossary covers both the product and the enforcement vocabulary used when changing its code.

## Language

### Product

**Persona**:
A fictional character the service plays in iMessage. A conversation's persona is chosen at onboarding and never changes.
_Avoid_: bot, character, agent (an agent is the OpenCode mechanism that implements a persona)

**Persona description**:
The operator's detailed, private description of a persona's appearance, background, personality and speech. It is the source for her public profile and conversation instructions.
_Avoid_: bio, introduction, system prompt

**Public profile**:
The name, image and introduction shown to people choosing personas. It is distinct from the private persona description.
_Avoid_: persona definition, prompt

**Catalog**:
Every persona the service can play. Only published personas are offered at onboarding; editing a persona changes her in every ongoing conversation.
_Avoid_: roster, lineup, persona list

**Ground rules**:
The instructions every persona follows regardless of who she is, such as never acting like an AI and how to read events on her phone.
_Avoid_: system prompt, guidelines, policy

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
Choosing a published persona, providing a handle, and consenting to start receiving her iMessages. Discovery may also record Likes before a persona is selected for the conversation.
_Avoid_: signup, registration

**Test handle**:
A handle the operator marks for trying the service as a user would. Only a test handle's conversation can be reset.
_Avoid_: developer handle, dev number, allowlist

**Greeting**:
The first message a persona sends a new user.
_Avoid_: welcome message, intro

**Notice**:
A fixed message the service sends from the service handle in its own voice, not a persona's. Legacy onboarding sends one before the greeting. Discovery obtains AI-service consent on the web rather than sending a separate notice.
_Avoid_: disclaimer, system message

**Conversation**:
The 1:1 iMessage thread between one user and one persona.
_Avoid_: chat, thread, session (a session is OpenCode's)

**Memory**:
What a persona remembers of one conversation: the latest messages word for word and a summary of everything older. Nothing in it carries over to another conversation.
_Avoid_: context, history, session

**Waitlist**:
People waiting to start a conversation. Discovery registrations include a handle, liked personas and web consent; selection has no promised order or time. The legacy waitlist contains emails from people whose handle can't receive iMessage or for whom the service is full.
_Avoid_: queue, signup list

**Reset**:
Returning a test handle to before onboarding, so its next conversation starts as a first meeting. The persona's previous memory is kept for review.
_Avoid_: clear, restart, new conversation

**Operator**:
The person who runs the service: watches conversations as they happen and fixes what breaks.
_Avoid_: admin, moderator

### Enforcement

**Gate**:
A single automated check that blocks a merge when it fails. There are seven, listed in `README.md`.
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
One of the two roles a workspace package takes. A **library** is consumed by other workspace packages; an **application** is the thing that runs.
_Avoid_: kind, category, template (overloaded here), project

**Just-in-Time package**:
A workspace package whose `exports` points at TypeScript source, with no build step and no emitted `dist/`. Every library takes this shape; browser applications build JavaScript because browsers can't run TypeScript.
_Avoid_: source package, unbuilt package, internal package

**Trust boundary**:
A function that accepts untrusted input as `unknown` and narrows it before anything downstream sees it. The only place `unknown` may be declared, and the only accepted justification for suppressing the `unknown` ban.
_Avoid_: validator, parser, guard (a type guard is a tool used at a trust boundary, not the boundary itself)
