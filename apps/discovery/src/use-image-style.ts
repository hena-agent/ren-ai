import { useState } from "react";
import { flushSync } from "react-dom";
import { readImageStyle, saveImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import { decodeStyleImages, revealImageStyle } from "./style-transition.ts";

export type StyleIssue = "storage" | "load" | undefined;

export function useImageStyle(initialStyle?: ImageStyle) {
  const [style, setStyle] = useState(initialStyle ?? readImageStyle);
  const [changing, setChanging] = useState(false);
  const [issue, setIssue] = useState<StyleIssue>();
  async function choose(next: ImageStyle, images: readonly string[]) {
    if (changing || next === style) return;
    const started = performance.now();
    setChanging(true);
    setIssue(undefined);
    let stage = "images.decode";
    try {
      await decodeStyleImages(images);
      stage = "transition";
      await revealImageStyle(() => {
        flushSync(() => {
          setStyle(next);
          setIssue(saveImageStyle(next) ? undefined : "storage");
        });
      });
    } catch (cause) {
      performance.clearMarks("discovery.imageStyle.failed");
      performance.mark("discovery.imageStyle.failed", {
        detail: {
          operation: "discovery.imageStyle",
          stage,
          outcome: "failed",
          style: next,
          code: "IMAGE_STYLE_CHANGE_FAILED",
          durationMs: performance.now() - started,
          causeName: cause instanceof Error ? cause.name.slice(0, 80) : "ImageStyleFailure",
        },
      });
      setIssue("load");
    } finally {
      setChanging(false);
    }
  }
  return { style, changing, issue, choose };
}
