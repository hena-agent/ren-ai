import { join } from "node:path";
import type { SessionContext } from "@opencode/plugin/effect/session";

// Native compaction keeps the environment in the same part as instruction sources.
const sourceBoundary =
  /\n\n(?=Instructions from: |Today's date: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}(?:\n|$)|Here is some useful information about the environment you are running in:)/;
const instructionEnd = (text: string, start: number) => {
  const offset = text.slice(start).search(sourceBoundary);
  return offset === -1 ? text.length : start + offset;
};

function removePriorAdjustments(system: SessionContext["system"], header: string) {
  for (let index = system.length - 1; index >= 0; index--) {
    const part = system[index]!;
    if (part.text.startsWith("<adjustment-review reviewID=")) {
      system.splice(index, 1);
      continue;
    }
    const start = part.text.indexOf(header);
    if (start === -1) continue;
    const end = instructionEnd(part.text, start + header.length);
    const text = part.text.slice(0, start).trimEnd() + part.text.slice(end);
    if (text.trim()) system[index] = { ...part, text };
    else system.splice(index, 1);
  }
}

export function appendAdjustmentInstructions(
  system: SessionContext["system"],
  directory: string,
  adjustments: { markdown: string; review: string },
) {
  const header = `Instructions from: ${join(directory, "ADJUSTMENTS.md")}\n`;
  removePriorAdjustments(system, header);
  if (adjustments.markdown.trim()) {
    const groundRules = `Instructions from: ${join(directory, "AGENTS.md")}\n`;
    const text = `${header}${adjustments.markdown}`;
    const index = system.findIndex((part) => part.text.includes(groundRules));
    if (index === -1) system.splice(1, 0, { type: "text", text });
    else {
      const part = system[index]!;
      const end = instructionEnd(part.text, part.text.indexOf(groundRules) + groundRules.length);
      system[index] = {
        ...part,
        text: `${part.text.slice(0, end)}\n\n${text}${part.text.slice(end)}`,
      };
    }
  }
  if (adjustments.review) system.push({ type: "text", text: adjustments.review });
}
