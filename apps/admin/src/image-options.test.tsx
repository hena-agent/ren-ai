import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useBrowser } from "../test/browser.ts";
import { ImageOptions } from "./image-options.tsx";
import copy from "./copy.json";

useBrowser();

test("failed per-photo drafts restore separate editable fields with correct native labels and submitted names", () => {
  document.body.innerHTML =
    '<form id="editor">' +
    renderToStaticMarkup(
      <ImageOptions
        count={3}
        operation="subportrait:photo"
        prompts={["first", "second", "third"]}
      />,
    ) +
    "</form>";
  const form = document.querySelector("form")!;
  const inputs = form.querySelectorAll("textarea");
  expect([...inputs].map((input) => input.value)).toEqual(["first", "second", "third"]);
  expect(new FormData(form).get("portraitInstructions")).toBe("first");
  expect(new FormData(form).getAll("imagePrompts")).toEqual(["second", "third"]);
  expect(inputs[0]?.dataset["portraitOperation"]).toBe("subportrait:photo");
  expect(inputs[1]?.id).toBe("image-prompt-1");
  expect(inputs[2]?.id).toBe("image-prompt-2");
  expect(form.querySelector('label[for="image-prompt-1"]')?.textContent).toBe(
    `2 · ${copy.portraitInstructionsLabel}`,
  );
  expect(form.querySelector('label[for="image-prompt-2"]')?.textContent).toBe(
    `3 · ${copy.portraitInstructionsLabel}`,
  );
  expect(form.querySelector('option[value="3"]')?.hasAttribute("selected")).toBe(true);
});
