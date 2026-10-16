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

**Persona version**:
An immutable saved edition of one persona's identity document, including its private description and public profile. It excludes photos, initial State and Memory, and the evolving state and memories of Conversations.
_Avoid_: description format version, conversation snapshot

**Persona restoration**:
A new latest Persona version containing the document from an earlier version. It preserves the intervening versions and the persona's existing Conversations.
_Avoid_: memory reset, session rebuild

**Catalog**:
Every persona the service can play. Only published personas appear in Discovery; editing a persona changes her in every ongoing conversation.
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
The handle every persona texts from.
_Avoid_: persona handle, sender, bot account

**Discovery**:
Browsing published personas' public profiles, Liking or Passing each, and joining the waitlist with a mobile number and web consent. Discovery never asks for an Apple ID email.
_Avoid_: discovery page, swipe app

**Onboarding**:
Becoming a user: joining the waitlist through Discovery, being selected, and receiving the assigned persona's first Greeting.
_Avoid_: signup, registration

**Test handle**:
A handle the operator marks for trying the service as a user would. Only a test handle's conversation can be reset, and only a test handle can skip Selection to start with a chosen persona right away.
_Avoid_: developer handle, dev number, allowlist

**Greeting**:
The first message a persona sends a new user.
_Avoid_: welcome message, intro

**Conversation**:
The 1:1 iMessage thread between one user and one persona.
_Avoid_: chat, thread, session (a session is OpenCode's)

**Memory**:
What a persona remembers of her life and one conversation. It includes short-term and long-term memory; neither carries over to another conversation.
_Avoid_: context, history, session

**Short-term memory**:
What is currently on the persona's mind: current life, relevant facts, ongoing topics and unfinished plans or promises.
_Avoid_: transcript, summary of every message

**Long-term memory**:
Lasting facts and experiences recalled when relevant, with their provenance and current clarity. A clear memory retains detail, a faded memory retains only its remaining gist, and a forgotten memory has lost its content.
_Avoid_: complete conversation archive

**State**:
The persona's current condition and other current values needed for her choices within one conversation. State changes with events and time; it is distinct from her fixed identity and the facts she remembers.
_Avoid_: personality, memory, probability

**Affection**:
The persona's positive interest in getting to know one conversation's user. A persona-specific starting value describes her interest on first meeting; subsequent affection reflects that conversation's experience. It is distinct from familiarity, trust, desire to chat and intent to date.
_Avoid_: action probability, relationship stage

**Language background**:
A Persona's native languages, primary language and history of learning languages. This is identity; becoming fluent in a learned language does not make it a native language.
_Avoid_: current proficiency, display language

**Language proficiency**:
What a Persona can currently understand and express in one language within one Conversation. It starts from operator-approved initial State and can develop through that Conversation's practice. Learned expressions and learning experiences belong to Memory.
_Avoid_: native language, experience points, shared Persona progress

**Display language**:
The language a person uses to read Discovery's controls and notices. Public profiles remain in their original language, and changing this setting does not change a Persona's proficiency.
_Avoid_: conversation language, profile translation

**Preferred conversation language**:
The language a person asks to use when joining the waitlist. The first Greeting respects the assigned Persona's ability in that language; a Persona who does not speak it uses her primary language.
_Avoid_: consent language, guaranteed fluency

**Conversation history**:
The actual sequence of messages and actions, including any checkpoint summarising older exchanges. History records what happened; it is distinct from what the persona currently remembers.
_Avoid_: Memory

**Waitlist**:
People waiting to start a conversation. Each registration includes a handle, liked personas and web consent; selection has no promised order or time.
_Avoid_: queue, signup list

**Selection**:
The operator's choice to admit up to N randomly chosen eligible waiting people, each with one randomly chosen available persona from their Likes.
_Avoid_: matching, approval, first-come-first-served

**Assignment**:
An exclusive pairing of one persona with one handle, including the time before the first Greeting is sent. A persona and a handle can each have only one current assignment; a failed or uncertain first contact keeps the assignment.
_Avoid_: Like, session, recommendation

**First contact reservation**:
The selected persona's planned first Greeting, scheduled once between five minutes and one hour after selection. It is distinct from both selection and successful delivery.
_Avoid_: Notice, immediate onboarding, automatic selection

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
