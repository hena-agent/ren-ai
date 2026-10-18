# Landing artwork

The site serves flattened conversation images, not a live recreation of iOS.
Run `bun run design:assets` from this app after editing the transcript or artwork.
The offline exporter requires ImageMagick, `rsvg-convert` and Apple SD Gothic
Neo (macOS). Review all three exported languages before shipping.

Message text is 44px in a 726px-wide device coordinate system. Display the device
at least 272px wide so messages stay above 16px; the 390px mobile layout displays
them at approximately 21px. Export 1452×2888 lossless WebP, retaining 2× screen
rasterization rather than shrinking the full device to 600px.

Line breaks are art-directed per language. Export checks enforce transcript
agreement, text fitting within each bubble, separation from the composer and the
minimum message size. Bubble width comes from ImageMagick font measurements;
height and text baselines come from line count, line height and explicit padding.

`preview-desktop.webp` and `preview-mobile.webp` are review snapshots of the
photo-led redesign's first viewport, not runtime assets.
`preview-conversation.webp` records the conversation at a 390px-wide mobile
layout and 2× device pixel ratio.

`iphone.png` is the iPhone X portrait PNG from
[pixelsign/html5-device-mockups](https://github.com/pixelsign/html5-device-mockups),
revision `e5a38fc2f8bd43bdfee2acfc5cd7bae12a078ec2`, under
`public/landing/LICENSE-device.txt` (MIT).
It is resized and composited with Ren AI's fictional conversation and profile image.

The photographs are static editorial selections from Ren AI's published Catalog,
exported on 2026-10-18. They do not depend on the local authoring service at runtime.
Refresh or remove these selections when the represented persona is withdrawn:

| Asset             | Persona ID                           | Published source image ID            |
| ----------------- | ------------------------------------ | ------------------------------------ |
| seowoo.webp       | 07de7acd-f3ba-468b-a7fe-0cf1e043dcbc | ae478693-ac65-496e-9be2-25794ac7d07d |
| seowoo-daily.webp | 07de7acd-f3ba-468b-a7fe-0cf1e043dcbc | adeccd09-2966-4530-8df1-d6115af38a6c |
| seoyeon.webp      | 3248c8d9-cb9e-4569-8f5c-10d24d9f5cd2 | e775fea7-2f3d-4012-9e74-a5a6ab023d50 |
| seoyul.webp       | 51d61c01-d217-4621-a281-8481a1667e32 | e64c71c9-272c-4704-9f90-eb8477e114a8 |
