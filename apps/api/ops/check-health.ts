import { waitForHealth } from "@ren-ai/transport/health-rollout";

const [url, service, revision] = process.argv.slice(2);
if (!url || !service || !revision)
  throw new Error("Usage: check-service-health URL SERVICE REVISION");
// Mac updaters consume completed CI artifacts; dependency rollout is checked separately from Worker identity.
const health = await waitForHealth(url, service, revision, service !== "admin");
process.stdout.write(`${JSON.stringify(health)}\n`);
