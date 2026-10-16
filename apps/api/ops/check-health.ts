import { verifyHealth } from "@ren-ai/transport/health";

const [url, service, revision] = process.argv.slice(2);
if (!url || !service || !revision)
  throw new Error("Usage: check-service-health URL SERVICE REVISION");
// Mac updaters consume completed CI artifacts; dependency rollout is checked separately from Worker identity.
const health = await verifyHealth(
  await fetch(new URL("/health", url), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  }),
  service,
  revision,
  true,
);
process.stdout.write(`${JSON.stringify(health)}\n`);
