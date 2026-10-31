// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { staticPages } from "./prerender.ts";

test("home prerenders complete public HTML, and dynamic pages keep the bare shell", async () => {
  const template = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pages = await staticPages(template);
  const home = pages["about.html"];
  expect(home).toContain("A little more");
  expect(home).toContain('class="about-hero"');
  expect(home).toContain('<link rel="canonical" href="https://renai.im/about"');
  expect(home).toContain('property="og:image" content="https://renai.im/social-en-v2.png"');
  expect(home).not.toContain('id="public-personas"');
  expect(pages["template.html"]).toBe(template);
});
