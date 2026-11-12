import { defaultRigJoints, type RigJoint } from "./rig-test-model.ts";
import { Schema } from "effect";
import { RigJointPositions } from "@ren-ai/personas/rig-artwork";

export function bindRigJoints(
  area: HTMLElement,
  status: HTMLElement,
  changed: (joints: RigJoint[]) => void,
) {
  const initial = Schema.decodeUnknownSync(RigJointPositions)(
    JSON.parse(area.querySelector<HTMLElement>("[data-rig-joints]")!.dataset["jointPositions"]!),
  );
  let joints = defaultRigJoints(initial);
  let dragged: RigJoint | null = null;
  const overlay = area.querySelector<HTMLElement>("[data-rig-joints]")!;
  const document = area.ownerDocument;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  overlay.append(svg);
  const markers = joints.map((joint, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(index + 1);
    button.title = joint.label;
    button.addEventListener("pointerdown", (event) => {
      dragged = joints[index]!;
      button.focus({ preventScroll: true });
      button.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    button.addEventListener("keydown", (event) => {
      const directions: Record<string, readonly [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const delta = directions[event.key];
      if (!delta) return;
      event.preventDefault();
      const current = joints[index]!;
      const step = event.shiftKey ? 0.02 : 0.005;
      move(current, current.x + delta[0] * step, current.y + delta[1] * step);
      changed(joints);
    });
    overlay.append(button);
    return button;
  });
  const paint = () => {
    svg.replaceChildren();
    for (const [index, joint] of joints.entries()) {
      const marker = markers[index]!;
      marker.style.left = `${joint.x * 100}%`;
      marker.style.top = `${joint.y * 100}%`;
      marker.setAttribute(
        "aria-label",
        `${joint.label} · 가로 ${Math.round(joint.x * 100)}% · 세로 ${Math.round(joint.y * 100)}% · 방향키로 조정`,
      );
      const parent = joints.find((item) => item.name === joint.parent);
      if (!parent) continue;
      const line = document.createElementNS(svg.namespaceURI, "line");
      for (const [key, value] of Object.entries({
        x1: parent.x * 100,
        y1: parent.y * 100,
        x2: joint.x * 100,
        y2: joint.y * 100,
      }))
        line.setAttribute(key, String(value));
      svg.append(line);
    }
  };
  const move = (joint: RigJoint, x: number, y: number) => {
    joint.x = Math.max(0, Math.min(1, x));
    joint.y = Math.max(0, Math.min(1, y));
    status.textContent = `${joint.label} · ${Math.round(joint.x * 100)}%, ${Math.round(joint.y * 100)}%`;
    paint();
  };
  area.addEventListener("pointermove", (event) => {
    if (!dragged) return;
    const box = area.getBoundingClientRect();
    move(
      dragged,
      (event.clientX - box.left) / Math.max(1, box.width),
      (event.clientY - box.top) / Math.max(1, box.height),
    );
  });
  const finish = () => {
    if (!dragged) return;
    dragged = null;
    changed(joints);
  };
  area.addEventListener("pointerup", finish);
  area.addEventListener("pointercancel", finish);
  paint();
  return {
    current: () => joints,
    reset: () => {
      joints = defaultRigJoints(initial);
      status.textContent = "관절 위치를 초기화했습니다.";
      paint();
      changed(joints);
    },
  };
}
