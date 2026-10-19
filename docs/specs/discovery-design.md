# Discovery design

## Direction

Ren AI is refined, photo-led and personal. Preserve the existing white, cool gray
(`#f4f5f7`), ink (`#20242b`) and red (`#d64032`) palette. Improve proportions,
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

Feature 백도희 in the center hero panel and conversation. Keep one continuous
conversation with a single contact header and photograph: her everyday photo and
message, the visitor's café photo with her heart Tapback and reply, then a real
Spotify song link. Each photo, message and reply appears individually at its own
scroll threshold, expanding into the bottom of the thread and pushing earlier
messages upward. Future messages occupy no space before their arrival. The heart
reaction arrives after the visitor's photo. Scroll reverses these arrivals;
do not split these exchanges into separate sections, numbered cases or resets. Keep the
café photo independent of image style; Dohee's photos and avatars follow it.
Use readable native music-card text, an explicit external link and no autoplay.
Use SVG icons for UI arrows, music, reactions and disclosure controls rather than
text glyphs standing in for icons.

The pinned scene completes its messages before the end of its scroll range so
visitors can pause and read. Short viewports show a flowing conversation with
gentle photographic parallax. Reduced motion and browsers without view timelines
show all messages immediately in normal document flow, with no empty pinning space.

Avoid repeated profile grids, miniature UI screenshots and tilted photo decorations.
Finish with a confident red CTA section. Treat featured profiles as editorial
selections; keep public persona writing in
its original language. The landing remains independent of a live Catalog request.
Desktop navigation uses one horizontal row; smaller screens use a single-row
header with language selection and a menu toggle. The menu closes on a section
selection or Escape, restoring toggle focus on Escape.

## Interaction

First visits start in anime; restore an explicit saved choice thereafter. Keep
anime/photo controls available in both the landing header and production
Discovery. All landing portraits, the scroll scene and its avatar share the
selected style. Browsing keeps its current card, photo index, Likes and contact
input when switching. Remove the blocking first-visit style comparison.

Decode the target images before committing the style. Reveal the updated root
snapshot from the viewport's top-left corner with a 550ms expanding circle, using
native View Transitions. Keep scroll position and parallax progress fixed. Reduced
motion and browsers without View Transitions commit immediately after preparation.
Disable repeat switches while preparing or revealing.
Explorer actions are briefly inert during the change so the prepared card/photo
set cannot advance mid-capture; preserve keyboard focus on the header control.
A preparation failure keeps the current style and offers retry. The last failure's payload-safe stage, code,
style, cause name and duration are recorded in the browser User Timing mark
`discovery.imageStyle.failed`; URLs and error payloads are excluded.

Use short, purposeful feedback: 120–180ms for controls and 180–240ms for movement.
Scroll timelines use scroll progress rather than these control durations.
Navigation has an animated active indicator; buttons visibly respond to presses.
Preserve mounted browsing state and scroll positions when switching tabs.
Hero portraits reveal once and transition on explicit selection; there is no
automatic carousel. Conversation motion follows scroll position and reverses
naturally when scrolling back; there is no autoplay or simulated live typing.
Reduced motion shows immediate control states.
Use native CSS before introducing animation dependencies.

## Review

Check 360px and 390px phones, tablet and desktop; Korean, English and Japanese;
keyboard focus, touch targets, reduced motion and image failures. Keep navigation,
profile details, Like/Pass and waitlist registration working. Favicon, touch icon,
header and footer share the same brand symbol.
