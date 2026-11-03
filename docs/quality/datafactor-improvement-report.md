# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-03

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main`:** `8ce27161ec7ad3d1f117dcd9fd07387e817840a2`

**Readiness:** **BLOCKED for the remaining theme acceptance gate.** PRs #59, #47, #49, #51, #60, #57, #66, #68, #69, and #58 are integrated; post-merge application CI passed on current `main`. PR #67's mandatory local ClamAV workflow and three consecutive full browser runs remain incomplete.

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
| Test Coverage             |             72 | Latest email reports 72. Merged tests raised measured API coverage; the absolute coverage remains low. Current floors are 15/15/19/17.                          |
| Dependency Health         |             58 | PR #59's dependency remediation is integrated. Current-tree production audit evidence is recorded below.                                                        |
| CI/CD Maturity            |             82 | Latest email reports 82. Application and container-security/integration workflows passed on the integrated mainline tree.                                       |
| Security Hygiene          |             68 | Latest email reports 68. Scans and integration gates passed on recent trees. Hosted alerting and complete historical secret assurance are not established here. |
| History & Maintenance     |             30 | Latest email reports 30 and cites a short history. History is not manufactured; maintainability improves through reviewed changes and ongoing maintenance.      |

## Protected-main measurements

The post-merge application run [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602) succeeded on protected `main` at `8ce2716`. Its results are the current integrated baseline:

| Metric                                                               |            Measured result |
| -------------------------------------------------------------------- | -------------------------: |
| API tests                                                            | 431 passed across 84 files |
| Statement coverage                                                   |                     19.02% |
| Branch coverage                                                      |                     19.03% |
| Function coverage                                                    |                     23.40% |
| Line coverage                                                        |                     21.42% |
| Enforced coverage floors (statements / branches / functions / lines) |      15% / 15% / 19% / 17% |
| Playwright browser tests                                             |      103 passed, 1 skipped |
| API lint                                                             |       5 warnings, 0 errors |
| Web lint                                                             |      91 warnings, 0 errors |

The post-merge workflow passed; the first post-merge attempt after PR #49 encountered a PostgreSQL host-port collision, and its retry passed without skipping required checks. The current baseline is from the later successful run above.

The PR #58 exact-head container security/integration run [41557645250](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41557645250) passed before merge, including disposable PostgreSQL, actual ClamAV/Mailpit/proxy integration, browser validation, source/image scanning, and SBOM generation. PR #58's post-merge application run [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602) is green on current `main`. Earlier PR #68 container security/integration run [41484072940](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41484072940) passed on its exact report head; PR #68 changed only this report, so its application source tree matched the then-current main. These are production-audit results, not a claim that every dependency audit mode or the full repository history is clean.

## Integrated changes and CI evidence

These changes are on protected `main`; candidate measurements from their old branches are not added together. The final row is the current mainline run.

| PR                                                                                | Integrated change                                       | Merge commit | Post-merge application CI                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [#59](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/59) | Dependency remediation                                  | `310818e`    | [41453249187](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41453249187) passed          |
| [#47](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/47) | API and web lint improvements                           | `416fb93`    | Included in later protected-main runs                                                                                      |
| [#49](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/49) | Environment-example validation                          | `88eb857`    | [41462426162](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41462426162) passed on retry |
| [#51](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/51) | Measured API coverage floors                            | `db96d6f`    | [41466536734](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41466536734) passed          |
| [#60](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/60) | Financial regression and PostgreSQL concurrency tests   | `ad0a455`    | [41470901167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41470901167) passed          |
| [#57](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/57) | Product-route extraction                                | `63df74c`    | [41475383775](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41475383775) passed          |
| [#66](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/66) | Theme-preview operations documentation                  | `d2d8176`    | [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) passed          |
| [#68](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/68) | Evidence-based DataFactor readiness report              | `ff1445c`    | [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) passed          |
| [#69](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/69) | Production source-size growth guard                     | `fc56917`    | [41550001781](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41550001781) passed          |
| [#58](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/58) | Cart-route extraction and 7 HTTP characterization tests | `8ce2716`    | [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602) passed          |

PRs #51, #60, #57, #66, #69, and #58 received independent `webskilldesign` approvals for their exact reviewed heads before merge. Each integration followed the repository's protected-branch process. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; PR #58's cart-route HTTP tests passed in its exact-head CI. No live payment provider was used.

## Remaining findings and acceptance gates

- Coverage has improved, but remains below typical mature-project targets. Continue risk-weighted test additions without excluding production source or padding test counts.
- The latest DataFactor email says 22 files exceed 500 LOC and 5 exceed 1,000, but does not document its file scope or LOC definition. A reproducible current-main audit of 226 production JavaScript/TypeScript files under `apps/api/src` and `apps/web/src`, counting physical lines and excluding test/spec files, finds 13 above 500 and 2 above 1,000. These counts are not directly comparable to DataFactor's. PR [#69](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/69) is merged as `fc569177c8e09fda55165ba7236e7b2f2640e13d`; its 500-line growth guard caps the known pre-existing oversized modules at their protected-main baselines. The exact-head application run [41535385401](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41535385401) and container-security run [41535385426](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41535385426) passed; its post-merge application CI [41550001781](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41550001781) also passed. The current guard reports 13 pre-existing modules capped; no pending review is claimed.
- API and web lint still report 5 and 91 warnings respectively. No lint errors were reported in the current mainline CI.
- The earlier web bundle advisory of approximately 1.53 MB has not been remeasured or resolved in this snapshot.
- Hosted error reporting, alert routing, and on-call operations are not verified as configured. No complete historical secret audit is claimed.
- The existing environment-example guard checks the API Zod configuration schema and Prisma CLI settings; it does not inventory every direct `process.env.NAME` reference in tests and local tooling. A static scan found references absent from `.env.example`, including CI-provided variables, OS variables, disposable test-database names, and staging smoke-test variables. The cited `STORE_EMAIL_SMTP_HOST` and `STORE_EMAIL_FROM` are already present as commented optional values; `STAGING_TEST_MAILPIT_HOST` and `STAGING_TEST_MAILPIT_API` are not in `.env.example` but the local smoke script defaults to loopback and CI supplies explicit values. The remaining work is to classify/document local-only test variables without putting credentials or persistent database URLs in the example file.
- The assessment labels logging framework and error tracking as absent. The current tree does include operational diagnostics and a structured/redacted runtime logger; external error reporting, alert delivery, and on-call configuration remain unverified. Do not add a second logger package without first identifying a concrete gap.
- PR #67 remains a draft. Its real ClamAV admin UI flow—upload, quarantine, scan, approval, publish, seller refresh preserving edits/logo, and restore/audit—has not completed successfully with a full Playwright report. Three consecutive full local Playwright runs are also incomplete (0/3 recorded as complete).
- Keep PR #67 in draft and Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) open until those acceptance requirements pass on the final reviewed head. Begin local full browser acceptance only with at least 3 GiB of physical memory free; preserve the 500 MiB runtime floor. GitHub CI does not substitute for these local requirements.
- PR #67 remains an open draft at exact head `92607b4341d48929c4be00aa9d81b7fa9637e62f`; Issue #46 remains open. Its exact-head CI passed, but local ClamAV admin UI acceptance and three consecutive complete local Playwright runs remain 0/3. The last recorded local sample was 2.12 GiB free, below the 3 GiB start threshold. No local full browser run was started; retain the 500 MiB runtime floor. This report refresh did not rerun local acceptance or claim a fresh memory sample.

## PR #68 and current report status

PR #68 was independently approved and squash-merged as `ff1445cb1fbf25e72f0c3825b273e7db8090582b`; PR #69 was independently approved and merged as `fc569177c8e09fda55165ba7236e7b2f2640e13d`; PR #58 was independently approved and merged as `8ce27161ec7ad3d1f117dcd9fd07387e817840a2`. Their post-merge application CI passed in runs [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057), [41550001781](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41550001781), and [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602), respectively. This PR #70 report refresh remains a separate documentation change and does not claim that PR #67 is merged or its local acceptance gates are complete.

## Scope and recommended DataFactor target

After PR #70 is merged and post-merge CI succeeds, request a new DataFactor assessment against the resulting exact protected `main` SHA and record the assessment ID with the result. At this report refresh, `main` is `8ce27161ec7ad3d1f117dcd9fd07387e817840a2`; it is not the final post-PR-70 target. The historic 58.7 remains historical, the owner-provided 61.3 email has no assessment SHA or ID and is not attributed to any commit, and no 80+ score is verified. Neither a future score nor CI substitutes for PR #67's remaining local acceptance; this report does not claim the Marketplace is fully release-ready.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, or branch-protection bypass was performed for this report.
