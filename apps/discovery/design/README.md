# Landing artwork

Conversation text is native HTML from the display-language copy. The photograph,
thread and message layers use CSS scroll-driven animations; no device screenshot
or artwork export is involved. Verify the conversation at the start, middle and
end of its scroll range, scrolling backwards, and with reduced motion enabled.

`preview-desktop.webp` and `preview-mobile.webp` are review snapshots of the
photo-led redesign's first viewport, not runtime assets.
Conversation review captures document the scroll scene, not runtime assets.
`preview-parallax.gif` records forward and backward scrolling on a 390px mobile
viewport in anime mode. Its looping playback is review evidence; the actual scene follows the
visitor's scroll position and does not autoplay.
`preview-style-reveal.gif` samples the native top-left reveal in both directions;
the actual transition runs for 550ms after its target images are decoded.
`preview-closing-desktop.webp` and `preview-closing-mobile.webp` show the
2026-10-19 ink/photo closing with cherry-rose actions. The installation-free and
persona-exclusivity sections use native UI and typography alongside two new
operator-confirmed, section-specific images. iMessage is the only channel shown. The messaging-app symbol is a
local SVG illustration, and first-greeting notifications are explicitly examples.
Exclusivity means each persona connects to a single user, not a persona shared
across many users; the copy and connection illustration explicitly address this
from the persona's side. A small circular crop of the new photograph connects to
an equally sized visitor circle through two thin line segments and an SVG heart.
The lines stop before the heart, with no masked-background workaround. The
section has no profile card or table rows; its invitation says a persona curious
about the visitor will say hello first. Notification examples use the iMessage
symbol rather than another copy of Jia's portrait.
`preview-exclusive-desktop.webp` and `preview-exclusive-mobile.webp` show the
new, section-specific artwork in the simple persona–heart–visitor diagram and
the warmer first-contact invitation. These are review snapshots, not runtime assets.

The portraits are static editorial selections from Ren AI's Catalog,
exported on 2026-10-18–19. They do not depend on the local authoring service at runtime.
Landing display names are independent editorial names: 한수빈 (Subin / スビン),
백지아 (Jia / ジア) and 강하린 (Harin / ハリン). The source asset keys below
remain unchanged to preserve provenance.
Refresh or remove these selections when the represented persona is withdrawn:

| Asset                      | Persona ID                           | Published source image ID            |
| -------------------------- | ------------------------------------ | ------------------------------------ |
| dohee.webp                 | b175afc8-1978-4858-9d36-a5bcb526a844 | caf5c89e-a12f-4b61-a1d6-ffee8123857d |
| dohee-daily.webp           | b175afc8-1978-4858-9d36-a5bcb526a844 | feda8043-c837-4d54-8369-9b8e214a8cf0 |
| seoyeon.webp               | 3248c8d9-cb9e-4569-8f5c-10d24d9f5cd2 | e775fea7-2f3d-4012-9e74-a5a6ab023d50 |
| seoyul.webp                | 51d61c01-d217-4621-a281-8481a1667e32 | e64c71c9-272c-4704-9f90-eb8477e114a8 |
| dohee-anime.webp           | b175afc8-1978-4858-9d36-a5bcb526a844 | fb006895-72b6-4ede-97e9-2c02611380b5 |
| dohee-daily-anime.webp     | b175afc8-1978-4858-9d36-a5bcb526a844 | 74a70d24-9460-438d-8c0b-3f2a94f67de7 |
| dohee-exclusive.webp       | b175afc8-1978-4858-9d36-a5bcb526a844 | f0c62894-aed1-4903-9325-725e48e57619 |
| dohee-exclusive-anime.webp | b175afc8-1978-4858-9d36-a5bcb526a844 | c3abd2b6-e301-4d8a-b196-00228624a3fa |
| seoyeon-anime.webp         | 3248c8d9-cb9e-4569-8f5c-10d24d9f5cd2 | b9c81ba2-88e3-43b9-826f-8e84942002c2 |
| seoyul-anime.webp          | 51d61c01-d217-4621-a281-8481a1667e32 | 8931654f-1fc9-4e18-9167-7332a629c5e5 |

Anime is the first-visit default. `landing-images.ts` selects the matching
editorial assets; decode the target set before capturing the top-left style
reveal. Jia's photo-style daily image was generated once through Admin's confirmed
one-photo workflow on 2026-10-19, using her existing main portrait as reference and
the operator-approved bright everyday selfie direction. Other portraits reuse
existing Catalog images except the two `dohee-exclusive` assets, generated once
each after the operator confirmed anime 1 + photo 1 on 2026-10-19. Each uses its
own style's existing main as the identity reference and shows a new everyday
message-reading scene. Existing photos and published persona data are preserved.
The exclusivity exports are 336px square face crops for the 88–112px circular
nodes, downsampled before export rather than enlarged with CSS transforms.

One continuous scroll-driven conversation shows Jia sharing a daily photo,
reacting with a heart to the visitor's café photo, and sharing a Spotify link.
Each message expands into view separately, pushing the preceding messages upward
beneath one contact header; future messages have zero height. The heart arrives
after the café photo. Scrolling back reverses the sequence, with no
numbered sections or conversation resets. UI symbols use SVG icon assets.
The café image
is [Pexels photo 302899](https://www.pexels.com/photo/302899/), downloaded under the
[Pexels License](https://www.pexels.com/license/) on 2026-10-19. It stays the same
in both styles. The music card links to Daniel Caesar's “Best Part (feat. H.E.R.)”
on Spotify; it uses native text and a musical-note illustration, with no copied
album artwork, embedded player or autoplay.
