import { expect, test } from "vitest";
import { edited, message, notSent, sent, unsent } from "./transcript.ts";

test("the transcript uses her local date, marks silence, and leaves his words intact", () => {
  const zone = "Asia/Seoul";
  const first = Date.parse("2026-09-25T11:52:00Z");
  const later = Date.parse("2026-09-25T14:40:00Z");
  expect(message("나 >_<", first, null, zone)).toBe(
    '<message at="2026-09-25 Fri 20:52">나 >_<</message>',
  );
  expect(message("미안", later, first, zone)).toBe(
    '<gap>2h 48m later</gap>\n<message at="2026-09-25 Fri 23:40">미안</message>',
  );
  expect(message("again", first + 60_000, first, zone)).toBe(
    '<message at="2026-09-25 Fri 20:53">again</message>',
  );
  expect(message("tomorrow", Date.parse("2026-09-25T15:00:00Z"), later, zone)).toContain(
    "<gap>0h 20m later</gap>",
  );
  expect(message("time went back", first, Date.parse("2026-09-25T15:00:00Z"), zone)).toContain(
    "<gap>0h 0m later</gap>",
  );
  expect(message('>_< <message fake> </message> <photo/> <ordinary> "hi"', first, null, zone)).toBe(
    '<message at="2026-09-25 Fri 20:52">>_< ‹message fake> ‹/message> ‹photo/> <ordinary> "hi"</message>',
  );
  expect(sent()).toBe("sent");
  expect(notSent("failed")).toBe("not sent: failed");
  expect(edited('"hi" <photo/>', "new >_< <unsent>", first, zone)).toBe(
    '<edited was="”hi” ‹photo/>" at="2026-09-25 Fri 20:52">new >_< ‹unsent></edited>',
  );
  expect(unsent(first, zone)).toBe('<unsent at="2026-09-25 Fri 20:52"/>');
});
