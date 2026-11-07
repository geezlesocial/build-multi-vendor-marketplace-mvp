# Owner checklist — manual DataFactor retest

This checklist is for an owner-operated assessment only. It does not invoke DataFactor or promise a score. The evidence snapshot in [the improvement report](datafactor-improvement-report.md) measures application source at PR #105 merge `e3d04c20703ed62d12ab9b11566d94fdd52a64cc`; this docs-only audit PR will produce a later `main` SHA if merged.

## Before opening the assessment

- [ ] Wait for the documentation PR to receive independent `webskilldesign` review, all required exact-head checks to pass, protected-branch merge, and successful post-merge CI.
- [ ] Fetch protected `main` and record the exact commit SHA and tree SHA after that merge. Do not describe the scan as measuring `e3d04c2` if the provider scans the later documentation commit.
- [ ] Confirm the repository visibility/access and the exact repository/branch or archive the assessment will scan. Record any provider-selected scope or exclusions.
- [ ] Keep the existing engineering measurements as context: 488 tracked JS/TS files; 28 files over 500 physical lines / 26 over 500 trimmed nonblank lines; no files over 1,000 by either method; 61 web lint warnings; API coverage 21.50% statements / 20.77% branches / 26.37% functions / 24.23% lines; full and production-only npm audits with zero reported vulnerabilities.
- [ ] Be ready to disclose the two intentionally gated browser tests, low coverage in several API route modules, remaining oversized modules, outdated dependency entries, and the absence of verified hosted monitoring/on-call. Passing CI is not equivalent to full production readiness.

## During the owner-run assessment

- [ ] Submit manually through the owner's DataFactor account/UI only. Do not use an agent, repository workflow, or assessment API to start or rescore it.
- [ ] Record the assessment ID, UTC date/time, exact assessed commit SHA, repository URL, provider/tool version if shown, scanned-file count, language/file scope, LOC method, and any exclusions.
- [ ] Save the provider's report/export and screenshots in the owner's approved evidence location. Do not place credentials, `.env` values, customer records, database dumps, or secret-bearing logs in GitHub or this report.
- [ ] Record the score and category findings exactly as returned, if present. Label them as provider output; do not infer an engineering score from local metrics.

## After the assessment

- [ ] Compare the provider result with earlier owner-supplied values only if the assessed SHA and scanning scope/method are known to be comparable. Existing historical score reports are not SHA-bound.
- [ ] Map each provider observation to this report's exact-main evidence and classify it as confirmed, partially confirmed, outdated, or unverified. Keep raw provider output distinct from reproducible engineering measurements.
- [ ] If the owner wants the repository evidence updated, make a separate reviewed documentation change that records the exact assessment ID/SHA and does not alter source thresholds or manufacture a target score.
- [ ] Continue remediation through small, independently reviewed PRs. Do not use score changes as a reason to bypass tests, branch protection, privacy boundaries, or production release gates.

## Decision boundary

A manual assessment is not a deployment approval. This report does not verify Azure, persistent database, production provider, live payment, hosted monitoring, secret rotation, or on-call readiness. Keep those release controls on their own owner-approved checklist.
