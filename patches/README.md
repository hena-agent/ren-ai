# Knip production script entries

Knip 6.43.0 discovers Persona Lab's `src/run.mjs` from both its executable and
its `start` script, but labels the script entry as development-only. The new
production-entry filter then drops it, reporting its live imports as unused.

The patch marks entries shared with `start` as production entries. It restores
traversal of the real application, without ignoring files or unused exports.
Verify with `bun run knip`; remove the patch when upstream preserves these
production script entries.
