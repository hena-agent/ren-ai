import { Schema } from "effect";
import { RigArtworkImage, RigArtworkModel } from "@ren-ai/personas";
import { ImageModelSelection } from "./image-model.ts";
import { ArtworkLayerSelection } from "./artwork-layer-model.ts";
import { RigFaceGenerationKind } from "@ren-ai/personas/rig-artwork";

export { RigArtworkModel };
export type RigArtworkModel = typeof RigArtworkModel.Type;

export const RigArtwork = Schema.Struct({
  model: RigArtworkModel,
  selection: Schema.optionalKey(ImageModelSelection),
  image: Schema.optionalKey(RigArtworkImage),
  layerize: Schema.optionalKey(ArtworkLayerSelection),
  target: Schema.optionalKey(Schema.Literals(["body", "outfit"])),
  face: Schema.optionalKey(
    Schema.Struct({ kind: RigFaceGenerationKind, sourceLayerImageUrl: Schema.String }),
  ),
});

export const rigArtworkDirection = `Use the supplied anime identity sheet as the visual identity reference. Depict exactly the same adult fictional character as one finished full-body 2D illustration, preserving the sheet's face, apparent age, eye color, hairstyle, hair color, defining features and drawing style. Do not invent a new person. This is a finished character illustration, not a technical diagram, character reference sheet or scene.
The reference is a multi-view sheet of ONE person: do not copy its panel layout or create several figures. The current private character text supplements physique and details not visible on the sheet. Where text conflicts with the sheet's core visual identity, preserve the sheet's identity. Do not illustrate personality, trauma or private emotional darkness as horror, props or dramatic scenes.
Exactly one front-facing full-body figure, looking at the viewer, head to toe entirely inside the frame with generous white margins around hair, hands and shoes. Relaxed A-pose: arms down and angled outward so the white background is visible BETWEEN each arm and the torso; hands open and separate, fingers readable. Space the left and right legs apart so the white background is visible BETWEEN the two legs. Each arm and each leg itself remains one continuous intact limb, including across every joint. Feet facing forward.
For a human character, draw natural human anatomy: continuous skin and soft tissue across shoulders, elbows, wrists, hips, knees and ankles. Upper and lower limbs connect naturally without gaps, cut edges, seams, rings, sockets, hinges, exposed mechanisms or separate joint pieces. No ball-jointed doll, mannequin, marionette, robot or articulated toy anatomy. The pose describes how the person stands, never visible construction inside the body. If the character is explicitly non-human, preserve their described anatomy rather than adding mechanical joints.
Draw the BASE BODY wearing only plain opaque undecorated underwear: a simple bra and briefs for a woman, plain briefs for a man. No outer clothing, shoes, stockings, jewelry, wrist/arm ornaments, ribbons or costume accessories, even if present in the reference or character description. Keep the body's complete anatomy intact beneath the underwear. This base will receive separately authored clothing later. Neutral relaxed posture, gentle closed-mouth smile, hair resting naturally.
Use an opaque plain pure-white background, no floor, cast shadow, scenery, text, watermark or multiple views. Empty hands. Do not imitate an existing named character.
Character text and the optional operator request below supplement the reference; keep its visual identity and the single-figure composition above.`;

export const rigOutfitDirection = `The supplied image is the approved adult character's base body. Make a CLOTHING-ONLY overlay for exactly this body, pose, camera, proportions and full canvas. Do not move, resize, crop or redraw the reference figure. Design the character's intended outfit from the character description below. Show ONLY garments, footwear and costume accessories in their exact worn positions. Omit ALL skin, face, hair, body and underwear pixels; never leave ghost hands, limbs or body silhouettes. Use transparent empty regions, no scenery, cast shadow, text or duplicate figures. Keep separate arm ornaments and wrist accessories aligned with their corresponding arm and wrist. Reconstruct garment material hidden behind adjacent garment pieces so they can overlap during motion. This is a single clothing overlay, not a dressed portrait or a reference sheet. Optional operator direction may refine the outfit but must preserve the supplied body's alignment.`;
