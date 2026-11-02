# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-03

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main`:** `ff1445cb1fbf25e72f0c3825b273e7db8090582b`

**Readiness:** **BLOCKED for the remaining theme acceptance gate.** PRs #59, #47, #49, #51, #60, #57, #66, and #68 are integrated; post-merge application CI passed on current `main`. PR #67's mandatory local ClamAV workflow and three consecutive full browser runs remain incomplete.

This is a measured engineering snapshot, not an official DataFactor score or a release-readiness claim. It separates current protected-main evidence from work that remains unmerged.

## Assessment source

An earlier owner-provided DataFactor email reported **58.7/100**; this is retained as historical context. A newer owner-provided email screenshot, supplied on 2026-11-03, reports **61.3/100** (shown as `frontend: 61.3 (C)`), 8.7 points from the stated offer threshold. Both estimates are described as approximate and non-binding; no rubric weights are disclosed. The newer email does not include an assessed commit SHA or assessment ID, so **61.3 is not attributed to current `main`**.

The newer screenshot reports these category values: Architecture & Robustness 64, Code Cleanliness 38, Docs & Onboarding 78, Test Coverage 72, Dependency Health 58, CI/CD Maturity 82, Security Hygiene 68, and History & Maintenance 30. These are provider-reported measurements, not recalculated scores or proof that any particular merged PR caused the difference from 58.7.

The assessment's visible file-size fingerprint is consistent with the current code snapshot: DataFactor lists `apps/api/src/index.ts` at 982 LOC, `apps/api/src/store-growth-routes.ts` at 810, and `apps/web/src/StoreThemeStudio.tsx` at 1,105. The corresponding current-main physical-line counts are 1,005, 840, and 1,120; excluding blank lines yields exactly 982, 810, and 1,105. The code tree is identical between `d2d8176` and `ff1445c` (PR #68 changed only this report). This is strong content-scope corroboration, **not commit verification**: the email could refer to either tree or another snapshot, and its Git/history metrics cannot be tied to a SHA. Request the exact assessed SHA/ID before treating 61.3 as a score for a named commit.

| Category                  | Reported score | Current evidence and remaining context                                                                                                                          |
| ------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & Robustness |             64 | Latest email reports 64. PR #57 extracted product routes from the API entry point; further module characterization and refactoring remain.                      |
| Code Cleanliness          |             38 | Latest email reports 38. Merged lint work reduced warnings from 37 to 5 in the API and from 102 to 91 in the web app; current CI reports zero lint errors.      |
| Docs & Onboarding         |             78 | Latest email reports 78. PR #49 added environment-example validation; PR #66 documented theme-preview operations.                                               |
| Test Coverage             |             72 | Latest email reports 72. Merged tests raised measured API coverage; the absolute coverage remains low. Current floors are 15/15/19/17.                          |
| Dependency Health         |             58 | PR #59's dependency remediation is integrated. Current-tree production audit evidence is recorded below.                                                        |
| CI/CD Maturity            |             82 | Latest email reports 82. Application and container-security/integration workflows passed on the integrated mainline tree.                                       |
| Security Hygiene          |             68 | Latest email reports 68. Scans and integration gates passed on recent trees. Hosted alerting and complete historical secret assurance are not established here. |
| History & Maintenance     |             30 | Latest email reports 30 and cites a short history. History is not manufactured; maintainability improves through reviewed changes and ongoing maintenance.      |

## Protected-main measurements

The post-merge application run [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) succeeded on protected `main` at `ff1445c`. Its results are the current integrated baseline:

| Metric                                                               |            Measured result |
| -------------------------------------------------------------------- | -------------------------: |
| API tests                                                            | 424 passed across 83 files |
| Statement coverage                                                   |                     18.70% |
| Branch coverage                                                      |                     18.85% |
| Function coverage                                                    |                     23.12% |
| Line coverage                                                        |                     21.04% |
| Enforced coverage floors (statements / branches / functions / lines) |      15% / 15% / 19% / 17% |
| Playwright browser tests                                             |      103 passed, 1 skipped |
| API lint                                                             |       5 warnings, 0 errors |
| Web lint                                                             |      91 warnings, 0 errors |

The post-merge workflow passed; the first post-merge attempt after PR #49 encountered a PostgreSQL host-port collision, and its retry passed without skipping required checks. The current baseline is from the later successful run above.

The PR #68 container security/integration run [41484072940](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41484072940) passed on its exact report head. Its application source tree is identical to current `main`; PR #68 only changed this documentation file. It reported zero production npm audit vulnerabilities, no HIGH/CRITICAL findings across the source and three images, no secret findings, and successful SBOM and isolated PostgreSQL, proxy, Mailpit, ClamAV, and network integration jobs. This is production-audit evidence; it is not a claim that every dependency audit mode or the full repository history is clean.

## Integrated changes and CI evidence

These changes are on protected `main`; candidate measurements from their old branches are not added together. The final row is the current mainline run.

| PR                                                                                | Integrated change                                     | Merge commit | Post-merge application CI                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [#59](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/59) | Dependency remediation                                | `310818e`    | [41453249187](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41453249187) passed          |
| [#47](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/47) | API and web lint improvements                         | `416fb93`    | Included in later protected-main runs                                                                                      |
| [#49](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/49) | Environment-example validation                        | `88eb857`    | [41462426162](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41462426162) passed on retry |
| [#51](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/51) | Measured API coverage floors                          | `db96d6f`    | [41466536734](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41466536734) passed          |
| [#60](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/60) | Financial regression and PostgreSQL concurrency tests | `ad0a455`    | [41470901167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41470901167) passed          |
| [#57](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/57) | Product-route extraction                              | `63df74c`    | [41475383775](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41475383775) passed          |
| [#66](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/66) | Theme-preview operations documentation                | `d2d8176`    | [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) passed          |
| [#68](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/68) | Evidence-based DataFactor readiness report            | `ff1445c`    | [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) passed          |

PRs #51, #60, #57, and #66 received independent `webskilldesign` approvals for their exact reviewed heads before merge. Each integration followed the repository's protected-branch process. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; no live payment provider was used.

## Remaining findings and acceptance gates

- Coverage has improved, but remains below typical mature-project targets. Continue risk-weighted test additions without excluding production source or padding test counts.
- The latest DataFactor email says 22 files exceed 500 LOC and 5 exceed 1,000, but does not document its file scope or LOC definition. A reproducible current-main audit of 210 production `.js`/`.ts` files under `apps/api/src` and `apps/web/src`, counting physical lines and excluding test/spec files, finds 15 above 500 and 3 above 1,000. These counts are not directly comparable. Proposed PR [#69](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/69) adds a 500-line growth guard while grandfathering those 15 existing production modules at their exact current sizes. On its current exact head `abbbcb0fab749f24aa2baad105ed79c1a62f8956`, five source-size policy tests and the 210-file size check pass locally. Application run [41535385401](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41535385401) and container-security run [41535385426](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41535385426) both passed, including CI, container integration, image scanning, and SBOM jobs; runs on its prior head are not current evidence. Independent `webskilldesign` review is requested and pending.
- API and web lint still report 5 and 91 warnings respectively. No lint errors were reported in the current mainline CI.
- The earlier web bundle advisory of approximately 1.53 MB has not been remeasured or resolved in this snapshot.
- Hosted error reporting, alert routing, and on-call operations are not verified as configured. No complete historical secret audit is claimed.
- The existing environment-example guard checks the API Zod configuration schema and Prisma CLI settings; it does not inventory every direct `process.env.NAME` reference in tests and local tooling. A static scan found references absent from `.env.example`, including CI-provided variables, OS variables, disposable test-database names, and staging smoke-test variables. The cited `STORE_EMAIL_SMTP_HOST` and `STORE_EMAIL_FROM` are already present as commented optional values; `STAGING_TEST_MAILPIT_HOST` and `STAGING_TEST_MAILPIT_API` are not in `.env.example` but the local smoke script defaults to loopback and CI supplies explicit values. The remaining work is to classify/document local-only test variables without putting credentials or persistent database URLs in the example file.
- The assessment labels logging framework and error tracking as absent. The current tree does include operational diagnostics and a structured/redacted runtime logger; external error reporting, alert delivery, and on-call configuration remain unverified. Do not add a second logger package without first identifying a concrete gap.
- PR #67 remains a draft. Its real ClamAV admin UI flow—upload, quarantine, scan, approval, publish, seller refresh preserving edits/logo, and restore/audit—has not completed successfully with a full Playwright report. Three consecutive full local Playwright runs are also incomplete (0/3 recorded as complete).
- Keep PR #67 in draft and Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) open until those acceptance requirements pass on the final reviewed head. Begin local full browser acceptance only with at least 3 GiB of physical memory free; preserve the 500 MiB runtime floor. GitHub CI does not substitute for these local requirements.
- PR #67 remains at exact head `92607b4341d48929c4be00aa9d81b7fa9637e62f`; its exact-head CI passed, but local ClamAV admin UI acceptance and three consecutive complete local Playwright runs remain 0/3. The latest available physical-memory sample was 1.57 GiB free, below the 3 GiB start threshold. No local full browser run was started; retain the 500 MiB runtime floor.

## PR #68 and current report status

PR #68 was independently approved and squash-merged as `ff1445cb1fbf25e72f0c3825b273e7db8090582b`. Its post-merge application CI [run 41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) passed. This document update is a new, separate documentation change; it does not claim that PR #67 is merged or that its local acceptance gates are complete.

## Scope and recommended DataFactor target

The recommended commit for the owner's next DataFactor assessment is protected `main` at **`ff1445cb1fbf25e72f0c3825b273e7db8090582b`**. Its post-merge application CI passed. Submit this exact SHA and retain the assessment ID/result so future score comparisons are commit-verifiable. The supplied 61.3 email is not attributed to this SHA until its original assessment commit is confirmed. Neither score nor CI substitutes for PR #67's remaining local acceptance; this report does not claim the Marketplace is fully release-ready.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, or branch-protection bypass was performed for this report.
