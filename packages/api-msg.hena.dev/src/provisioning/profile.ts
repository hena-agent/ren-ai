import { createHash } from "node:crypto";

type Run = (file: string, args: readonly string[]) => Promise<string>;
type Identity = { identifier: string; requirement: string };
type Paths = { bun: string; imsg: string };

function string(value: string): string {
  const escaped = value.replace(/[<>&"']/g, (character) => `&#${character.charCodeAt(0)};`);
  return `<string>${escaped}</string>`;
}

function dict(entries: readonly (readonly [string, string])[]): string {
  return `<dict>${entries.map(([key, value]) => `<key>${key}</key>${value}`).join("")}</dict>`;
}

function uuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function identity(identifier: string, path: string, run: Run): Promise<Identity> {
  await run("/usr/bin/codesign", ["--verify", "--strict", path]);
  const output = await run("/usr/bin/codesign", ["-dr", "-", path]);
  const match = /^designated => (.+)/m.exec(output);
  if (!match?.[1]) throw new Error(`No designated code-signing requirement for ${path}`);
  return { identifier, requirement: match[1] };
}

async function receiver(name: string, run: Run): Promise<Identity> {
  const path = (
    await run("/usr/bin/osascript", ["-e", `POSIX path of (path to application "${name}")`])
  ).trim();
  const id = (
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      `${path}Contents/Info.plist`,
    ])
  ).trim();
  if (!id) throw new Error(`Missing bundle identifier for ${name}`);
  return identity(id, path, run);
}

function grant(client: Identity, destination?: Identity): string {
  const entries: [string, string][] = [
    ["Identifier", string(client.identifier)],
    ["IdentifierType", string("path")],
    ["CodeRequirement", string(client.requirement)],
    ["Allowed", "<true/>"],
    ["StaticCode", "<false/>"],
  ];
  if (destination)
    entries.push(
      ["AEReceiverIdentifier", string(destination.identifier)],
      ["AEReceiverIdentifierType", string("bundleID")],
      ["AEReceiverCodeRequirement", string(destination.requirement)],
    );
  return dict(entries);
}

/** Derive policy from the installed executables, never the provisioning terminal. */
export async function discoverPermissionProfile(
  paths: Paths,
  run: Run,
): Promise<{ identifier: string; xml: string }> {
  const clients = await Promise.all(Object.values(paths).map((path) => identity(path, path, run)));
  const receivers = await Promise.all(
    ["Messages", "System Events"].map((name) => receiver(name, run)),
  );
  const services = dict([
    ["SystemPolicyAllFiles", `<array>${clients.map((client) => grant(client)).join("")}</array>`],
    ["Accessibility", `<array>${clients.map((client) => grant(client)).join("")}</array>`],
    [
      "AppleEvents",
      `<array>${clients.flatMap((client) => receivers.map((destination) => grant(client, destination))).join("")}</array>`,
    ],
  ]);
  const digest = createHash("sha256").update(services).digest("hex");
  const identifier = `dev.hena.messaging.pppc.${digest}`;
  const payload = dict([
    ["PayloadType", string("com.apple.TCC.configuration-profile-policy")],
    ["PayloadVersion", "<integer>1</integer>"],
    ["PayloadIdentifier", string(`${identifier}.policy`)],
    ["PayloadUUID", string(uuid(digest.slice(32)))],
    ["Services", services],
  ]);
  const root = dict([
    ["PayloadType", string("Configuration")],
    ["PayloadVersion", "<integer>1</integer>"],
    ["PayloadIdentifier", string(identifier)],
    ["PayloadUUID", string(uuid(digest))],
    ["PayloadDisplayName", string(`Messaging permissions ${digest.slice(0, 16)}`)],
    ["PayloadScope", string("System")],
    ["PayloadContent", `<array>${payload}</array>`],
  ]);
  return {
    identifier,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${root}</plist>\n`,
  };
}
