# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-02

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main`:** `d2d8176376443390f51f255caf4ce55a2c1eece0`

**Readiness:** **BLOCKED for the remaining theme acceptance gate.** The quality changes through PR #66 are integrated and the current mainline CI passed. PR #67's mandatory local ClamAV workflow and three consecutive full browser runs remain incomplete.

This is a measured engineering snapshot, not an official DataFactor score or a release-readiness claim. It separates current protected-main evidence from work that remains unmerged.

## Assessment source

The owner-provided DataFactor email reports an approximate overall score of **58.7/100** (rounded to 59 in its report UI). It describes the estimate as non-binding and does not disclose rubric weights. The category values below are retained as source context; this report does not recalculate or predict a score.

| Category | Reported score | Current evidence and remaining context |
| --- | ---: | --- |
| Architecture & Robustness | 62 | PR #57 extracted product routes from the API entry point. Further module characterization and refactoring remain. |
| Code Cleanliness | 40 | Merged lint work reduced warnings from 37 to 5 in the API and from 102 to 91 in the web app. Current CI reports zero lint errors. |
| Docs & Onboarding | 70 | PR #49 added environment-example validation; PR #66 documented theme-preview operations. |
| Test Coverage | 68 | Merged tests raised measured API coverage; the absolute coverage remains low. Current floors are 15/15/19/17. |
| Dependency Health | 58 | PR #59's dependency remediation is integrated. Current-tree production audit evidence is recorded below. |
| CI/CD Maturity | 78 | Application and container-security/integration workflows passed on the integrated mainline tree. |
| Security Hygiene | 62 | Scans and integration gates passed on the current tree. Hosted alerting and complete historical secret assurance are not established here. |
| History & Maintenance | 30 | The assessment cites a short history. History is not manufactured; maintainability improves through reviewed changes and ongoing maintenance. |

## Protected-main measurements

The post-merge application run [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) succeeded on protected `main` at `d2d8176`. Its results are the current integrated baseline:

| Metric | Measured result |
| --- | ---: |
| API tests | 424 passed across 83 files |
| Statement coverage | 18.70% |
| Branch coverage | 18.85% |
| Function coverage | 23.12% |
| Line coverage | 21.04% |
| Enforced coverage floors (statements / branches / functions / lines) | 15% / 15% / 19% / 17% |
| Playwright browser tests | 103 passed, 1 skipped |
| API lint | 5 warnings, 0 errors |
| Web lint | 91 warnings, 0 errors |

The post-merge workflow passed; the first post-merge attempt after PR #49 encountered a PostgreSQL host-port collision, and its retry passed without skipping required checks. The current baseline is from the later successful run above.

The PR #66 container security/integration run [41477037913](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41477037913) ran on a tree verified identical to merged `main` at `d2d8176`. It reported zero production npm audit vulnerabilities, zero HIGH/CRITICAL findings across the source and three images, zero secret findings, and successful SBOM and isolated PostgreSQL, proxy, Mailpit, ClamAV, and network integration jobs. This is production-audit evidence; it is not a claim that every dependency audit mode or the full repository history is clean.

## Integrated changes and CI evidence

These changes are on protected `main`; candidate measurements from their old branches are not added together. The final row is the current mainline run.

| PR | Integrated change | Merge commit | Post-merge application CI |
| --- | --- | --- | --- |
| [#59](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/59) | Dependency remediation | `310818e` | [41453249187](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41453249187) passed |
| [#47](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/47) | API and web lint improvements | `416fb93` | Included in later protected-main runs |
| [#49](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/49) | Environment-example validation | `88eb857` | [41462426162](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41462426162) passed on retry |
| [#51](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/51) | Measured API coverage floors | `db96d6f` | [41466536734](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41466536734) passed |
| [#60](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/60) | Financial regression and PostgreSQL concurrency tests | `ad0a455` | [41470901167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41470901167) passed |
| [#57](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/57) | Product-route extraction | `63df74c` | [41475383775](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41475383775) passed |
| [#66](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/66) | Theme-preview operations documentation | `d2d8176` | [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) passed |

PRs #51, #60, #57, and #66 received independent `webskilldesign` approvals for their exact reviewed heads before merge. Each integration followed the repository's protected-branch process. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; no live payment provider was used.

## Remaining findings and acceptance gates

- Coverage has improved, but remains below typical mature-project targets. Continue risk-weighted test additions without excluding production source or padding test counts.
- API and web lint still report 5 and 91 warnings respectively. No lint errors were reported in the current mainline CI.
- The earlier web bundle advisory of approximately 1.53 MB has not been remeasured or resolved in this snapshot.
- Hosted error reporting, alert routing, and on-call operations are not verified as configured. No complete historical secret audit is claimed.
- PR #67 remains a draft. Its real ClamAV admin UI flow—upload, quarantine, scan, approval, publish, seller refresh preserving edits/logo, and restore/audit—has not completed successfully with a full Playwright report. Three consecutive full local Playwright runs are also incomplete (0/3 recorded as complete).
- Keep PR #67 in draft and Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) open until those acceptance requirements pass on the final reviewed head. Begin local full browser acceptance only with at least 3 GiB of physical memory free; preserve the 500 MiB runtime floor. GitHub CI does not substitute for these local requirements.
- No new RAM measurement is asserted here. The most recently recorded samples were below the 3 GiB start threshold, so no new full local browser run is represented as complete.

## PR #68 report status

This report is the only intended file change in PR #68. The branch has been reconciled with protected `main` at `d2d8176`; exact-head application and container-security checks must pass on the updated report head. PR #68 remains a draft pending those checks and independent review. The report does not claim that PR #67 is merged or that the remaining acceptance gates are complete.

## Scope and recommended DataFactor target

The recommended commit for the owner's next DataFactor assessment is protected `main` at **`d2d8176376443390f51f255caf4ce55a2c1eece0`**. It contains the reviewed integrations through PR #66, and its post-merge application CI passed. Record the scan as a snapshot of this exact commit; do not treat it as evidence that PR #67's local acceptance is complete or that the Marketplace is release-ready.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, or branch-protection bypass was performed for this report.
