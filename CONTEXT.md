# ren-ai

A service where people text fictional personas over iMessage. The repo also carries the quality-gate machinery it was created from, so the glossary covers both the product and the enforcement vocabulary used when changing its code.

## Language

### Product

**Ren AI**:
The official product name, written with this capitalization and space in logos, UI, metadata, documentation and communication.
_Avoid_: Ren, RenAI

**Persona**:
A fictional character the service plays in iMessage. She lives one life across all her Conversations. A conversation's persona is chosen at onboarding and never changes.
_Avoid_: bot, character, agent (an agent is the OpenCode mechanism that implements a persona)

**Persona description**:
The operator's detailed, private description of a persona's appearance, background, personality and speech. It is the source for her public profile and conversation instructions.
_Avoid_: bio, introduction, system prompt

**Persona seed**:
What a persona is drafted from: an operator's short idea or one record of a third-party synthetic persona dataset. It is source material; users never see it and no persona plays it.
_Avoid_: Nemotron persona, source persona, template

**Seeding run**:
One operator-confirmed run that drafts many personas from a set of Persona seeds, creates their identity sheets and gallery photos, and saves them unpublished.
_Avoid_: import, batch, bulk generation

**Public profile**:
The name, gallery photos and introduction shown to people choosing personas. It is distinct from the private persona description.
_Avoid_: persona definition, prompt

**Image style**:
One of the two renderings of every persona image: anime or photo. Each style has its own identity sheet and gallery photos, and a Discovery visitor browses in one style at a time.
_Avoid_: live-action, photorealistic, realistic, portrait type

**Identity sheet**:
A neutral multi-view reference image of one persona in one image style. Every gallery photo and Conversation photo showing her in that style is generated from it; it never appears in her public profile.
_Avoid_: main photo, representative photo, reference portrait

**Gallery photo**:
A photo of a persona in one image style, shown in her public profile.
_Avoid_: portrait, profile picture, main photo, secondary photo

**Conversation photo**:
A photo a persona takes for one Conversation, in the image style that Conversation's user chose in Discovery; she may send it to that user or let it go. It never appears in her public profile or another Conversation.
_Avoid_: selfie, shared photo, snapshot, attachment

**Persona version**:
An immutable saved edition of one persona's identity document, including its private description and public profile. It excludes gallery photos, initial State and Memory, and her evolving State and Memory.
_Avoid_: description format version, conversation snapshot

**Persona restoration**:
A new latest Persona version containing the document from an earlier version. It preserves the intervening versions, her current State and Memory, and her existing Conversations.
_Avoid_: memory reset, session rebuild

**Catalog**:
Every persona the service can play. Only published personas appear in Discovery; editing a persona changes her in every ongoing conversation.
_Avoid_: roster, lineup, persona list

**Ground rules**:
The instructions every persona follows regardless of who she is: Ren AI's service context, truthful identity and capability boundaries, how to read events on her phone, and how to use State and Memory.
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

**Notification handle**:
The handle the service itself texts from. No persona ever uses it.
_Avoid_: system handle, sender

**Notification**:
An iMessage the service writes and sends from the notification handle. It belongs to no Conversation, and no persona sees it.
_Avoid_: Notice, system message, alert

**Discovery**:
Browsing published personas' public profiles, Liking or Passing each, and joining the waitlist with a phone-number handle and web consent. Discovery never asks for an Apple ID email.
_Avoid_: discovery page, swipe app

**Onboarding**:
Becoming a user: joining the waitlist through Discovery, being selected, and receiving the assigned persona's first Greeting.
_Avoid_: signup, registration

**Test handle**:
A handle the operator marks for trying the service as a user would: its Conversations count toward a persona's assignments and change her State and Life memory like any other. Only a test handle can use Reset to end its current relationship, and only a test handle can skip Selection to start with a chosen persona right away.
_Avoid_: developer handle, dev number, allowlist

**Greeting**:
The first message a persona sends a new user.
_Avoid_: welcome message, intro

**Conversation**:
A user's distinct 1:1 relationship with one persona over iMessage. The persona holds her other Conversations at the same time, and none of them sees this relationship. A later relationship with another persona is a new Conversation even when it shares the same iMessage thread.
_Avoid_: chat, thread, session (a session is OpenCode's)

**Relationship ending**:
The permanent end of one Conversation, initiated by its Persona, the Operator, or a test handle using Reset; that user can never be assigned that persona again. Her other Conversations continue and other people can still be assigned her, so an ending is distinct from a pause or blocking the user from the service.
_Avoid_: ban, reset, pause, retirement

**Reselection**:
A user choosing other personas through Discovery after a Relationship ending, followed by Selection and a new Conversation. The previous Conversation's Relationship state and Relationship memory belong only to that previous relationship.
_Avoid_: persona switch, reset, relationship restart

**Memory**:
What a persona remembers, in two scopes: her Life memory, shared by all her Conversations, and each Conversation's Relationship memory. Each scope has short-term and long-term memory.
_Avoid_: context, history, session

**Life memory**:
What a persona remembers of her own life: her days, plans and experiences. All her Conversations read and change the same Life memory, so it never identifies a user or describes her relationships with them.
_Avoid_: shared memory, global memory, persona memory

**Relationship memory**:
What a persona remembers of one Conversation: that user, what they shared and what they agreed or promised. Only that Conversation can see it, and it never carries over to another.
_Avoid_: user memory, conversation memory, history

**Short-term memory**:
The part of Life memory or Relationship memory that is always on the persona's mind: current life, relevant facts, ongoing topics and unfinished plans or promises.
_Avoid_: transcript, summary of every message

**Long-term memory**:
The part of Life memory or Relationship memory recalled only when relevant: lasting facts and experiences with their provenance and current clarity. A clear memory retains detail, a faded memory retains only its remaining gist, and a forgotten memory has lost its content.
_Avoid_: complete conversation archive

**State**:
The persona's current condition, shared by all her Conversations: mood, energy, stress, desires for connection and solitude, traits and language proficiency. Events in any Conversation and the passage of time change it; it is distinct from her fixed identity, the facts she remembers and each Conversation's Relationship state.
_Avoid_: personality, memory, probability

**Relationship state**:
The persona's current values about one Conversation's user, such as Affection. Only that Conversation can see or change it.
_Avoid_: user state, relationship stage

**Affection**:
The persona's positive feelings toward one Conversation's user, held in its Relationship state. A persona-specific starting value describes her initial interest; subsequent affection reflects that Conversation's experience. It is distinct from familiarity, trust, desire to chat and the relationship itself. Affection does not unlock dating or automatically turn friendship into romance.
_Avoid_: action probability, relationship stage

**Starting relationship**:
The relationship a user chooses when requesting contact in Discovery: dating, flirting, friends or strangers. Dating is the default and means the two have just started dating. It belongs to that Conversation and establishes their relationship without inventing user facts or shared experiences. Later mutually agreed changes belong to that Conversation's Relationship memory.
_Avoid_: persona personality, affection level

**Language background**:
A Persona's native languages, primary language and history of learning languages. This is identity; becoming fluent in a learned language does not make it a native language.
_Avoid_: current proficiency, display language

**Language proficiency**:
What a Persona can currently understand and express in one language. It is part of her State: it starts from operator-approved initial State and develops through practice in any of her Conversations. Learned expressions and learning experiences belong to Memory.
_Avoid_: native language, experience points

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
The operator's choice to admit eligible waiting people, either picked directly or up to N chosen at random. Each receives one persona from their Likes, chosen by the operator or allocated at random, with fewer than five current assignments and no ended Conversation with that handle.
_Avoid_: matching, approval, first-come-first-served

**Assignment**:
A pairing of one persona with one handle, including the time before the first Greeting is sent. A handle has at most one current assignment and a persona at most five; a failed or uncertain first contact keeps the assignment.
_Avoid_: Like, session, recommendation

**First contact reservation**:
The selected persona's planned first Greeting, scheduled once between five minutes and one hour after selection. It is distinct from both selection and successful delivery.
_Avoid_: Notice, immediate onboarding, automatic selection

**Reset**:
The test-only command for a user to end their current Conversation and enter Reselection. It preserves the User and the previous relationship's history, Relationship state and Relationship memory for read-only review; the persona's shared State, including language proficiency, and Life memory continue.
_Avoid_: clear, restart, new conversation

**Sandbox**:
An operator's experiment with a persona on a copy of her State and Memory, outside every Conversation, so nothing in it changes her.
_Avoid_: test conversation, fork, copy

**Operator**:
The person who runs the service: watches conversations as they happen and fixes what breaks.
_Avoid_: admin, moderator

**Social account**:
An external social-media account the Operator connects to a chosen Persona. One account represents one Persona at a time; changing its Persona ends its current Social activity without carrying that Persona's private social relationships to the replacement.

**Social activity**:
A Persona's public writing, discovery of relevant people, replies, private messages and invitations on her connected Social account, within the Operator's activity settings.

**Social relationship**:
A Persona's private interaction with one contact on one Social account. It is distinct from an iMessage Conversation; an invitation does not identify the contact as an iMessage User or transfer their private history.

### Operations

**Metrics**:
Anonymous totals for Ren AI's traffic, onboarding, ongoing Conversations and AI cost. Test handles are excluded, and removing a person leaves historical totals intact.
_Avoid_: analytics events, tracking history

**Visit**:
One browser tab's time in Discovery, ending when the tab closes or is idle for 30 minutes. No identity links one Visit to another.
_Avoid_: visitor, browser identity, session

**Source**:
Where a Visit began: the referring site's host, campaign tags and entry through the About page, Explore, a shared profile or a Reselection link. Navigation within Discovery does not change it.
_Avoid_: full referrer URL, attribution identity

**First reply**:
The first admitted message a User sends after the Greeting. A Tapback alone does not qualify.
_Avoid_: reaction, first interaction

**Active user**:
A User who sent at least one admitted message in a Conversation on a Korea-time day. A Tapback alone does not qualify.
_Avoid_: online user, unique visitor

**Retention**:
The share of a Greeting-day group whose Users sent a message at least 1, 7 or 30 days after the Greeting day. Each threshold counts once per Conversation.
_Avoid_: exact-day activity, return Visit

**Report**:
The daily Korean summary of Metrics, compared with the preceding day and week, delivered to the Operator's Metrics channel.
_Avoid_: Alert, Notification

**Alert**:
A raised operational condition needing the Operator's attention, with a safe detail and management link. It remains distinct from a Report and from Notifications sent to Users.
_Avoid_: Notification, event, Report

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
