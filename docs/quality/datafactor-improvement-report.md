# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-03

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main` source snapshot:** `da180c6abc1490098b3f7def6825fd67a42043cb`

**Readiness:** **BLOCKED by PR #67's local acceptance and final integration.** The DataFactor-focused changes listed in this report are integrated through PR #53, and post-merge application CI passed on `da180c6abc1490098b3f7def6825fd67a42043cb`. PR #55 was closed as superseded by the tested formatter-base helper. PR #67 remains draft, is behind current `main`, and still needs the local ClamAV workflow and three consecutive complete browser runs. No 80+ DataFactor score is verified.

This is a measured engineering snapshot, not an official DataFactor score or a release-readiness claim. It separates current protected-main evidence from work that remains unmerged.

## Assessment source

An earlier owner-provided DataFactor email reported **58.7/100**; this is retained as historical context. A newer owner-provided email screenshot, supplied on 2026-11-03, reports **61.3/100** (shown as `frontend: 61.3 (C)`), 8.7 points from the stated offer threshold. Both estimates are described as approximate and non-binding; no rubric weights are disclosed. The newer email does not include an assessed commit SHA or assessment ID, so **61.3 is not attributed to current `main`**.

The newer screenshot reports these category values: Architecture & Robustness 64, Code Cleanliness 38, Docs & Onboarding 78, Test Coverage 72, Dependency Health 58, CI/CD Maturity 82, Security Hygiene 68, and History & Maintenance 30. These are provider-reported measurements, not recalculated scores or proof that any particular merged PR caused the difference from 58.7.

The assessment's visible file-size fingerprint matches the pre-cart-extraction code snapshot: DataFactor lists `apps/api/src/index.ts` at 982 LOC, `apps/api/src/store-growth-routes.ts` at 810, and `apps/web/src/StoreThemeStudio.tsx` at 1,105. At `ff1445c`/`fc56917`, the physical-line counts were 1,005, 840, and 1,120; excluding blank lines yielded exactly 982, 810, and 1,105. PR #58 later extracted cart handlers from `index.ts`; on current `main`, `index.ts` is 940 nonblank/962 physical lines and the new `cart-routes.ts` is 178 nonblank/182 physical lines. The other two listed files remain 810 and 1,105 nonblank lines. PR #68 changed only the report, and PR #69 did not change these three files. This corroborates an earlier source layout, **not an assessed commit**: the email contains no SHA or assessment ID, and neither the 61.3 score nor its Git/history metrics can be attributed to a named commit. Request the exact assessed SHA/ID before making that attribution.

| Category                  | Reported score | Current evidence and remaining context                                                                                                                          |
| ------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & Robustness |             64 | Latest email reports 64. PR #57 extracted product routes from the API entry point; further module characterization and refactoring remain.                      |
| Code Cleanliness          |             38 | Latest email reports 38. Merged lint work reduced warnings from 37 to 5 in the API and from 102 to 91 in the web app; current CI reports zero lint errors.      |
| Docs & Onboarding         |             78 | Latest email reports 78. PR #49 added environment-example validation; PR #66 documented theme-preview operations.                                               |
| Test Coverage             |             72 | Latest email reports 72. Current protected-main coverage is 19.58% statements, 19.40% branches, 24.02% functions, and 22.05% lines; the absolute coverage remains low. Floors are 15/15/19/17.                          |
| Dependency Health         |             58 | PR #59's dependency remediation is integrated. Current-tree production audit evidence is recorded below.                                                        |
| CI/CD Maturity            |             82 | Latest email reports 82. Application and container-security/integration workflows passed on the integrated mainline tree.                                       |
| Security Hygiene          |             68 | Latest email reports 68. Scans and integration gates passed on recent trees. Hosted alerting and complete historical secret assurance are not established here. |
| History & Maintenance     |             30 | Latest email reports 30 and cites a short history. History is not manufactured; maintainability improves through reviewed changes and ongoing maintenance.      |

## Protected-main measurements

The post-merge application workflow [41580747708](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41580747708) succeeded on the current protected-main source snapshot `da180c6abc1490098b3f7def6825fd67a42043cb`. It ran lint, formatting and source-size guards, environment-example validation, typecheck, API tests and coverage, build, and the CMS Playwright suite.

| Metric                                                               | Measured result |
| -------------------------------------------------------------------- | --------------: |
| API tests                                                            | 449 passed across 85 files |
| Statement coverage                                                   | 19.58% |
| Branch coverage                                                      | 19.40% |
| Function coverage                                                    | 24.02% |
| Line coverage                                                        | 22.05% |
| Enforced coverage floors (statements / branches / functions / lines) | 15% / 15% / 19% / 17% |
| Playwright browser tests                                             | 104 passed, 1 skipped |
| API lint                                                             | 5 warnings, 0 errors |
| Web lint                                                             | 91 warnings, 0 errors |
| Production JavaScript/TypeScript source files                        | 228 |
| Current files over 500 / 1,000 physical lines                        | 13 / 2 |

The source-size guard passed on this run. A current-tree count, using the guard's production-source scope under `apps/api/src` and `apps/web/src` and excluding test/spec files, found 13 existing modules above 500 physical lines and 2 above 1,000. The two above 1,000 are `apps/web/src/StoreThemesAdmin.tsx` (1,057) and `apps/web/src/StoreThemeStudio.tsx` (1,120). PR #69 caps the existing oversized modules at their `ff1445c` baselines and prevents further growth beyond those reviewed limits.

The latest recorded full lockfile `npm audit` returned zero findings on `a7decff4d1b3cd6037129cab637780a08392a082`. No subsequent integrated PR changed a package lockfile; run 41580747708 itself did not rerun npm audit.

Container/security evidence remains exact-head evidence: PR #72's Expat remediation passed container integration and image security/SBOM in [run 41568152869](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41568152869). PR #71's image scan reported zero HIGH/CRITICAL and zero secret findings in [run 41573916149](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41573916149), with SBOMs retained in [artifact 13202891693](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41573916149/artifacts/13202891693). These exact-head checks passed before merge; the post-merge application run above is the latest integrated application baseline.

## Integrated changes and CI evidence

These changes are on protected `main`; branch-level metrics are not added together. Each post-merge application run listed below was verified successful. PR #47's change is represented in later protected-main runs.

| PR | Integrated change | Merge commit | Post-merge application CI |
| -- | ----------------- | ------------ | ------------------------- |
| [#59](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/59) | Dependency remediation | `310818e` | [41453249187](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41453249187) passed |
| [#47](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/47) | API and web lint improvements | `416fb93` | Included in later protected-main runs |
| [#49](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/49) | Environment-example validation | `88eb857` | [41462426162](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41462426162) passed |
| [#51](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/51) | Measured API coverage floors | `db96d6f` | [41466536734](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41466536734) passed |
| [#60](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/60) | Financial regression and PostgreSQL concurrency tests | `ad0a455` | [41470901167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41470901167) passed |
| [#57](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/57) | Product-route extraction | `63df74c` | [41475383775](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41475383775) passed |
| [#66](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/66) | Theme-preview operations documentation | `d2d8176` | [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) passed |
| [#68](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/68) | Evidence-based DataFactor readiness report | `ff1445c` | [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) passed |
| [#69](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/69) | Production source-size growth guard | `fc56917` | [41550001781](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41550001781) passed |
| [#54](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/54) | Live Shopping workflow extraction | `8e52431` | [41552524801](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41552524801) passed |
| [#56](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/56) | Buyer/seller dashboard workspace extraction | `6d6c11d` | [41556075917](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41556075917) passed |
| [#58](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/58) | Cart-route extraction and 7 HTTP characterization tests | `8ce2716` | [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602) passed |
| [#70](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/70) | Evidence-based report refresh | `a7decff` | [41561998439](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41561998439) passed |
| [#72](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/72) | Web-runtime Expat remediation | `822949d` | [41572998227](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41572998227) passed |
| [#71](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/71) | Lazy-loaded marketplace route pages | `99ae37e` | [41575884496](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41575884496) passed |
| [#52](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/52) | Product-media route coverage | `4059c7d` | [41578296907](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41578296907) passed |
| [#53](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/53) | Rejected-checkout cart preservation and E2E formatting policy | `da180c6` | [41580747708](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41580747708) passed |

The required independent reviews and protected-branch checks were verified for the PR integrations that required them. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; PR #58's cart-route HTTP tests passed in exact-head CI; PR #53's exact-head application, container integration, and image security/SBOM checks passed before its protected merge. No live payment provider was used.

## Remaining findings and acceptance gates

- API coverage has improved to 19.58% statements, 19.40% branches, 24.02% functions, and 22.05% lines. Continue risk-weighted test additions without excluding production source or padding test counts.
- The latest DataFactor email lists 22 files above 500 LOC and 5 above 1,000, without documenting its scope or LOC method. The current reproducible production-source count covers 228 JavaScript/TypeScript files under `apps/api/src` and `apps/web/src`, excluding test/spec files, and finds 13 above 500 physical lines and 2 above 1,000. These inventories are not directly comparable. PR #69's guard passed on current main and caps the 13 pre-existing oversized modules at their `ff1445c` baselines.
- API and web lint report 5 and 91 warnings respectively, with zero errors in current-main CI. The warning ceilings are enforced; the warnings remain follow-up work.
- PR #71 reduced the measured web bundle from 1,524.50 kB raw / 411.82 kB gzip to 1,002.43 kB raw / 275.80 kB gzip on its exact-head build. Vite's large-chunk and mixed-import warnings remain visible and unsuppressed.
- Current CI still reports a Node.js 20 action-runtime deprecation notice. Dependabot PRs [#62](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/62), [#63](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/63), and [#64](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/64) propose major GitHub Actions upgrades and remain open; they are not included in this snapshot and need their own exact-head checks and review before integration.
- The latest recorded full lockfile `npm audit` returned zero findings on `a7decff`; no later merged PR changed a package lockfile. This report does not present run 41580747708 as a fresh npm audit. Hosted alert routing, on-call configuration, and complete historical secret assurance are not established here.
- The environment-example guard checks the API Zod configuration schema and Prisma CLI settings; it does not inventory every direct `process.env.NAME` reference in tests and local tooling. A static scan found CI-provided variables, OS variables, disposable test-database names, and staging smoke-test variables. The cited `STORE_EMAIL_SMTP_HOST` and `STORE_EMAIL_FROM` are already present as commented optional values; `STAGING_TEST_MAILPIT_HOST` and `STAGING_TEST_MAILPIT_API` are absent but the local smoke script defaults to loopback and CI supplies explicit values. Classify and document remaining local-only variables without adding credentials or persistent database URLs to `.env.example`.
- The assessment labels logging framework and error tracking as absent. The current tree includes operational diagnostics and a structured/redacted runtime logger; external error reporting, alert delivery, and on-call configuration remain unverified. Do not add a second logger package without first identifying a concrete gap.
- PR #67 remains a draft at head `857cc8aa8e920ad48776113c0de6e70ff206de90`, based on `a7decff4d1b3cd6037129cab637780a08392a082`, while protected main is `da180c6abc1490098b3f7def6825fd67a42043cb`. Reconcile it with current main before final-head checks and local acceptance.
- PR #67's required real-ClamAV admin UI flow—upload, quarantine, scan, approval, publish, seller refresh preserving edits/logo, and restore/audit—has not completed successfully with a full Playwright report. Three consecutive full local Playwright runs remain incomplete (0/3 recorded). Keep PR #67 in draft and Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) open until these requirements pass on the final reviewed head.
- The last recorded local memory sample was 2.12 GiB free, below the required 3 GiB starting threshold. This report refresh did not re-sample local physical memory or start browser acceptance. Begin only when at least 3 GiB is free and preserve the 500 MiB runtime floor; GitHub CI does not replace local acceptance.

## Report history and current status

PR #68's initial evidence-based report was merged as `ff1445cb1fbf25e72f0c3825b273e7db8090582b`. PR #70 refreshed its caveats and was merged as `a7decff4d1b3cd6037129cab637780a08392a082`; post-merge application CI [41561998439](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41561998439) passed. The quality integrations since then advanced protected main through PRs #72, #71, #52, and #53 to `da180c6abc1490098b3f7def6825fd67a42043cb`; the latest post-merge application CI passed in run [41580747708](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41580747708).

PR #55's one-file formatter fix was confirmed superseded by the tested `format-base` helper on current main, documented in its conversation, and closed without merging. This report refresh records the integrated source snapshot at `da180c6abc1490098b3f7def6825fd67a42043cb`; merging this documentation change will create a newer main SHA without changing application source.

## Manual retest target and scope

No new assessment has been requested or submitted to DataFactor. The 58.7 score remains historical. The owner-provided 61.3 email has no assessment SHA or ID and is not attributed to any commit. No 80+ score is verified.

The current measured source snapshot is `da180c6abc1490098b3f7def6825fd67a42043cb`, with successful post-merge application CI in run [41580747708](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41580747708). PR #67 remains behind this mainline and its mandatory local acceptance has not passed. After PR #67 is reconciled, its local ClamAV and three-run Playwright requirements pass, it receives final independent review, and it is merged with post-merge CI green, use the resulting exact protected-main SHA for the owner's manual DataFactor retest and record the assessment ID, date, score, and provider-reported measurements. If PRs #62–#64 are selected for integration first, include those merges in the final target SHA.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, DataFactor submission, or branch-protection bypass was performed for this report.
