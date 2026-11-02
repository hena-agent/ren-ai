import type { SocialPlatform } from "@ren-ai/onboarding/social";
import { identityScript, publicScript, sentScript } from "./x-scripts.ts";
import {
  threadsIdentityScript,
  threadsPostsScript,
  threadsComposer,
  threadsSentScript,
} from "./threads-scripts.ts";

export function browserSite(platform: SocialPlatform) {
  if (platform === "threads")
    return {
      home: "https://www.threads.com/",
      profile: (handle: string, replies: boolean) =>
        `https://www.threads.com/@${handle}${replies ? "/replies" : ""}`,
      search: (query: string) =>
        `https://www.threads.com/search?${new URLSearchParams({ q: query }).toString()}`,
      identity: threadsIdentityScript,
      posts: threadsPostsScript,
      ready: '[role="navigation"],input[autocomplete="username"]',
      compose: "https://www.threads.com/",
      create:
        '[role="navigation"] :is(button,[role="button"]):has(svg[aria-label="Create"],svg[title="Create"]),[role="navigation"] a[href="/create"]',
      reply:
        ':is(button,[role="button"]):has(svg[title="Comment"],svg[aria-label="Reply"],svg[aria-label="Comment"]) >> nth=0',
      input: threadsComposer,
      submit: '[role="dialog"] :is(button,[role="button"]):text-is("Post")',
      sent: threadsSentScript,
      prefix: (handle: string) => `/@${handle.toLowerCase()}/post/`,
    };
  return {
    home: "https://x.com/home",
    profile: (handle: string, _replies: boolean) => `https://x.com/${handle}/with_replies`,
    search: (query: string) =>
      `https://x.com/search?${new URLSearchParams({ q: query, f: "live" }).toString()}`,
    identity: identityScript,
    posts: publicScript,
    ready:
      '[data-testid="AppTabBar_Profile_Link"],[data-testid="loginButton"],input[autocomplete="username"]',
    compose: "https://x.com/compose/post",
    create: undefined,
    reply: '[data-testid="reply"] >> nth=0',
    input: '[data-testid="tweetTextarea_0"]',
    submit: '[data-testid="tweetButton"]',
    sent: sentScript,
    prefix: (handle: string) => `/${handle.toLowerCase()}/status/`,
  };
}
