# Public repository security controls

This document records the repository-level controls for the public Marketplace
repository. It does not authorize production deployment, live payment or
streaming activation, or changes to Azure resources.

## GitHub repository controls

The active repository ruleset `Protect main: reviews, checks, and immutable
history` (ruleset ID `26330378`, applied 2026-11-02) requires pull requests,
one approval from someone other than the most recent pusher, dismissal of stale
approvals, resolved review conversations, and successful application and
container security checks. Force-pushes and branch deletion are blocked. The
bypass-actor list is empty, and GitHub reports that the current user cannot
bypass the ruleset.

Required checks:

- `verify` — lint, formatting, typecheck, tests, coverage, build, and browser
  tests against a disposable PostgreSQL service.
- `Audit, build, and scan immutable local images` — dependency policy, image
  vulnerability/secret scans, and SBOM generation.
- `Container network, Mailpit, ClamAV, and proxy integration` — isolated
  container and same-origin proxy validation.

Ruleset emergency recovery is an owner-operated, audited exception, not a
standing bypass: record the incident and scope in a GitHub issue, obtain a
second administrator's written approval, make the narrowest temporary ruleset
change, record the GitHub audit-log event, restore enforcement immediately,
and attach the restoration evidence to the issue. Never use emergency recovery
to waive failed or unavailable CI for a normal merge.

## Workflows and execution boundary

- Workflows use a read-only repository token and do not receive production,
  payment, email-marketing, or live-streaming credentials.
- Test databases and peppers are synthetic and scoped to ephemeral jobs.
- Pull-request code is executed only in non-deploying verification jobs.
- Container actions are pinned to full commit SHAs; checkout does not retain
  credentials in the worktree.
- GitHub Actions is restricted to the reviewed action repositories used by
  this project (`actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact`, `aquasecurity/trivy-action`, and `azure/login`),
  and the repository requires full-length action commit SHAs. Repository
  workflow-token defaults remain read-only; workflows cannot approve PRs.
- The Azure staging workflow is intentionally outside this change. PR #34 must
  remain a draft, and its workflow must not be run until environment approval,
  identity scope, spending, and deployment controls are separately approved.
- A billing-blocked or runner-unavailable workflow is not a successful test.
  PR #50 remains unmerged until its required checks actually execute and pass.

## Secret scanning and incident response

GitHub provider-pattern secret scanning and push protection are enabled for
this public repository. GitHub reports secret scanning as free for public
repositories. Non-provider/generic pattern scanning and validity checks remain
disabled because GitHub documents them as Secret Protection/Team capabilities;
validity checks can send detected credentials to issuers. No trial or paid
subscription was started. Reassess those features only if the owner confirms
eligibility and cost.

GitHub secret-scanning alerts were not available before the setting was
enabled. The repository owner should review the Security tab after GitHub's
initial scan completes; this audit did not dismiss or resolve any alert.

If a genuine credential is found, treat it as compromised: identify the owner
and provider, revoke or rotate it through the provider's authorized console,
check logs for use, and only then remove it from working files. Do not rewrite
public Git history as an automatic response; coordinate any history remediation
with the repository owner and affected contributors.

The local history scan found pattern matches in generated naming, notification
template/idempotency identifiers, synthetic payment tests, and explicit example
credentials. Those locations were reviewed as code or placeholders, not
confirmed live credentials. Scanner heuristics are not proof that no secret
exists; continue monitoring GitHub alerts and run history-aware scans during
release reviews.

## Contributor privacy and intellectual property

Commit metadata may expose contributor email addresses in public history.
Contributors should use GitHub's private noreply address for future commits.
Historical metadata is preserved; it is not rewritten as part of this work.

Ownership and licensing evidence for application code, Market Lane branding,
fonts, screenshots, and embedded imagery is tracked separately in
[`IP_ASSET_PROVENANCE.md`](IP_ASSET_PROVENANCE.md). No open-source license is
added by this change.
