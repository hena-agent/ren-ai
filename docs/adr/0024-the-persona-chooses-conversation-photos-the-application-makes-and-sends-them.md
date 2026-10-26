---
status: accepted
---

# The persona chooses Conversation photos; the application makes, limits, stores and sends them

Personas now take Conversation photos and send them over iMessage. Only the persona has the
conversation, her State and her Life memory in mind, so she decides when to take a photo and
what it shows. Everything with a credential or a lasting effect stays in the application: it
enforces the limit, composes the image prompt, generates and stores the photo, and sends it
through the Outbox. This adds to the persona tool list of ADR-0010 and ADR-0012 under
ADR-0001's policy, and follows ADR-0002, ADR-0018 and ADR-0019 for sends, transport and
authority. The product contract is [Conversation photos](../specs/conversation-photos.md).

## Decision

- **Two conversation-bound tools.** The existing tools plugin registers `take_photo` and
  `send_photo`. The model supplies only the moment to capture and, later, which of its photos
  to send; OpenCode supplies the session and call IDs. The plugin calls the application's RPC
  and holds no image credential.
- **Take, look, then send.** `take_photo` shows her the photo before anything reaches the
  user, so she can let an unsuitable photo go, and a message that arrives while the image is
  generated reaches her before she commits to sending.
- **The application composes the prompt.** Her description is one input. The fixed content
  rules, the Conversation's image style, her identity sheet and her latest photo of herself in
  that Conversation come from the application, so no conversation can talk her past them.
- **A photo send is an Outbox send.** It is recorded before submission under an attempt ID,
  fences later sends while uncertain and is never retried blindly. The Mac gains an identified
  image send that uploads through Apple's attachment service; the application never falls back
  to an unidentified send on an older Mac.
- **One image-generation library.** Admin's generation code moves into a shared library used
  by Admin and the application. Provider credentials stay in Cloudflare Workers; the OpenCode
  host gains none.

## Considered Options

- **The plugin generates and sends.** Rejected: sends would bypass the Outbox, the limit would
  live on the Mac, and an interrupted turn could generate twice, because OpenCode asks the model
  again instead of replaying the tool call. Provider credentials and the private identity-sheet
  lookup would move onto the host that handles untrusted input.
- **Admin generates for the application.** Rejected: every conversation would depend on the
  operator's app, and prompts drawn from private Conversations would pass through it.
- **The application schedules photos.** Rejected: only the persona can make a photo fit the
  moment.
- **One tool that generates and sends.** Rejected: generation takes tens of seconds, after
  which the application would have to send without her seeing newer messages or discard a
  finished photo.

## Consequences

- iMessage remains the record. The Mac keeps a copy of every photo sent from the Service
  handle, and session rebuilds show her own photos from it.
- Conversation photos share the image provider with Admin, which runs one image at a time. A
  busy or failed generation means no photo rather than a late one.
- A persona without an identity sheet in a Conversation's image style cannot take photos in
  that Conversation.
