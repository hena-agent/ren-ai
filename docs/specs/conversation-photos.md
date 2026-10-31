# Conversation photos

Agreed on 2026-10-26.
[ADR-0024](../adr/0024-the-persona-chooses-conversation-photos-the-application-makes-and-sends-them.md)
records why the persona chooses photos while the application makes, limits, stores and sends
them. A Conversation photo is a photo a persona takes for one Conversation and may send to that
user; gallery photos stay in her public profile.

## Product contract

- **When she shares.** She sends photos the way a person would: when asked, at her own
  discretion, or when she has something worth showing, including when she texts first. Each
  photo fits the time, her mood, her plans and the starting relationship. She never uses a
  photo to get a reply.
- **What she photographs.** Herself (a selfie, in a mirror, or taken by someone else) and her
  own surroundings: food, places, the sky, her room, and pets or things that fit her persona
  description and Life memory. She is the only identifiable person; others appear only in the
  background. Never the user, and never real or famous people.
- **What she never sends.** Nothing sexual or suggestive, whatever the relationship or request:
  no nudity, underwear or sexualized poses. No gore or self-harm. Private darkness shows at
  most as a subtle undertone. No text, screenshots or logos.
- **Only her side.** Her description of the moment never includes the user's name, photos or
  other personal details, because it goes to the image provider.
- **Truthfulness.** Asked whether a photo is real, she answers within the ground rules: it is an
  image of her as a RenAI persona, not proof of a real body.
- **Limit.** At most 3 successful takes per Conversation in any 24 hours, whether or not she
  sends them. Failed attempts don't count. There is no minimum gap, so two shots in a row are
  possible. Test handles count like any other Conversation.
- **Private declines.** The limit, the operator's off switch, a failed generation and a missing
  identity sheet all end the same way: the tool declines, she carries on in text, and she never
  mentions limits or failures.
- **Image style.** Photos use the image style the user chose in Discovery; see
  [Discovery image style](#discovery-image-style).
- **No AI mark** for now. Revisit it before the Korean AI Basic Act's transparency penalties can
  apply, no earlier than 2027-01-22.

## Persona tools

- `take_photo({ scene, includesMe, orientation })`: `scene` describes the moment in her words,
  `includesMe` says whether she appears, and `orientation` is `portrait` or `landscape`. Success
  returns the photo as an image with its ID and expiry; she looks at it and lets it go if it
  does not fit her looks or the moment. Otherwise the tool returns a private decline.
- `send_photo({ photo })` sends a photo she took in this Conversation, once, within one hour of
  taking it. Results follow `send`: `sent`, or `not sent: <reason>`.
- Both tools live in the existing `ren-ai.tools` plugin with Code Mode off, and join the
  persona permission allowlist and the context hook's tool check. Existing sessions receive the
  updated permissions during the plugin rollout.
- Outside a Conversation, such as in an operator Sandbox, both tools decline.
- The ground rules cover when and what she shares, private declines, take-then-send, the
  cancelled-send rule and truthfulness. Across her Conversations she keeps today's look
  consistent through Life memory when it matters, without relationship details.

## Taking a photo

1. The application finds the active Conversation from the session ID and checks the off switch,
   the limit and that the persona has an identity sheet in the Conversation's image style. Any
   failed check declines privately.
2. It composes the prompt from a fixed everyday-phone-photo policy (casual and unposed, not a
   dating-profile photo), the content rules above, the existing anime or photo rendering
   direction, her persona description and her `scene`.
3. When `includesMe` is true, it attaches her identity sheet and the last sent photo of herself
   from this Conversation within the past 6 hours, if any, so outfit and hair carry over unless
   her scene says otherwise. Photos from other Conversations are never used.
4. It generates one JPEG through codex-image with `gpt-image-2.5`, at 1152×1536 for portrait or
   1536×1152 for landscape, and gives up after about 2 minutes. A failed, refused or interrupted
   generation is neither retried nor counted.
5. It records the take, keyed by session and call ID so a repeated call cannot create a second
   photo, stores the image privately and returns it to her.

## Sending a photo

- `send_photo` uses the Outbox as a new send kind. The send is recorded before submission under
  an attempt ID, waits behind an unresolved earlier send, settles through the same status checks
  and is never retried blindly.
- It follows the reply rules for text: read before replying, four quiet seconds after the latest
  arrival, and cancellation when a message arrives that her context has not seen. It shows no
  typing indicator. In a new relationship, the relationship introduction goes first, as it does
  before her first text.
- A cancelled photo send keeps the photo. After reading the new messages she may still send it
  within the hour if it fits the conversation now, without explaining the delay. Cancelled text
  drafts, by contrast, are discarded.
- A photo is sent at most once. An unsent photo expires one hour after it was taken.

## Messages Mac

- A new imsg RPC submits an image under an application-owned attempt ID. The gateway records
  the outgoing row with its attachment before native submission, rejects reuse of an admitted ID
  with a different image or handle, and applies the existing `resolveSend` fences.
- The Rustpush bridge uploads the image through Apple's attachment service
  (`Attachment::new_mmcs`) and sends it as an attachment part. A failed upload before
  submission is a definitive failure; after submission, uncertainty follows text sends.
- The gateway keeps each sent image as it keeps received ones, so history, replay and the
  existing `image` RPC can return it.
- The Mac deploys first. An older Mac rejects the new RPC, which means the photo was not sent;
  the application never falls back to another send.

## History and memory

- During the turn she already has the photo from `take_photo`.
- Unmatched outgoing photos and rebuild replay show `<photo-by-you at="…"/>` with the image
  attached, instead of an empty `<sent-by-you>`. The ground rules' tag guide adds it.
- Compaction keeps describing photos worth remembering, her own included.

## Storage, operations and privacy

- Photos are stored in a private R2 bucket owned by the application and never served at a public
  URL.
- Sent photos stay with the Conversation's history and are deleted with the rest of its data on
  a removal request. Unsent photos are deleted when they expire.
- Admin's Conversation history shows sent photos through an authenticated application endpoint.
  Unsent photos are not shown.
- An operator command turns photo-taking off or on for every Conversation without a deploy. The
  application stores the setting.
- The private runtime Catalog carries each persona's identity-sheet references. Admin notifies
  the application after a sheet change, as it does after any committed Catalog change.
- codex-image (`https://codex-image.renai.im`) is free. Its key is the Worker secret
  `CODEX_IMAGE_API_KEY`, as in Admin. It runs one image at a time for Admin and every
  Conversation. Keep model training turned off on its backing account.
- Logs never contain scenes, prompts or image data. Diagnostics carry the request ID, persona
  ID, model, image style, stage, outcome and upstream status.

## Discovery image style

- Registration records the visitor's current Discovery image style. The field is optional, as
  onboarding shape changes require during independent deployment.
- First contact copies it into the Conversation, where it never changes. Reselection records a
  fresh one with its new registration.
- Conversations without a recorded style, including existing ones, use anime.

## Rollout

Each step leaves a working product.

1. Admin's switch to codex-image lands, and its image code moves into the shared library. Admin
   behaves as before.
2. Registration records the Discovery image style: API first, then Discovery.
3. The Mac can send an identified image, verified live with a test handle.
4. The application can send and replay photos and show them in Admin.
5. Personas get `take_photo` and `send_photo`, the limit, the off switch and the ground rules
   through the planned plugin install.

## Verification

- Automated checks cover the limit window and counting, every private decline, continuity
  reference selection, expiry, the cancelled-send rule, Outbox fences and uncertainty for photo
  sends, Mac admission and fencing, replay rendering, deletion, log exclusion, Discovery style
  defaults and tool isolation.
- Live checks with a test handle cover a take and send, rebuild replay, an uncertain photo send
  and a busy provider.
- Review these with the deployed model: repeated selfie requests; a request for a suggestive
  photo; "is this really you?"; two selfies minutes apart; a request during her sleeping hours;
  a strangers Conversation; a message arriving mid-generation.

## Deferred

- No AI mark until the transparency grace period is revisited.
- Personas do not send gallery photos or other ready-made images.
