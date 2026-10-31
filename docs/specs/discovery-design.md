# Discovery design

## Direction

RenAI is refined, photo-led and personal. Preserve the existing white, cool gray
(`#f4f5f7`), ink (`#20242b`) and cherry rose (`#c72c52`, hover `#a82042`) palette. Improve proportions,
spacing, typography and feedback within that palette. Use the official product
name from `CONTEXT.md` throughout.

Reference direction: Bumble's large, interactive portraits and Hinge's full-bleed
photographic storytelling, with Tinder's decisive type hierarchy. The first
viewport prioritizes people, one oversized headline and one primary CTA. Use
edge-to-edge portraits rather than a split copy/thumbnail collage. Desktop shows
three photographic panels with an expanding selection; mobile shows one complete
portrait at a time, with explicit name selectors and a crossfade. Keep the primary
CTA within a normal phone's first viewport. Keep reduced-motion changes immediate.

The next scene is a scroll-driven conversation, not a device mockup. A large
everyday photograph drifts slowly while native HTML messages arrive at different
scroll positions and settle into a readable thread. Use CSS view timelines and
a sticky viewport for the layered parallax; leave scrolling native. Keep text
unscaled and unrotated, at least 16px on a 320px phone. Blue belongs to outgoing
messages inside the demo, not the brand palette. Keep the example caption at 14px
and preserve the original accessible message order without live announcements.
Asset provenance lives in `apps/discovery/design/README.md`.

Feature 백지아 in the center hero panel and conversation. Keep one continuous
conversation with a single contact header and photograph: her everyday photo and
message, the visitor's café photo with her heart Tapback and reply, then a real
Spotify song link. Each photo, message and reply appears individually at its own
scroll threshold, expanding into the bottom of the thread and pushing earlier
messages upward. Future messages occupy no space before their arrival. The heart
reaction arrives after the visitor's photo. Scroll reverses these arrivals;
do not split these exchanges into separate sections, numbered cases or resets. Keep the
café photo independent of image style; Jia's photos and avatars follow it.
Use readable native music-card text, an explicit external link and no autoplay.
Use SVG icons for UI arrows, music, reactions and disclosure controls rather than
text glyphs standing in for icons.

The pinned scene completes its messages before the end of its scroll range so
visitors can pause and read. Short viewports show a flowing conversation with
gentle photographic parallax. Reduced motion and browsers without view timelines
show all messages immediately in normal document flow, with no empty pinning space.

Avoid repeated profile grids, miniature UI screenshots and tilted photo decorations.
Use cherry rose for decisive actions, selection, hearts and connection details;
do not fill the closing section with the accent color. Keep the brand symbol,
favicon and touch icon consistent with the accent.

Make **no additional app to install** prominent. Remove the exclusivity section,
its one-to-one diagram and section-specific images. A persona can hold up to five
current assignments; the landing makes no exclusive-connection promise.
The follow-up invitation says a persona curious about the visitor will reach out
first. Keep operational selection/availability language in registration notes
and FAQs rather than this relationship-focused section.
iMessage on
iPhone is the sole supported channel; do not show LINE, WhatsApp or future-channel
logos. Show a localized illustrative first-message notification alongside the
iMessage identity, using the messaging-app icon rather than repeating a persona
avatar in every notification. Prioritize spacing, alignment and readable
relationship information rather than an oversized portrait.
Do not imply immediate matching or a guaranteed connection to the featured persona.
Keep the three registration steps compact, followed by the existing selection note.

End with an ink-colored editorial closing: an invitation and cherry-rose CTA
beside a large everyday persona photograph with an illustrative first greeting.
Adapt these photos and avatars to the selected image style. On phones, stack
copy and imagery with the CTA before the photo; keep headings and notifications
readable at 320px without horizontal overflow.
Treat featured profiles as editorial
selections; keep public persona writing in
its original language. The landing remains independent of a live Catalog request.
Featured landing names follow the screen language: Korean full names, English
given names (Subin, Jia, Harin), and Japanese given names (スビン, ジア, ハリン).
Use 한수빈, 백지아 and 강하린 as the Korean full names. These editorial names are
independent of live Catalog names; asset keys retain their source identifiers.
Apply these names to portrait selectors and accessible labels, conversation
headers, notification examples and closing greeting.
Keep photo/persona selection stable across locale changes. Actual Catalog names
in Discovery's explorer remain in their original language.
Desktop navigation uses one horizontal row; smaller screens use a single-row
header with language selection and a menu toggle. The menu closes on a section
selection or Escape, restoring toggle focus on Escape.
Language-menu keyboard focus uses an inset ring inside the rounded option so
the popover cannot clip it. Retain a distinct selected-language background and
check, and the circular globe trigger's visible keyboard focus.
Japanese screens, language labels and shared artwork prioritize complete Japanese
font families (Hiragino Sans, then Japanese system alternatives) before Korean
fonts so kanji and kana retain consistent shapes and weight.

## Interaction

First visits start in anime; restore an explicit saved choice thereafter. Keep
anime/photo controls available in both the landing header and production
Discovery. All landing portraits, the scroll scene and its avatar share the
selected style. Browsing keeps its current card, photo index, Likes and contact
input when switching. Remove the blocking first-visit style comparison.

Submitting contact saves the current in-memory image style with the registration,
even when browser storage is unavailable. Duplicate submissions preserve the original
choice. First contact copies it into its Conversation; Reselection may choose another
style for a new registration and Conversation without changing the ended relationship.
Existing registrations and Conversations, and submissions without a style, use anime.
`DiscoveryRequest.imageStyle` and `ConversationEntry.imageStyle` stay optional for
independent deployments. Deploy API acceptance and persistence before Discovery sends
the field; clients continue accepting older API responses without it. This step records
the choice only; it adds no photo-generation tools or model prompts.

Switch image style immediately in place, without waiting for image downloads,
decoding or a reveal animation. Load the selected images normally and keep
navigation available, including rapid switches back and forth. Preserve keyboard
focus, scroll position and parallax progress. Image failures must not revert the
selected style or block navigation.

Use short, purposeful feedback: 120–180ms for controls and 180–240ms for movement.
Scroll timelines use scroll progress rather than these control durations.
Navigation has an animated active indicator; buttons visibly respond to presses.
Preserve mounted browsing state and scroll positions when switching tabs.
Hero portraits reveal once and transition on explicit selection; there is no
automatic carousel. Conversation motion follows scroll position and reverses
naturally when scrolling back; there is no autoplay or simulated live typing.
Reduced motion shows immediate control states.
Use native CSS before introducing animation dependencies.

Cards browse by touch, as in Tinder. Tapping the left or right third of a card's
photo shows the previous or next photo; tapping the middle third, or anywhere from
the name down, opens the inline reading view. In the reading view the left and
right halves of the photo change it. A press that moves more than 6px is a swipe,
never a tap, and a tap acts on its click so the view it opens cannot receive the
same tap. Tapping past the first or last photo nudges the photo for 220ms; reduced
motion skips the nudge. There are no photo arrows, details button or visible photo
counter; the progress bars stay and jump to a photo. Transparent Previous, Next
and View full profile buttons cover the same areas for keyboard and assistive
technology, and the photo position is still announced. Their focus ring shows only
while the keyboard is in use, from a key press until the next pointer press,
because browsers treat the card's focus on load as keyboard focus and would
otherwise draw it over the photo before any input.

## Public profiles and sharing

English home, explorer and profile URLs use `/`, `/explore` and `/personas/{id}`;
Korean and Japanese add `/ko` and `/ja` prefixes. Explicit prefixes control initial
server HTML and browser display. Unprefixed pages use the saved language cookie,
then the highest-priority supported `Accept-Language` preference. Korean/Japanese
preferences temporarily redirect to their prefixes; English or no detection
renders English in place. Responses vary on `Accept-Language, Cookie` and are
non-cacheable. `/en` page URLs permanently normalize to their unprefixed English
counterpart, saving English to prevent a language-detection bounce. Language
switching preserves mounted inputs, browsing state, queries and private fragments,
replaces the language prefix and saves the choice in browser storage and a
host-only cookie. Navigation and sharing retain the language. `/` is the stable
`x-default` destination.
Each variant has self-canonical metadata, localized SEO/OG/Twitter writing and
image alt, reciprocal three-language plus `x-default` links, and matching HTML,
OG and JSON-LD language declarations. Sitemap entries repeat these alternates.
Missing profiles stay 404/noindex without language alternates. Persona public
writing remains in its original language. Main sharing previews combine the
existing anime/photo editorial portraits and localized copy at 1200×630; individual
profile renditions continue using the selected style's first public gallery photo.

Keep published personas visible even at capacity, with no capacity badge.
The token-aware Reselection listing hides a persona who ended a relationship
with the current handle only; public profiles and other visitors' decks remain
available. Selection and test starts enforce that exclusion and the five-assignment
limit at reservation time.

The contact form asks for a Starting relationship using one native radio group:
Dating (selected by default, newly dating), Flirting, Friends and Strangers. Show
a short description per choice, use the existing cherry-rose selected treatment
and visible keyboard focus, and preserve the choice across locale changes and
failed submissions. Friends is platonic and independent of gender. This selection
does not invent user facts or shared history. See [Starting relationship](starting-relationship.md).

Registration silently removes selected personas whose relationship with that handle
has ended, then saves the remaining eligible Likes. If none remain, ask the visitor
to choose someone else. Distinguish that case from a changed public Catalog, expired
consent, failed human verification, an unusable reselection link and service failures.
Keep contact/profile inputs, relationship and language choices mounted during recovery.
Offer in-place Catalog and consent-notice refreshes; a new notice requires fresh consent.
Rate limits return HTTP 429 with `Retry-After`, expose the request ID and retry header
to Discovery, show the retry time and prevent repeat submission until it expires.
The IP budgets are 30 verification attempts per minute and 30 successful registrations
per rolling hour, including successful repeat requests. Rejected registrations spend
no hourly credit. Successful partial exclusion has no additional notice.
Name is required in both the contact form and the registration API; reject empty,
whitespace-only, untrimmed API names and names longer than 100 characters. The form
trims names before submission. Age and gender remain individually optional. All
three display languages and the versioned privacy notices state these requirements.

Keep contact registration in one continuous flow: required name first, phone number,
optional age and gender, Starting relationship, preferred conversation language,
optional invitation code, then disclosure and consent. Use the same label size, weight
and ink color for name as the other fields, with a short naming placeholder. Prefix
the required name and phone labels with a small, muted asterisk; expose requiredness
through native input semantics. Give the optional age, gender and invitation-code
markers that same small, muted, normal-weight treatment. Reserve error-colored emphasis for actual errors. Label
age simply as age, without the age-in-years qualification. Remove the separate “A little about
you” heading and explanatory block. Gender uses the same Radix dropdown component,
selected treatment and keyboard focus as the existing language controls, including
an explicit not-specified choice. Preserve profile inputs through failed submissions
and display-language changes.

Keep the existing Discovery cards, swipe interactions, inline reading view and
contact form. Show sharing only at the end of the expanded profile at
`/personas/{id}`, after all profile content. Use a full-width, white, rounded
action row with centered icon and visible text; it scrolls with the profile
rather than staying fixed. Keep the share row and its inline success/failure
feedback clear of the floating Like/Pass controls and phone safe area. Compact
cards at `/explore` and the reading toolbar have no sharing control. Do not add a
separate persona menu, directory or profile layout. `/personas/{id}` is a direct
entry into that same Discovery, with the target opened in the inline reading
view and prioritized in the deck. Preserve existing Like/Pass choices and allow
the shared persona to be chosen again. All registration continues through the
normal form with the current Likes. Keep IDs stable across name edits.
Opening details updates the address; collapse returns to `/explore` without
losing the current card, photo, Likes or reselection fragment. Public writing
remains in its original language.

Use the native share sheet or clipboard copying with accessible success/failure
feedback. Shared URLs include the selected anime/photo style and a public preview
version. Advertise a versioned, same-origin 1200×630 JPEG made from the first
same-style gallery photo, read directly from R2 after checking the live public
Catalog. Place the uncropped portrait over a blurred, dimmed copy of the same
photo; draw a small RenAI watermark at the lower-right without covering the face.
Keep the cherry-rose brand symbol and white wordmark on a transparent background,
with no surrounding badge or background box.
Use the native Images binding for composition. Do not expose arbitrary R2 keys,
private identity sheets or user-supplied source URLs. Check publication and
current gallery selection before serving cached renditions too.

Include JPEG MIME type, dimensions, secure URL and alt text in Open Graph and
explicit large-image Twitter metadata. Home/explorer and genuinely absent
same-style photos use the branded PNG from `design/social.html`; rendering or
storage failures return retryable image errors rather than substituting it for
a published persona. Keep HTML independent of image fetching. Bump the rendition
version when changing its layout/watermark. Deployment checks fetch the advertised
images and validate real JPEG bytes, dimensions and the 5 MB output limit. Verify
the photo and watermark pixels in a real Cloudflare preview. Keep search canonical
URLs independent of style. Return profile content and unique metadata in the
first HTML for all visitors, including non-JavaScript crawlers. Home renders its
editorial content independently of the live Catalog. `/explore` opens directly on
its cards, with no loading screen: the Worker samples the first page in the
language the browser will choose (`Accept-Language`, as `navigator.languages`),
renders it and embeds that page and its cursor so browsing continues without
resampling. A page sampled for a different saved language is replaced by a sample
in that language. The Worker waits at most three seconds; on failure it returns
the loading shell without a snapshot, and the browser fetches the listing with
inline retry. Public profile links keep their server-rendered content and public
snapshot. Browsing shows each photo's stored 640px display rendition rather than
its original; previews and sitemaps keep originals. On home, only the selected
hero portrait loads at high priority. Sitemap
and image locations reflect publication changes without rebuilding. JSON-LD
describes fictional creative works rather than claiming personas are real people.
Shared URLs contain no private fragments, handles or browser choices. Missing
and unpublished personas return 404/noindex; upstream failures return
retryable 503s rather than masquerading as missing profiles.

## Review

Check 360px and 390px phones, tablet and desktop; Korean, English and Japanese;
keyboard focus, touch targets, reduced motion and image failures. Keep navigation,
profile details, Like/Pass and waitlist registration working. Favicon, touch icon,
header and footer share the same brand symbol.
