import { useState } from "react";
import { readImageStyle, saveImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";

export type StyleIssue = "storage" | undefined;

export function useImageStyle(initialStyle?: ImageStyle) {
  const [style, setStyle] = useState(initialStyle ?? readImageStyle);
  const [issue, setIssue] = useState<StyleIssue>();
  function choose(next: ImageStyle) {
    if (next === style) return;
    setStyle(next);
    setIssue(saveImageStyle(next) ? undefined : "storage");
  }
  return { style, issue, choose };
}
