import { Window } from "happy-dom";
import { expect, test } from "vitest";
import { renderPage } from "./page.tsx";
import { femaleCharacter, legacy } from "../test/fixtures.ts";

test("independent images have individual actions and the additional-image panel has no suggestion or completion list", async () => {
  const portraits = { anime: "https://example.net/main-anime.jpg", photo: legacy.imageUrl };
  const secondaryPortraits = [
    { style: "photo" as const, imageUrl: "https://example.net/selfie.jpg" },
  ];
  const window = new Window();
  try {
    window.document.body.innerHTML = renderPage({
      record: { ...legacy, ...femaleCharacter, portraits, secondaryPortraits },
      editing: true,
      draft: "signed",
    });
    expect(window.document.querySelectorAll(".image-option")).toHaveLength(3);
    expect(
      [...window.document.querySelectorAll(".image-regenerate")].map((button) =>
        button.getAttribute("data-image-index"),
      ),
    ).toEqual(["0", "0", "1"]);
    expect(
      window.document.querySelector(".portrait-scene-title, .sub-recommendation, .sub-scenes"),
    ).toBeNull();
    expect(window.document.querySelectorAll('[value="delete-image"]')).toHaveLength(3);
    expect(window.document.querySelectorAll('.sub-portraits [value="subportrait"]')).toHaveLength(
      2,
    );
    expect(
      [...window.document.querySelectorAll('.sub-portraits [value="subportrait"]')].map((button) =>
        button.getAttribute("data-image-maximum"),
      ),
    ).toEqual(["5", "4"]);
    expect(
      window.document
        .querySelector('select[name="imageCount"] option[selected]')
        ?.getAttribute("value"),
    ).toBe("1");
    const full = Array.from({ length: 5 }, (_, index) => ({
      style: "photo" as const,
      imageUrl: `https://example.net/${index}.jpg`,
    }));
    window.document.body.innerHTML = renderPage({
      record: { ...legacy, portraits: { photo: legacy.imageUrl }, secondaryPortraits: full },
      editing: false,
      draft: "signed",
    });
    const buttons = [...window.document.querySelectorAll('.sub-portraits [value="subportrait"]')];
    expect(buttons.map((button) => button.hasAttribute("disabled"))).toEqual([false, true]);
  } finally {
    await window.happyDOM.close();
  }
});
