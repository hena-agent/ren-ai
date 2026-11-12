import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RigFacePart } from "@ren-ai/personas/rig-artwork";
import {
  faceRoles,
  faceStateAllowed,
  visibleFaceSlots,
  missingFaceParts,
  rigLayerPlane,
  composeFaceBindings,
  faceExpressionReady,
} from "./rig-face.ts";
import { RigFacePanel } from "./rig-face-panel.tsx";
import { RigFaceControls } from "./rig-face-controls.tsx";
import { bindRigFace } from "./rig-face-browser.ts";
import { storedLayers } from "../test/artwork-layers.ts";
import { useBrowser } from "../test/browser.ts";
import { createRigTestModel, defaultRigJoints } from "./rig-test-model.ts";

useBrowser();
const imageUrl = "/images/00000000-0000-4000-8000-000000000000.png";
const neutral: RigFacePart[] = faceRoles.map(([role]) => ({ role, state: "neutral", imageUrl }));
const parts: RigFacePart[] = [
  ...neutral,
  { role: "eye-left", state: "half", imageUrl },
  { role: "eye-right", state: "half", imageUrl },
  { role: "eye-left", state: "closed", imageUrl },
  { role: "eye-right", state: "closed", imageUrl },
  { role: "mouth", state: "happy", imageUrl },
  { role: "mouth", state: "open", imageUrl },
];
const readyParts: RigFacePart[] = parts.map((part) =>
  part.role.startsWith("pupil")
    ? {
        ...part,
        gaze: { x: 2, y: 2 },
        aperture: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      }
    : part,
);

test("body-relative hair planes surround clothes and the replacement face, independently of upload order", async () => {
  const layer = storedLayers(imageUrl).layers[1]!;
  expect(rigLayerPlane(layer, "outfit")).toBe("outfit");
  expect(rigLayerPlane({ ...layer, plane: "front-body" }, "outfit")).toBe("front-body");
  for (const [name, plane] of [
    ["Back Hair", "behind-body"],
    ["Front Hair", "front-face"],
    ["Hair", "front-face"],
    ["Face and Neck", "face"],
    ["Torso", "body"],
  ])
    expect(rigLayerPlane({ ...layer, name: name! }, "body")).toBe(plane);
  const bindings = composeFaceBindings(
    [
      { layer: { ...layer, plane: "front-face" }, bone: "head", texture: "bangs" },
      { layer: { ...layer, plane: "outfit" }, bone: "chest", texture: "clothes" },
      { layer: { ...layer, plane: "behind-body" }, bone: "head", texture: "back-hair" },
      { layer: { ...layer, plane: "body" }, bone: "chest", texture: "body" },
      { layer: { ...layer, plane: "front-body" }, bone: "head", texture: "front-hair" },
    ],
    neutral.toReversed(),
    1000,
    1800,
  );
  expect(bindings.map((part) => part.texture)).toEqual([
    "back-hair",
    "body",
    "clothes",
    ...neutral.map((part) => `face-${part.role}-neutral`),
    "front-hair",
    "bangs",
  ]);
  const model = await createRigTestModel(1000, 1800, defaultRigJoints(), bindings);
  const cropped = composeFaceBindings(
    [],
    [{ role: "mouth", state: "neutral", imageUrl, bounds: [600, 260, 660, 290] }],
    1000,
    1800,
  );
  expect(cropped[0]!.layer).toMatchObject({ width: 60, height: 30, bounds: [600, 260, 660, 290] });
  expect(model.bones.slice(-2)).toEqual([
    { name: "pupil-left", parent: "head", x: 0, y: 0 },
    { name: "pupil-right", parent: "head", x: 0, y: 0 },
  ]);
  expect(model.slots.map((slot) => slot.name)).toEqual(bindings.map((part) => part.texture));
});

test("facial parts combine expressions, independent blinking and mouth opening without double eyes or pupils", () => {
  expect(missingFaceParts(parts)).toEqual([]);
  expect(missingFaceParts([])).toHaveLength(8);
  const happy = visibleFaceSlots(parts, "happy", "neutral", false);
  expect(happy).toContain("face-mouth-happy");
  expect(happy).toContain("face-brow-left-neutral");
  expect(happy).not.toContain("face-mouth-neutral");
  const closed = visibleFaceSlots(parts, "happy", "closed", true);
  expect(closed).toContain("face-eye-left-closed");
  expect(closed).toContain("face-mouth-open");
  expect(closed.join()).not.toMatch(/pupil|eye-left-neutral/);
  expect(faceStateAllowed("base", "happy")).toBe(false);
  expect(faceStateAllowed("pupil-left", "neutral")).toBe(true);
  expect(faceStateAllowed("pupil-left", "surprised")).toBe(true);
  expect(faceStateAllowed("pupil-left", "closed")).toBe(false);
  expect(faceStateAllowed("pupil-left", "half")).toBe(true);
  expect(faceStateAllowed("lid-left", "half")).toBe(true);
  expect(faceStateAllowed("eye-left", "half")).toBe(true);
  expect(faceStateAllowed("mouth", "closed")).toBe(false);
  expect(faceStateAllowed("mouth", "open")).toBe(true);
  expect(faceStateAllowed("eye-right", "open")).toBe(false);
  expect(faceStateAllowed("brow-left", "worried")).toBe(true);
});

const joy: RigFacePart[] = (
  ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"] as const
).map((role) => ({ role, state: "happy", imageUrl, closed: role.startsWith("eye") }));
test("a partial mouth swap is not a finished expression and smiling closed eyes never show neutral pupils", () => {
  expect(faceExpressionReady(parts, "happy")).toBe(false);
  expect(faceExpressionReady([...parts, ...joy], "happy")).toBe(true);
  expect(visibleFaceSlots([...parts, ...joy], "happy", "neutral", false).join()).not.toMatch(
    /pupil|lid-/,
  );
});

const render = (faceParts: readonly RigFacePart[]) =>
  renderToStaticMarkup(
    <>
      <RigFaceControls layers={{ ...storedLayers(imageUrl), faceParts }} />
      <RigFacePanel id="target" source="source" layers={{ ...storedLayers(imageUrl), faceParts }} />
    </>,
  );
test("the authoring panel identifies missing artwork and enables only supplied expressions", () => {
  expect(render([])).toContain("평상 부품 필요");
  expect(render(parts)).toContain("평상 얼굴 부품 연결 가능");
  expect(render(parts)).toContain('value="thinking" disabled=""');
  expect(render(parts)).toContain('value="mouth"');
  document.body.innerHTML = render(readyParts);
  expect(document.querySelector<HTMLInputElement>("[data-rig-gaze-x]")!.disabled).toBe(false);
  expect(
    renderToStaticMarkup(
      <RigFacePanel
        id="target"
        source="source"
        layers={{
          ...storedLayers(imageUrl),
          faceSources: [
            {
              kind: "closed",
              operationId: "generated",
              model: "test",
              imageUrl,
              bounds: [0, 0, 1, 1],
            },
          ],
        }}
      />,
    ),
  ).toContain("생성한 얼굴 편집 결과");
});

test("face controls change the live slot filter and head-relative pupil bones without restarting the body", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <>
      <RigFaceControls layers={{ ...storedLayers(imageUrl), faceParts: parts }} />
      <RigFacePanel
        id="target"
        source="source"
        layers={{ ...storedLayers(imageUrl), faceParts: parts }}
      />
    </>,
  );
  const player: Parameters<typeof bindRigFace>[1] = {
    slots: null,
    adjust: null,
    repose: vi.fn<() => void>(),
    frame: vi.fn<(dt: number) => void>(),
  };
  const blink = document.querySelector<HTMLSelectElement>("[data-rig-blink]")!;
  blink.value = "neutral";
  const face = bindRigFace(document.body, player, readyParts, 1000);
  const visible = (name: string) => typeof player.slots === "function" && player.slots(name);
  expect(visible("body-1")).toBe(true);
  expect(visible("face-mouth-neutral")).toBe(true);
  expect(visible("face-mouth-happy")).toBe(false);
  expect(visible("face-pupil-left-neutral-clip")).toBe(true);
  expect(visible("face-lid-left-neutral")).toBe(true);
  const unchanged = vi.mocked(player.frame).mock.calls.length;
  face.tick(0);
  expect(player.frame).toHaveBeenCalledTimes(unchanged);
  blink.value = "half";
  blink.dispatchEvent(new Event("input", { bubbles: true }));
  expect(visible("face-eye-left-half")).toBe(true);
  blink.value = "closed";
  blink.dispatchEvent(new Event("input", { bubbles: true }));
  expect(visible("face-eye-left-closed")).toBe(true);
  blink.value = "auto";
  blink.dispatchEvent(new Event("input", { bubbles: true }));
  face.tick(3.85);
  expect(visible("face-eye-left-closed")).toBe(true);
  expect(visible("face-pupil-right-neutral")).toBe(false);
  expect(visible("face-pupil-right-neutral-clip")).toBe(false);
  expect(visible("face-lid-right-neutral")).toBe(false);
  face.tick(0.2);
  expect(visible("face-pupil-right-neutral")).toBe(true);
  const x = document.querySelector<HTMLInputElement>("[data-rig-gaze-x]")!;
  x.value = "1";
  x.dispatchEvent(new Event("input", { bubbles: true }));
  const pupil = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  player.adjust!(
    { names: ["pupil-left", "pupil-right"], bone: () => pupil },
    { globalTime: 0, trackTime: 0, animation: "idle" },
  );
  expect(pupil.x).toBe(4);
  face.dispose();
  const count = vi.mocked(player.frame).mock.calls.length;
  x.dispatchEvent(new Event("input", { bubbles: true }));
  expect(player.frame).toHaveBeenCalledTimes(count);
  const animated: RigFacePart[] = [
    ...readyParts,
    ...joy,
    ...(["pupil-left", "pupil-right"] as const).map((role) => ({
      role,
      state: "half" as const,
      imageUrl,
      aperture: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ] as const,
      gaze: { x: 2, y: 2 },
    })),
  ];
  document.body.innerHTML = render(animated);
  const eyelid = document.querySelector<HTMLSelectElement>("[data-rig-blink]")!;
  eyelid.value = "auto";
  const next = bindRigFace(document.body, player, animated, 1000);
  next.tick(3.75);
  expect(visible("face-pupil-left-half-clip")).toBe(true);
  next.tick(0.1);
  expect(visible("face-eye-left-closed")).toBe(true);
  next.tick(0.12);
  expect(visible("face-eye-left-half")).toBe(true);
  next.tick(0.05);
  expect(visible("face-eye-left-neutral")).toBe(true);
  const expression = document.querySelector<HTMLSelectElement>("[data-rig-expression]")!;
  expression.value = "happy";
  expression.dispatchEvent(new Event("input", { bubbles: true }));
  next.tick(3.75);
  expect(visible("face-eye-left-happy")).toBe(true);
  expect(visible("face-pupil-left-neutral")).toBe(false);
  next.dispose();
});
