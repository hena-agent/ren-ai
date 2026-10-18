// Offline artwork export. The website serves the flattened WebP files only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ko from "../src/copy.json" with { type: "json" };
import en from "../src/copy.en.json" with { type: "json" };
import ja from "../src/copy.ja.json" with { type: "json" };

const root = new URL("../", import.meta.url);
/** @param {string} file */
const png = (file) =>
  "data:image/png;base64," +
  execFileSync("magick", [new URL(`public/landing/${file}.webp`, root).pathname, "png:-"], {
    maxBuffer: 10_000_000,
  }).toString("base64");
const photo = png("seowoo");
const daily = png("seowoo-daily");
/** @param {string} text */
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const temporary = mkdtempSync(join(tmpdir(), "ren-ai-artwork-"));
try {
  for (const { locale, copy, breaks } of [
    { locale: "ko", copy: ko, breaks: [11, 100, 18] },
    { locale: "en", copy: en, breaks: [24, 20, 29] },
    { locale: "ja", copy: ja, breaks: [13, 12, 15] },
  ]) {
    const messages = copy.home.messages
      .map((message, index) => {
        const split = message.length > breaks[index] ? breaks[index] : message.length;
        return `<text x="${index === 1 ? 230 : 42}" y="${[292, 450, 1010][index]}" fill="${index === 1 ? "white" : "#161619"}" font-size="29"><tspan>${escape(message.slice(0, split))}</tspan><tspan x="${index === 1 ? 230 : 42}" dy="39">${escape(message.slice(split).trim())}</tspan></text>`;
      })
      .join("");
    const artwork = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="1365" viewBox="0 0 640 1365">
      <defs><clipPath id="screen"><path d="M90 0H148Q148 55 190 55H450Q492 55 492 0H550Q640 0 640 90V1275Q640 1365 550 1365H90Q0 1365 0 1275V90Q0 0 90 0Z"/></clipPath><clipPath id="avatar"><circle cx="320" cy="123" r="39"/></clipPath><clipPath id="photo"><rect x="22" y="560" width="410" height="355" rx="28"/></clipPath></defs>
      <g clip-path="url(#screen)" font-family="Apple SD Gothic Neo, sans-serif">
        <rect width="640" height="1365" fill="white"/>
        <path d="M0 0H640V214H0Z" fill="#f8f8fa"/>
        <text x="45" y="47" font-size="27" font-weight="700">9:41</text>
        <path d="M525 42V32M535 42V27M545 42V21" stroke="#151518" stroke-width="6"/>
        <rect x="567" y="23" width="38" height="20" rx="6" stroke="#151518" fill="none" stroke-width="2"/><rect x="571" y="27" width="29" height="12" rx="3" fill="#151518"/><path d="M608 29V37" stroke="#151518" stroke-width="3"/>
        <path d="M42 122L27 138L42 154" stroke="#007aff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <image x="281" y="84" width="78" height="78" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" xlink:href="${photo}"/>
        <text x="320" y="192" font-size="23" text-anchor="middle">한서우 <tspan fill="#8e8e93">›</tspan></text>
        <path d="M0 214H640" stroke="#e5e5ea"/>
        <text x="320" y="249" fill="#86868b" font-size="19" text-anchor="middle">iMessage</text>
        <rect x="22" y="263" width="460" height="111" rx="29" fill="#e9e9eb"/>
        <rect x="208" y="420" width="410" height="111" rx="29" fill="#007aff"/>
        <image x="22" y="560" width="410" height="355" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo)" xlink:href="${daily}"/>
        <rect x="22" y="979" width="490" height="111" rx="29" fill="#e9e9eb"/>
        ${messages}
        <circle cx="42" cy="1243" r="27" fill="#f2f2f7"/><path d="M42 1230V1256M29 1243H55" stroke="#8e8e93" stroke-width="3" stroke-linecap="round"/>
        <rect x="87" y="1213" width="529" height="60" rx="30" fill="white" stroke="#c7c7cc" stroke-width="2"/>
        <text x="110" y="1253" fill="#8e8e93" font-size="28">iMessage</text>
        <circle cx="582" cy="1243" r="23" fill="#007aff"/><path d="M582 1256V1230M571 1241L582 1230L593 1241" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="216" y="1337" width="208" height="8" rx="4" fill="#101013"/>
      </g></svg>`;
    const source = join(temporary, "screen.svg");
    const screen = join(temporary, "screen.png");
    writeFileSync(source, artwork);
    execFileSync("rsvg-convert", [source, "-o", screen]);
    execFileSync("magick", [
      new URL("design/iphone.png", root).pathname,
      screen,
      "-geometry",
      "+43+39",
      "-composite",
      "-resize",
      "600x",
      "-quality",
      "90",
      new URL(`public/landing/conversation-${locale}.webp`, root).pathname,
    ]);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
