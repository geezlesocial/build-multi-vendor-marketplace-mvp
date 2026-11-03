# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-03

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main` source snapshot:** `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`

**Readiness:** **Engineering evidence refreshed for the owner's manual retest; not an official score or a claim of complete product acceptance.** PR #67 is merged, its local ClamAV and three-run browser acceptance passed, and post-merge application CI passed on `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`. Issue #46 remains open because its broader six-theme acceptance checklist has not been fully re-verified here. No 80+ DataFactor score is verified.

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

The post-merge application workflow [41630158612](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41630158612) succeeded on protected `main` at `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b` (PR #67's squash merge). It ran disposable database migration/seed, lint, formatting and source-size guards, environment-example validation, typecheck, API tests and coverage, build, and the CMS/browser Playwright suite.

Measurements from that exact run:

- API tests: 449 passed across 85 files.
- Statement coverage: 19.58%; branch coverage: 19.40%; function coverage: 24.02%; line coverage: 22.05%.
- Enforced coverage floors (statements / branches / functions / lines): 15% / 15% / 19% / 17%.
- Playwright browser tests: 104 passed, 1 skipped.
- Lint: 5 API warnings and 90 web warnings; zero errors.
- Production JavaScript/TypeScript source inventory: 229 files and 43,607 physical lines.
- Current production files above 500 / 1,000 physical lines: 13 / 2.

The source-size guard passed on this run. The reproducible inventory uses the guard's scope under `apps/api/src` and `apps/web/src`, includes tracked production `.js/.jsx/.ts/.tsx` files, and excludes `__tests__`, `.test.*`, and `.spec.*` files. It counts physical lines: 229 files, 43,607 lines total, 13 files above 500 lines, and 2 above 1,000. The two above 1,000 are `apps/web/src/StoreThemesAdmin.tsx` (1,057) and `apps/web/src/StoreThemeStudio.tsx` (1,120). The remaining >500-line modules are `apps/api/src/index.ts` (962), `apps/web/src/Storefront.tsx` (907), `apps/api/src/store-growth-routes.ts` (840), `apps/api/src/wallet-funding.ts` (839), `apps/api/src/wallet-routes.ts` (677), `apps/api/src/marketplace-ad-routes.ts` (653), `apps/api/src/platform-routes.ts` (580), `apps/api/src/store-theme-routes.ts` (562), `apps/api/src/store-theme-domain.ts` (556), `apps/api/src/payment-webhook-reconciliation.ts` (523), and `apps/web/src/LiveShoppableProductDialog.tsx` (510). PR #69 caps these pre-existing modules at their reviewed `ff1445c` baselines; the guard prevents further growth beyond those limits but does not split the modules.

An explicit full-lockfile `npm audit --json` was run against the exact `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b` checkout: exit 0, zero total findings (info/low/moderate/high/critical all zero). The image-security workflow also reported a production-only npm audit of zero findings on an identical source tree.

Container integration and security/SBOM were run before merge in [run 41622210176](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41622210176) on PR #67's exact candidate. The candidate tree hash and protected-main tree hash are identical (`231d8f7d77d1faacc6dbc0e6889bdd691ad3fa20`), so this is evidence for the same application source tree, though not a separate post-merge scan. Both container jobs passed: disposable PostgreSQL/Mailpit/ClamAV/proxy/browser integration, and immutable image build/audit/scan/SBOM. The unchanged policy reported zero HIGH/CRITICAL vulnerabilities and zero secret findings for source, API, migrator, and web scans. CycloneDX SBOMs are retained as [artifact 13223789384](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41622210176/artifacts/13223789384). The post-merge application run above is the latest main-triggered CI result.

## Integrated changes and CI evidence

These changes are on protected `main`; branch-level measurements are not added together. The post-merge application runs listed below were verified successful. PR #47's change is represented in later protected-main runs.

- PR [#59](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/59): dependency remediation; merge `310818e`; post-merge CI [41453249187](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41453249187) passed.
- PR [#47](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/47): API and web lint improvements; merge `416fb93`; included in later protected-main runs.
- PR [#49](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/49): environment-example validation; merge `88eb857`; post-merge CI [41462426162](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41462426162) passed.
- PR [#51](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/51): measured API coverage floors; merge `db96d6f`; post-merge CI [41466536734](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41466536734) passed.
- PR [#60](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/60): financial regression and PostgreSQL concurrency tests; merge `ad0a455`; post-merge CI [41470901167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41470901167) passed.
- PR [#57](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/57): product-route extraction; merge `63df74c`; post-merge CI [41475383775](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41475383775) passed.
- PR [#66](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/66): theme-preview operations documentation; merge `d2d8176`; post-merge CI [41479982542](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41479982542) passed.
- PR [#68](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/68): evidence-based DataFactor readiness report; merge `ff1445c`; post-merge CI [41486224057](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41486224057) passed.
- PR [#69](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/69): production source-size growth guard; merge `fc56917`; post-merge CI [41550001781](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41550001781) passed.
- PR [#54](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/54): Live Shopping workflow extraction; merge `8e52431`; post-merge CI [41552524801](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41552524801) passed.
- PR [#56](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/56): buyer/seller dashboard workspace extraction; merge `6d6c11d`; post-merge CI [41556075917](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41556075917) passed.
- PR [#58](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/58): cart-route extraction and 7 HTTP characterization tests; merge `8ce2716`; post-merge CI [41558991602](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41558991602) passed.
- PR [#70](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/70): evidence-based report refresh; merge `a7decff`; post-merge CI [41561998439](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41561998439) passed.
- PR [#72](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/72): web-runtime Expat remediation; merge `822949d`; post-merge CI [41572998227](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41572998227) passed.
- PR [#71](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/71): lazy-loaded marketplace route pages; merge `99ae37e`; post-merge CI [41575884496](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41575884496) passed.
- PR [#52](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/52): product-media route coverage; merge `4059c7d`; post-merge CI [41578296907](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41578296907) passed.
- PR [#53](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/53): rejected-checkout cart preservation and E2E formatting policy; merge `da180c6`; post-merge CI [41580747708](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41580747708) passed.
- PR [#67](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/67): E2E stabilization and ClamAV theme-preview acceptance; exact candidate `ed02a9c361b34298f971359312c1ea962a530559`, squash merge / protected-main SHA `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`; post-merge CI [41630158612](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41630158612) passed.

The required independent reviews and protected-branch checks were verified for the PR integrations that required them. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; PR #58's cart-route HTTP tests passed in exact-head CI; PR #53's exact-head application, container integration, and image security/SBOM checks passed before its protected merge. No live payment provider was used.

PR #67's dedicated local real-ClamAV admin workflow passed 1/1 (upload, quarantine, actual CLEAN scan, approval, publish, seller refresh preserving edits/logo, restore/audit). Three consecutive full local Playwright runs on its exact candidate each completed with 104 passed, 1 skipped, 0 failed/flaky and exit 0, using separate disposable PostgreSQL 17 databases. The candidate and merged-main source trees match. Full local reports and resource/audit records are retained on the acceptance host at `D:\Marketplace-Development\pr67-acceptance-evidence-ed02a9c\`.

## Remaining findings and acceptance gates

- API coverage has improved to 19.58% statements, 19.40% branches, 24.02% functions, and 22.05% lines. Continue risk-weighted test additions without excluding production source or padding test counts.
- The latest owner-provided assessment screenshot lists 22 files above 500 LOC and 5 above 1,000 without defining its scope or LOC method. The reproducible repository inventory now finds 229 production source files / 43,607 physical lines, 13 above 500 and 2 above 1,000. The inventories are not directly comparable. PR #69's guard passed and caps the existing oversized modules at their `ff1445c` baselines; this is a growth guard, not a refactor.
- API and web lint report 5 and 90 warnings respectively, with zero errors in exact-main CI. The warning ceilings are enforced; these warnings remain measured cleanup debt.
- PR #71 reduced the measured web bundle from 1,524.50 kB raw / 411.82 kB gzip to 1,002.43 kB raw / 275.80 kB gzip on its exact-head build. Vite's large-chunk and mixed-import warnings remain visible and unsuppressed.
- Current CI still reports a Node.js 20 action-runtime deprecation notice. Dependabot PRs [#62](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/62), [#63](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/63), and [#64](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/64) propose major GitHub Actions upgrades and remain open; they are not included in this snapshot and need their own exact-head checks and review before integration.
- Exact-main full `npm audit --json` and the source-identical production-only CI audit both report zero vulnerabilities. Trivy's source/API/migrator/web policy likewise reported zero HIGH/CRITICAL and zero secret findings. These scans do not prove complete historical secret absence, hosted alert routing, on-call configuration, or continuous monitoring.
- The environment-example guard checks the API Zod configuration schema and Prisma CLI settings; it does not inventory every direct `process.env.NAME` reference in tests and local tooling. A static scan found CI-provided variables, OS variables, disposable test-database names, and staging smoke-test variables. The cited `STORE_EMAIL_SMTP_HOST` and `STORE_EMAIL_FROM` are already present as commented optional values; `STAGING_TEST_MAILPIT_HOST` and `STAGING_TEST_MAILPIT_API` are absent but the local smoke script defaults to loopback and CI supplies explicit values. Classify and document remaining local-only variables without adding credentials or persistent database URLs to `.env.example`.
- The assessment labels logging framework and error tracking as absent. The current tree includes operational diagnostics and a structured/redacted runtime logger; external error reporting, alert delivery, and on-call configuration remain unverified. Do not add a second logger package without first identifying a concrete gap.
- PR #67 is merged at `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`; its local acceptance requirements are complete. Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) remains open because this report does not verify every acceptance item in the broader six-theme issue.
- Repository open-PR search found 15 open PRs at this snapshot: [#34](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/34) is draft under its Azure no-go hold; Dependabot [#62–#64](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pulls) cover GitHub Actions upgrades; older dependency updates are #14–#30 (specifically #14, #15, #16, #17, #18, #21, #23, #24, #25, #29, and #30). These PRs were not approved or merged as part of this evidence refresh; check/review status was not audited. No deployment or production operation was authorized.
- The local PR #67 browser runs started with >3 GiB free and the lowest sampled runtime reading was 1.36 GiB, above the 500 MiB floor. Those acceptance runs are completed evidence, not a current memory reading.

## Report history and current status

PR #68's initial evidence-based report was merged as `ff1445cb1fbf25e72f0c3825b273e7db8090582b`. PR #70 refreshed its caveats and was merged as `a7decff4d1b3cd6037129cab637780a08392a082`. Subsequent quality integrations included PRs #72, #71, #52, and #53; PR #67 then merged as `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`. The latest post-merge application CI is [41630158612](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41630158612), successful on that exact main commit.

PR #55's one-file formatter fix was confirmed superseded by the tested `format-base` helper on main, documented in its conversation, and closed without merging. PR #67's pre-merge acceptance reports are tied to exact candidate `ed02a9c361b34298f971359312c1ea962a530559`; its tree hash is identical to the merged-main tree. This report's measurements are tied to `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`.

## Manual retest target and scope

No new assessment has been requested or submitted to DataFactor. The 58.7 score remains historical. The owner-provided 61.3 email has no assessment SHA or ID and is not attributed to any commit. No 80+ score is verified.

The exact measured application source snapshot is protected `main` `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`, with successful post-merge application CI in [run 41630158612](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41630158612). PR #67 is merged and its acceptance evidence is complete. No additional code change was made solely to pursue a predicted score; measured follow-up debt is documented above. No assessment has been requested or submitted. The owner should conduct the manual retest against the final protected-main SHA in force when they submit and record the resulting assessment ID, date, score, and provider-reported measurements. If any PRs are merged before that retest, use the resulting exact main SHA.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, DataFactor submission, or branch-protection bypass was performed for this report.
