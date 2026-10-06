import { describe, expect, it } from "vitest";
import { discoverPermissionProfile } from "./profile.ts";

async function adHocIdentity(file: string) {
  if (file.endsWith("PlistBuddy")) return "com.apple.receiver\n";
  if (file.endsWith("osascript")) return "/Applications/App.app/\n";
  return 'designated => cdhash H"ABCD"\n';
}

describe("Mac permission provisioning", () => {
  it("discovers installed binaries and Apple receivers and emits a repeatable MDM PPPC profile", async () => {
    const commands: string[][] = [];
    const run = async (file: string, args: readonly string[]) => {
      commands.push([file, ...args]);
      if (file.endsWith("osascript"))
        return args[3]?.includes('"Messages"')
          ? "/Applications/Messages.app/\n"
          : "/System/Library/CoreServices/System Events.app/\n";
      if (file.endsWith("PlistBuddy"))
        return args[2]?.includes("Messages") ? "com.apple.MobileSMS\n" : "com.apple.systemevents\n";
      if (args[0] === "--verify") return "";
      return `Executable=${args[2]}\ndesignated => identifier "${args[2]}" and anchor apple generic\n`;
    };
    const profile = await discoverPermissionProfile(
      { bun: "/opt/messaging/bun", imsg: "/opt/messaging/imsg" },
      run,
    );
    expect(profile).toEqual(
      await discoverPermissionProfile(
        { bun: "/opt/messaging/bun", imsg: "/opt/messaging/imsg" },
        run,
      ),
    );
    expect(profile.identifier).toMatch(/^dev\.hena\.messaging\.pppc\.[a-f0-9]{64}$/);
    expect(profile.xml).toContain("com.apple.TCC.configuration-profile-policy");
    expect(profile.xml).toContain("<key>SystemPolicyAllFiles</key>");
    expect(profile.xml).toContain("<key>Accessibility</key>");
    expect(profile.xml).toContain("<key>AppleEvents</key>");
    expect(profile.xml).toContain(
      "<key>AEReceiverIdentifier</key><string>com.apple.MobileSMS</string>",
    );
    expect(profile.xml).toContain(
      "<key>AEReceiverIdentifier</key><string>com.apple.systemevents</string>",
    );
    expect(profile.xml).toContain(
      "<string>identifier &#34;/opt/messaging/bun&#34; and anchor apple generic</string>",
    );
    expect(profile.xml).toMatchSnapshot();
    expect(profile.xml).not.toContain("Terminal");
    expect(commands).toContainEqual([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "/opt/messaging/bun",
    ]);
    expect(commands).toContainEqual(["/usr/bin/codesign", "-dr", "-", "/opt/messaging/bun"]);
    expect(commands).toContainEqual([
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.fullPathForApplication("System Events").js + "/"',
    ]);
    expect(commands).toContainEqual([
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print :CFBundleIdentifier",
      "/Applications/Messages.app/Contents/Info.plist",
    ]);
  });

  it.each([
    "unsigned",
    "Executable=/opt/bun\n",
    "designated => \n",
    "prefixed designated => invalid",
  ])("does not invent missing code requirements (%s)", async (output) => {
    await expect(
      discoverPermissionProfile({ bun: "/opt/bun", imsg: "/opt/imsg" }, async () => output),
    ).rejects.toThrow("No designated code-signing requirement for /opt/bun");
  });

  it("refuses invalid signatures rather than generating grants", async () => {
    await expect(
      discoverPermissionProfile({ bun: "/opt/bun", imsg: "/opt/imsg" }, async () => {
        throw new Error("Invalid signature");
      }),
    ).rejects.toThrow("Invalid signature");
  });

  it("refuses missing receiver bundle IDs", async () => {
    await expect(
      discoverPermissionProfile({ bun: "/opt/bun", imsg: "/opt/imsg" }, async (file) => {
        if (file.endsWith("PlistBuddy")) return "\n";
        if (file.endsWith("osascript")) return "/Applications/App.app/\n";
        return "designated => anchor apple\n";
      }),
    ).rejects.toThrow("Missing bundle identifier for Messages");
  });

  it("escapes Mac paths and code requirements as data and changes policy identity on binary changes", async () => {
    const paths = { bun: "/opt/<&\"'bun>", imsg: "/opt/imsg" };
    const original = await discoverPermissionProfile(paths, adHocIdentity);
    expect(original.xml).toContain("<string>/opt/&#60;&#38;&#34;&#39;bun&#62;</string>");
    expect(original.xml).toContain("<string>cdhash H&#34;ABCD&#34;</string>");
    const changed = await discoverPermissionProfile(paths, async (file) =>
      file.endsWith("codesign") ? 'designated => cdhash H"EF01"\n' : adHocIdentity(file),
    );
    expect(changed.identifier).not.toBe(original.identifier);
  });
});
