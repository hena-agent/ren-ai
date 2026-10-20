import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Site } from "./site.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

test.each(["/", "/explore"])(
  "NVIDIA attribution is reachable on direct visits to %s in each locale",
  async (path) => {
    window.history.replaceState({}, "", path);
    for (const locale of ["ko", "ja", "en"]) {
      localStorage.setItem("renai.locale", locale);
      render(
        <Site
          client={{
            profiles: async () => [
              {
                id: "example",
                name: "하린",
                bio: "안녕하세요",
                imageUrl: "https://example.com/photo.png",
              },
            ],
            join: async () => ({ status: "waiting" }),
          }}
        />,
      );
      expect(
        (await screen.findByRole("link", { name: "NVIDIA Nemotron-Personas-Korea" })).getAttribute(
          "href",
        ),
      ).toBe("https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea");
      expect(screen.getByRole("link", { name: "CC BY 4.0" }).getAttribute("href")).toBe(
        "https://creativecommons.org/licenses/by/4.0/",
      );
      cleanup();
    }
  },
);
