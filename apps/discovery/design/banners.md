# Ren AI display banners

Open `../public/banners/index.html` in a browser to review both banners and download
their exports. No application server or API is needed. These are campaign assets;
the Discovery landing page does not embed them.

## Creative

- Headline: **네 생각나서, 문자했어.**
- Supporting copy: iMessage로 이어지는 AI와의 일상
- CTA: 만나보기
- Installation note: 별도 앱 설치 없이
- Editorial persona: 백지아, anime style. Uses the existing `dohee-anime.webp`;
  asset provenance is recorded in [README.md](README.md). No new image generation.
- Explicitly illustrative incoming messages: “오늘 어땠어?” and
  “난 아까 네 생각났는데.” No immediate-match or exclusive-relationship promise.

## Deliverables

All deliverables are in `apps/discovery/public/banners/`:

| File                                          | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| `index.html`                                  | Review page with both actual-size HTML banners and downloads |
| `banner.html`, `banner.css`                   | Shared HTML/CSS source, no JavaScript                        |
| `ren-ai-1200x120.webp`, `ren-ai-750x180.webp` | Preferred animated image exports                             |
| `ren-ai-1200x120.gif`, `ren-ai-750x180.gif`   | Animated exports for GIF placements                          |
| `ren-ai-1200x120.png`, `ren-ai-750x180.png`   | Completed-conversation stills                                |

The HTML uses a 1200×120 layout above a 900px viewport width and a 750×180 layout
below it. Embed at the exact placement dimensions. It is not a fluid mobile ad.
The character, headline and CTA stay visible throughout the six-second loop.
The typing indicator gives way to two incoming messages, then the messages fade
before the next loop. Reduced motion displays the completed conversation without
animation. One accessible link covers the banner; decorative messages are hidden
from assistive technology. The link opens the landing page in a new tab with
campaign UTM parameters.

## Embedding

After these assets are hosted, use their origin in place of `YOUR_ASSET_ORIGIN`:

```html
<iframe
  src="https://YOUR_ASSET_ORIGIN/banners/banner.html"
  width="1200"
  height="120"
  title="Ren AI — 네 생각나서, 문자했어."
  style="border: 0; display: block"
></iframe>
```

For the other placement, set `width="750" height="180"`. Keep `banner.css`,
`../brand.svg` and `../landing/dohee-anime.webp` accessible at their relative
paths. HTML loads Noto Sans KR from Google Fonts with a local Korean sans-serif
fallback; allow Google Fonts in the hosting content-security policy if used.
The image exports contain rendered text and require no font requests.

For an image placement, wrap the selected GIF or WebP in a link. Example:

```html
<a
  href="https://renai.im/?utm_source=banner&amp;utm_medium=display&amp;utm_campaign=thinking_of_you"
>
  <img
    src="https://YOUR_ASSET_ORIGIN/banners/ren-ai-750x180.webp"
    width="750"
    height="180"
    alt="Ren AI — 네 생각나서, 문자했어. iMessage로 이어지는 AI와의 일상. 만나보기"
  />
</a>
```

For reduced-motion-aware placements, use a `picture` element with the PNG as a
`source media="(prefers-reduced-motion: reduce)"` before the animated image.
Image formats cannot respond to that preference themselves.

## Export settings and verification

The checked-in exports were captured in Chromium at device scale 1 after images
and Noto Sans KR finished loading. CSS animations were paused and sampled by
setting each animation's `currentTime` to `frame * 1000 / 12`, for frames 0–71.
Static PNGs were captured with reduced motion enabled.

Given those numbered PNG frames, encode GIF with FFmpeg:

```sh
ffmpeg -framerate 12 -i 'frames/%03d.png' \
  -filter_complex 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle' \
  -loop 0 ren-ai-1200x120.gif
```

Encode WebP with libwebp's `img2webp` (83ms per frame, approximately six seconds):

```sh
img2webp -loop 0 -lossy -q 82 -m 6 -d 83 frames/*.png -o ren-ai-1200x120.webp
```

Repeat for each placement's frames. After copy or styling changes, regenerate
all six images. Verify the first frame, each message arrival, the completed
conversation, loop reset, exact canvas sizes, keyboard focus and reduced motion.
