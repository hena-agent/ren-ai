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
const messageFontSize = 44;
const messageLineHeight = 58;
const messagePadding = 32;
const sharedPhotoHeight = 320;
const outgoingBlue = "#0069df";
const fontFile = "/System/Library/Fonts/AppleSDGothicNeo.ttc";
/** @param {string} text */
const normalize = (text) => text.replace(/\s/g, "");
/** @param {string} text */
const measure = (text) =>
  Number(
    execFileSync("magick", [
      "-background",
      "none",
      "-font",
      fontFile,
      "-pointsize",
      String(messageFontSize),
      `label:${text}`,
      "-format",
      "%w",
      "info:",
    ]).toString(),
  );
/** @param {string} text @param {number} index @param {number} y */
function bubble(text, index, y) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map(measure)) + messagePadding * 2 + 8;
  if (!Number.isFinite(width) || width > 584)
    throw new Error(`Message ${index} exceeds screen width`);
  const height = messagePadding * 2 + messageFontSize + (lines.length - 1) * messageLineHeight;
  const outgoing = index === 1;
  const x = outgoing ? 640 - 28 - width : 28;
  const baseline = y + messagePadding + messageFontSize * 0.82;
  const spans = lines
    .map(
      (line, row) =>
        `<tspan x="${x + messagePadding}" y="${baseline + row * messageLineHeight}">${escape(line)}</tspan>`,
    )
    .join("");
  return {
    height,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="30" fill="${outgoing ? outgoingBlue : "#e9e9eb"}"/><text fill="${outgoing ? "white" : "#161619"}" font-size="${messageFontSize}" font-weight="500">${spans}</text>`,
  };
}
if ((messageFontSize * 272) / 726 < 16)
  throw new Error("Message text must remain at least 16px at the smallest display width");
const temporary = mkdtempSync(join(tmpdir(), "ren-ai-artwork-"));
try {
  for (const { locale, copy, lines } of [
    {
      locale: "ko",
      copy: ko,
      lines: [
        "집 가는 길에 작은\n서점을 발견했어",
        "그냥 지나치진\n않았겠네?",
        "응 ㅋㅋ 한 권만 보려다가\n벌써 한 시간이야",
      ],
    },
    {
      locale: "en",
      copy: en,
      lines: [
        "Found a tiny bookshop\non my way home",
        "You didn't just walk\npast, did you?",
        "haha no. went in for\none book and it's\nbeen an hour",
      ],
    },
    {
      locale: "ja",
      copy: ja,
      lines: [
        "帰り道に小さな\n本屋さんを見つけた",
        "そのまま通り過ぎ\nたりしないよね？",
        "うん笑 一冊だけの\nつもりが、もう一\n時間たってる",
      ],
    },
  ]) {
    let y = 280;
    let photoY = 0;
    const messages = lines
      .map((message, index) => {
        if (normalize(message) !== normalize(copy.home.messages[index]))
          throw new Error(`${locale} artwork differs from its accessible transcript`);
        if (index === 2) {
          photoY = y;
          y += sharedPhotoHeight + 20;
        }
        const rendered = bubble(message, index, y);
        y += rendered.height + 20;
        return rendered.svg;
      })
      .join("");
    if (y - 20 > 1220) throw new Error(`${locale} messages overlap the composer`);
    const artwork = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="1365" viewBox="0 0 640 1365">
      <defs><clipPath id="screen"><path d="M90 0H148Q148 55 190 55H450Q492 55 492 0H550Q640 0 640 90V1275Q640 1365 550 1365H90Q0 1365 0 1275V90Q0 0 90 0Z"/></clipPath><clipPath id="avatar"><circle cx="320" cy="123" r="39"/></clipPath><clipPath id="photo"><rect x="28" y="${photoY}" width="360" height="${sharedPhotoHeight}" rx="28"/></clipPath></defs>
      <g clip-path="url(#screen)" font-family="Apple SD Gothic Neo, sans-serif">
        <rect width="640" height="1365" fill="white"/>
        <path d="M0 0H640V214H0Z" fill="#f8f8fa"/>
        <text x="45" y="47" font-size="32" font-weight="650">9:41</text>
        <path d="M525 42V32M535 42V27M545 42V21" stroke="#151518" stroke-width="6"/>
        <rect x="567" y="23" width="38" height="20" rx="6" stroke="#151518" fill="none" stroke-width="2"/><rect x="571" y="27" width="29" height="12" rx="3" fill="#151518"/><path d="M608 29V37" stroke="#151518" stroke-width="3"/>
        <path d="M42 122L27 138L42 154" stroke="#007aff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <image x="281" y="84" width="78" height="78" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" xlink:href="${photo}"/>
        <text x="320" y="192" font-size="30" text-anchor="middle">한서우 <tspan fill="#8e8e93">›</tspan></text>
        <path d="M0 214H640" stroke="#e5e5ea"/>
        <text x="320" y="249" fill="#737378" font-size="22" text-anchor="middle">iMessage</text>
        <image x="28" y="${photoY}" width="360" height="${sharedPhotoHeight}" preserveAspectRatio="xMidYMin slice" clip-path="url(#photo)" xlink:href="${daily}"/>
        ${messages}
        <circle cx="42" cy="1273" r="27" fill="#f2f2f7"/><path d="M42 1260V1286M29 1273H55" stroke="#8e8e93" stroke-width="3" stroke-linecap="round"/>
        <rect x="87" y="1243" width="529" height="60" rx="30" fill="white" stroke="#c7c7cc" stroke-width="2"/>
        <text x="110" y="1283" fill="#737378" font-size="34">iMessage</text>
        <circle cx="582" cy="1273" r="23" fill="${outgoingBlue}"/><path d="M582 1286V1260M571 1271L582 1260L593 1271" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="216" y="1337" width="208" height="8" rx="4" fill="#101013"/>
      </g></svg>`;
    const source = join(temporary, "screen.svg");
    const screen = join(temporary, "screen.png");
    writeFileSync(source, artwork);
    execFileSync("rsvg-convert", [source, "-w", "1280", "-h", "2730", "-o", screen]);
    execFileSync("magick", [
      new URL("design/iphone.png", root).pathname,
      "-resize",
      "200%",
      screen,
      "-geometry",
      "+86+78",
      "-composite",
      "-define",
      "webp:lossless=true",
      new URL(`public/landing/conversation-${locale}.webp`, root).pathname,
    ]);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
