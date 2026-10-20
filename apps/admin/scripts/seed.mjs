import { seedingCommand } from "../src/seeding-command.ts";

process.stdout.write(`${await seedingCommand(process.argv.slice(2), process.env)}\n`);
