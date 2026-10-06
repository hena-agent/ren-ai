# Mutation testing is dropped to keep CI fast

Mutation testing took roughly 80–90 minutes unsharded on the hosted runner and blocked PR feedback even after moving to four shards. We remove Stryker, its CI jobs and its supporting tooling to shorten CI time.

## Consequences

- The seven remaining quality gates, including 100% per-file coverage, still run. Coverage proves execution, not that assertions detect changed behavior; we accept losing the mutation score as an automated check of assertion strength.
- Renovate's patch and minor auto-merges now rely on those seven gates.
- This supersedes ADR-0007's mutation-run cost and scheduling consequence, and ADR-0008's mutation-gate requirements, inline Stryker suppressions and mutation-based rationale for styling and copy choices. Those ADRs remain historical records; the styling and copy formats continue as implemented.
