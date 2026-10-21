import { verifyPreview } from "../src/preview-deployment.ts";

const [base, revision] = process.argv.slice(2);
if (!base || !revision) throw new Error("Usage: check-preview URL REVISION");
process.stdout.write(`${JSON.stringify(await verifyPreview(base, revision))}\n`);
