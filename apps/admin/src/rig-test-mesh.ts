import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";

export interface RigPoint {
  x: number;
  y: number;
}
type Binding = { bone: string; x: number; y: number; weight: number };

function axis(start: number, end: number, step: number) {
  const values = [start];
  for (let next = (Math.floor(start / step) + 1) * step; next < end; next += step)
    values.push(next);
  values.push(end);
  return values;
}

/** Global grid lines make overlapping PNGs sample the same continuous skinning field. */
export function weightedLayerGeometry(
  layer: RigArtworkLayer,
  width: number,
  height: number,
  bind: (point: RigPoint) => Binding[],
  columns = 64,
) {
  const [left, top, right, bottom] = layer.bounds;
  const xs = axis(left, right, width / columns),
    ys = axis(top, bottom, width / columns);
  const uvs: number[] = [],
    triangles: number[] = [],
    bindings: Binding[][] = [];
  const scale = 1000 / width;
  for (const [row, y] of ys.entries())
    for (const [column, x] of xs.entries()) {
      bindings.push(bind({ x: x * scale, y: (height - y) * scale }));
      uvs.push((x - left) / (right - left), (y - top) / (bottom - top));
      if (row < ys.length - 1 && column < xs.length - 1) {
        const a = row * xs.length + column,
          b = a + 1,
          c = a + xs.length;
        triangles.push(a, c, b, b, c, c + 1);
      }
    }
  return { uvs, triangles, vertices: { weighted: true, bindings }, hull: 0 };
}
