# The server keeps its own SQLite file, apart from OpenCode's

The api-msg server keeps its state in a SQLite file of its own, beside the database of the OpenCode host it embeds. That state is Users, Conversations, the record of sends, the imsg bookmark, follow-ups, the Waitlist and blocked handles. Our code reaches OpenCode's data only through OpenCode's API: it never adds tables to OpenCode's file or borrows OpenCode's connection. This replaces the single shared file first chosen in ADR-0004, so that an OpenCode upgrade, migration or reset never touches our tables, and neither side depends on the other's layout.

## Considered Options

- **One file, with our tables prefixed `_` and opened on a connection of our own.** One snapshot would back up everything at once. But our tables would share a file whose layout OpenCode's upgrades change, under OpenCode's rule that every unprefixed table name is its own. OpenCode 2.0.16 also offers embedders no way to run their own migrations.
- **One file, used through OpenCode's own connection** (its internal `Database.Service`). Transactions could span both sides, but our state would depend on an internal OpenCode module, and every test of our tables would have to build OpenCode's database.

## Consequences

- Our file is opened through Effect's `SqlClient`, with Effect's migrator and the same settings as OpenCode's connection: WAL, a 5-second busy timeout, foreign keys on. Table names need no prefix.
- **Backups cover persona data only.** The nightly backup snapshots our file and then the embedded OpenCode's, each with `VACUUM INTO`. That read-only snapshot is the only time our code opens OpenCode's file. The embedded host holds nothing but persona sessions. The Mac's own OpenCode database, with the owner's other sessions, is never read or backed up. If anything else ever creates sessions in the embedded host, the backup has to change.
- The two snapshots are taken a moment apart, so after a restore a Conversation can point at a session missing from OpenCode's copy. The server already rebuilds a missing session from the record.
- Removing a User deletes our rows in one transaction and then runs `VACUUM` on our file. Her session goes through OpenCode's `session.remove`, which hard-deletes it. Fragments can stay in the free pages of OpenCode's file until SQLite reuses them. They never reach a backup, because `VACUUM INTO` copies only live rows.
