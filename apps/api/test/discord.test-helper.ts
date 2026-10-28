import { Schema } from "effect";

const Link = Schema.Struct({
  type: Schema.Literal(2),
  style: Schema.Literal(5),
  label: Schema.String,
  url: Schema.String,
});
const Text = Schema.Struct({ type: Schema.Literal(10), content: Schema.String });
const Divider = Schema.Struct({
  type: Schema.Literal(14),
  divider: Schema.Literal(true),
  spacing: Schema.Literal(1),
});
const Section = Schema.Struct({
  type: Schema.Literal(9),
  components: Schema.Array(Text),
  accessory: Link,
});
const Links = Schema.Struct({ type: Schema.Literal(1), components: Schema.Array(Link) });
/** One Components V2 webhook body; Discord rejects content or embeds beside its components. */
const DiscordCard = Schema.Struct({
  flags: Schema.Literal(32768),
  components: Schema.Tuple([
    Schema.Struct({
      type: Schema.Literal(17),
      accent_color: Schema.Number,
      components: Schema.Array(Schema.Union([Text, Divider, Section, Links])),
    }),
  ]),
  username: Schema.String,
  avatar_url: Schema.String,
  allowed_mentions: Schema.Struct({ parse: Schema.Tuple([]) }),
});

/** What the Operator sees in one posted card: its sender, accent, text and links. */
export const readCard = (json: string) => {
  const body = Schema.decodeUnknownSync(Schema.fromJsonString(DiscordCard), {
    onExcessProperty: "error",
  })(json);
  const [card] = body.components;
  const texts: string[] = [];
  const links: { label: string; url: string }[] = [];
  let parts = 1;
  for (const part of card.components) {
    parts++;
    if (part.type === 10) texts.push(part.content);
    if (part.type === 9) {
      parts += part.components.length + 1;
      texts.push(...part.components.map((child) => child.content));
      links.push({ label: part.accessory.label, url: part.accessory.url });
    }
    if (part.type === 1) {
      parts += part.components.length;
      links.push(...part.components.map(({ label, url }) => ({ label, url })));
    }
  }
  return {
    sender: body.username,
    avatar: body.avatar_url,
    accent: card.accent_color,
    text: texts.join("\n"),
    links,
    parts,
  };
};

export const discordPost = async (...[input, init]: Parameters<typeof fetch>) => {
  const request = new Request(input, init);
  return { url: request.url, ...readCard(await request.text()) };
};
