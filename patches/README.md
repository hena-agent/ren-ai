# OpenCode photo validation

`@opencode/schema@2.0.19` validates Base64 with a repeated four-character regex
group. Large photos exhaust V8's regexp stack when the Worker decodes native
prompt acknowledgements or message history. Bun's JavaScriptCore can accept the
same input, hiding the failure in Mac-only checks.

The patch checks the length separately and uses a flat alphabet/padding regex.
It retains the schema identifier and JSON Schema contract. The latest inspected
release, 2.0.32, still contains the repeated-group validator.

`apps/api/src/opencode/photo-worker.test.ts` exercises the real remote adapter in
workerd with a large photo and checks malformed Base64 rejection. Keep it when
updating OpenCode; remove the patch when an upstream release passes the test.
