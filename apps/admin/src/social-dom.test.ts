import { Window } from "happy-dom";
import { expect, test } from "vitest";
import {
  identityScript,
  publicScript,
  inboxScript,
  messagesScript,
  candidatesScript,
  sentScript,
  dmSentScript,
} from "../../social/src/x-scripts.ts";

test("fixed X readers extract post/message text and stable links without copying private inbox previews", () => {
  const window = new Window();
  window.document.body.innerHTML = `
    <a data-testid="AppTabBar_Profile_Link" href="/persona_x">Profile</a>
    <article>Alice <a href="/alice">Alice</a><a href="/alice/status/123">12:00</a><div data-testid="tweetText">A public thought</div></article>
    <div data-testid="conversation"><span data-testid="User-Name">Reader @reader</span><a href="/messages/1-2">Open</a><p>PRIVATE_INBOX_PREVIEW</p></div>
    <div data-testid="conversation"><span>No contact handle</span><p>ANOTHER_PRIVATE_PREVIEW</p></div>
    <div data-testid="messageEntry"><div data-testid="tweetText">Hello there</div><time>12:01 PM</time></div>
    <div data-testid="TypeaheadUser">Reader @reader</div>
    <div data-testid="tweetTextarea_0" contenteditable="true">Draft</div>
    <div data-testid="dmComposerTextInput" contenteditable="true">Draft</div>`;
  expect(window.eval(identityScript)).toBe('{"handle":"persona_x"}');
  expect(window.eval(publicScript)).toContain('"body":"A public thought"');
  expect(window.eval(publicScript)).toContain('"url":"/alice/status/123"');
  expect(window.eval(inboxScript)).toBe('[{"contact":"@reader","path":"/messages/1-2"}]');
  expect(window.eval(inboxScript)).not.toContain("PRIVATE");
  expect(window.eval(messagesScript)).toBe('["Hello there"]');
  expect(window.eval(candidatesScript)).toBe('["Reader @reader"]');
  expect(window.eval(sentScript)).toContain('"empty":false');
  expect(window.eval(dmSentScript)).toBe('{"empty":false}');
  window.document.body.innerHTML = "";
  expect(window.eval(identityScript)).toBe('{"handle":null}');
  expect(window.eval(dmSentScript)).toBe('{"empty":true}');
});
