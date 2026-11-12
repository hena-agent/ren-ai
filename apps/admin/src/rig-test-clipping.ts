/** An eye aperture belongs to the head, never to the iris bone that moves inside it. */
export function eyeClipping(
  target: string,
  polygon: readonly (readonly [number, number])[] | undefined,
  head: { x: number; y: number },
  headIndex: number,
  width: number,
  height: number,
) {
  if (!polygon) return undefined;
  const scale = 1000 / width;
  const bindings = polygon.map(([x, y]) => [
    { bone: "head", x: x * scale - head.x, y: (height - y) * scale - head.y, weight: 1 },
  ]);
  const name = `${target}-clip`;
  return {
    name,
    slot: { name, bone: "head", setup: name },
    attachment: {
      kind: "clipping" as const,
      end: target,
      convex: true,
      vertices: { weighted: true as const, bindings },
    },
    spine: {
      type: "clipping",
      end: target,
      vertexCount: polygon.length,
      vertices: bindings.flatMap(([point]) => [1, headIndex, point!.x, point!.y, 1]),
    },
  };
}
