import { Schema } from "effect";
import { markdownHeadings, splitPersonaMarkdown } from "./profile.ts";

/** A calendar date, never a local-time timestamp or a handwritten age. */
export const BirthDate = Schema.String.check(
  Schema.isPattern(/^(?!0000)\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      value <= new Date().toISOString().slice(0, 10)
    );
  }),
);

/** Only the explicit private identity field can supply a birthday. */
export function birthDateOf(source: string) {
  const { privateMarkdown } = splitPersonaMarkdown(source);
  const headings = markdownHeadings(privateMarkdown);
  const identity = headings.find(
    (heading) => heading.depth === 2 && heading.title === "정체성·외형",
  );
  if (!identity) return undefined;
  const next = headings.find((heading) => heading.depth <= 2 && heading.start > identity.start);
  const match = privateMarkdown
    .slice(identity.end, next?.start)
    .match(/^\n+이름: [^\n]+\n성별: (?:여성|남성)\n생년월일: ([^\n]+)(?:\n|$)/);
  return match && Schema.is(BirthDate)(match[1]) ? match[1] : undefined;
}

/** UTC calendar age; Feb 29 birthdays advance on March 1 in non-leap years. */
export function ageOn(birthDate: string, today = new Date()) {
  const date = today.toISOString().slice(0, 10);
  return (
    Number(date.slice(0, 4)) -
    Number(birthDate.slice(0, 4)) -
    Number(date.slice(5) < birthDate.slice(5))
  );
}
