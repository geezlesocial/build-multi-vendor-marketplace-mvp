# DataFactor engineering readiness snapshot

**Snapshot date:** 2026-11-04

**Repository:** `geezlesocial/build-multi-vendor-marketplace-mvp`

**Protected `main` source snapshot:** `e8fc7060c49e695ba34a5e80f4483e51f4c933ae`

**Readiness:** **Engineering evidence refreshed for the owner's manual retest; not an official score or a claim of complete product acceptance.** Protected-main application CI passed on `e8fc7060c49e695ba34a5e80f4483e51f4c933ae`, after PRs #75, #76, and #77 were integrated. Issue #46 remains open because its full acceptance checklist has not been verified against the current integrated head. No 80+ DataFactor score is verified.

This is a measured engineering snapshot, not an official DataFactor score or a release-readiness claim. It separates exact-main measurements from explicitly identified historical or pre-merge evidence.

## Assessment source

An earlier owner-provided DataFactor email reported **58.7/100**; this is retained as historical context. Separate owner-provided emails reported **61.3/100** and **60.7/100**. The 60.7 email supplied for this refresh contains no assessment ID or assessed commit SHA; the previously supplied 61.3 email likewise had no assessment ID or SHA. These are unbound owner-provided results, not measurements attributed to `e8fc706` or any other commit. DataFactor describes estimates as approximate and non-binding; the scores are not independently verifiable here and are not reconciled or recalculated in this report.

The earlier 61.3 email included provider-reported category values, but those values have no assessed SHA or ID and are not used as measurements of the current tree. No category breakdown for the 60.7 email is asserted here.

The earlier provider email's file-size observations refer to a different, unidentified code snapshot and use an unspecified LOC method. They are not attributed to current `main`; the reproducible current-main inventory is measured below.

## Protected-main measurements

The post-merge application workflow [41693158778](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778) succeeded on protected `main` at the exact snapshot `e8fc7060c49e695ba34a5e80f4483e51f4c933ae`. It ran disposable-database migration/seed, lint, formatting and source-size guards, environment-example validation, typecheck, API tests and coverage, build, and the CMS/browser Playwright suite.

Measurements from that exact run:

- API tests: 455 passed across 86 files (the coverage run repeated the same suite; these are not added as separate tests).
- Statement coverage: 19.93%; branch coverage: 19.55%; function coverage: 24.42%; line coverage: 22.48%.
- Enforced coverage floors (statements / branches / functions / lines): 15% / 15% / 19% / 17%.
- Playwright browser tests: 105 passed, 1 skipped, 0 failed; the workflow completed successfully.
- Lint: 5 API warnings and 90 web warnings; zero errors.
- Production JavaScript/TypeScript source inventory: 239 files and 44,040 physical lines.
- Current production files above 500 / 1,000 physical lines: 12 / 0.
- The same CI run passed 15 formatting, source-size, and environment-policy script tests (four test files); build and disposable-database migrations/seeding also passed.
- CI-retained evidence: [API coverage artifact 13257819427](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778/artifacts/13257819427) and [Playwright report artifact 13260696289](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778/artifacts/13260696289).

The source-size guard passed in exact-main CI. The reproducible inventory uses the guard's scope under `apps/api/src` and `apps/web/src`, includes tracked production `.js/.cjs/.mjs/.jsx/.ts/.tsx` files, and excludes `__tests__`, `.test.*`, and `.spec.*` files. It counts physical lines: 239 files, 44,040 lines total, 12 files above 500 lines, and none above 1,000. The 12 files above 500 lines are `apps/api/src/index.ts` (916), `apps/web/src/Storefront.tsx` (907), `apps/api/src/store-growth-routes.ts` (840), `apps/api/src/wallet-funding.ts` (839), `apps/web/src/StoreThemeStudio.tsx` (705), `apps/api/src/wallet-routes.ts` (677), `apps/api/src/marketplace-ad-routes.ts` (653), `apps/api/src/platform-routes.ts` (580), `apps/api/src/store-theme-routes.ts` (562), `apps/api/src/store-theme-domain.ts` (556), `apps/api/src/payment-webhook-reconciliation.ts` (523), and `apps/web/src/LiveShoppableProductDialog.tsx` (510). The guard reported 12 existing oversized modules capped at the `ff1445c` baseline; it prevents further growth beyond those reviewed limits but does not itself split modules.

After PRs #75–#77, `apps/web/src/StoreThemesAdmin.tsx` measures 218 physical lines, `apps/web/src/StoreThemeStudio.tsx` 705, and `apps/api/src/index.ts` 916. None exceeds 1,000 physical lines; these counts use the same newline-normalized physical-line method as the inventory.

An explicit full-lockfile `npm audit --json` was run in a clean worktree at exact `e8fc7060c49e695ba34a5e80f4483e51f4c933ae`: exit 0, 586 dependencies in audit metadata, and zero total vulnerabilities (info/low/moderate/high/critical all zero). Exact-main CI's `npm ci` also reported zero vulnerabilities.

PR #77's container-integration and image-security/SBOM workflow [41687206167](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41687206167) passed before merge on candidate `16a1675dd296ce2f78ff136f855a95918b9e9df5`. Its Git tree hash (`ffe63327dd7d5330b660c6d920c77ed99e1c11aa`) exactly matches protected-main `e8fc706`; thus it validates the identical source tree, but it is pre-merge evidence, not a main-triggered post-merge scan. Disposable PostgreSQL/Mailpit/ClamAV/proxy/browser integration and immutable image build/audit/scan/SBOM jobs passed. The unchanged scanner policy recorded zero HIGH/CRITICAL findings and zero secret findings for source, API, migrator, and web scans. Three CycloneDX SBOMs are retained in [artifact 13255526239](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41687206167/artifacts/13255526239). Exact-main application CI is run [41693158778](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778); a separate container scan was not triggered by the main push.

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
- PR [#75](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/75): cohesive storefront theme-editor extraction; merge `d642510`; post-merge CI [41675859959](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41675859959) passed.
- PR [#76](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/76): theme-admin studio module extraction; merge `3a41385`; post-merge CI [41683844634](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41683844634) passed.
- PR [#77](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/77): public live-route extraction; merge and current protected-main snapshot `e8fc706`; PR-head application and container/security workflows passed before merge, followed by exact-main application CI [41693158778](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778).

The required independent reviews and protected-branch checks were verified for the PR integrations that required them. PR #60's disposable-PostgreSQL concurrency test passed in exact-head CI; PR #58's cart-route HTTP tests passed in exact-head CI; PR #53's exact-head application, container integration, and image security/SBOM checks passed before its protected merge. No live payment provider was used.

PR #67's dedicated local real-ClamAV admin workflow and three consecutive local Playwright runs were completed on candidate `ed02a9c361b34298f971359312c1ea962a530559`, then merged as `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`. Those runs each recorded 104 passed, 1 skipped, 0 failed/flaky and exit 0 using separate disposable PostgreSQL 17 databases; reports and resource/audit records are retained at `D:\Marketplace-Development\pr67-acceptance-evidence-ed02a9c\`. This is historical evidence for the PR #67 candidate/merge tree. PRs #75–#77 subsequently changed and extracted web/API modules, so that older local acceptance does not by itself verify Issue #46's complete checklist on current `main`.

## Remaining findings and acceptance gates

- API coverage on current protected `main` is 19.93% statements, 19.55% branches, 24.42% functions, and 22.48% lines. Continue risk-weighted test additions without excluding production source or padding test counts.
- Current reproducible inventory is 239 production source files / 44,040 physical lines, 12 above 500 and none above 1,000. Older provider-reported file counts and LOC use unknown scope/method, so the figures are not directly comparable. PR #69's guard passed and caps the remaining above-limit modules at its reviewed `ff1445c` baseline; this is a growth guard, not a refactor.
- API and web lint report 5 and 90 warnings respectively, with zero errors in exact-main CI. The warning ceilings are enforced; these warnings remain measured cleanup debt.
- PR #71 reduced the measured web bundle from 1,524.50 kB raw / 411.82 kB gzip to 1,002.43 kB raw / 275.80 kB gzip on its exact-head build. Vite's large-chunk and mixed-import warnings remain visible and unsuppressed.
- Exact-main CI logs a GitHub Actions Node.js 20 runtime deprecation notice (actions were forced to Node.js 24), plus Node `punycode` and legacy `url.parse()` deprecation warnings. These are visible follow-up maintenance items, not failed checks.
- Exact-main full `npm audit --json` and the main CI install report zero vulnerabilities. The source-identical PR #77 Trivy scan reports zero HIGH/CRITICAL and zero secret findings. These scans do not prove complete historical secret absence, hosted alert routing, on-call configuration, or continuous monitoring.
- The environment-example guard checks the API Zod configuration schema and Prisma CLI settings; it does not inventory every direct `process.env.NAME` reference in tests and local tooling. A static scan found CI-provided variables, OS variables, disposable test-database names, and staging smoke-test variables. The cited `STORE_EMAIL_SMTP_HOST` and `STORE_EMAIL_FROM` are already present as commented optional values; `STAGING_TEST_MAILPIT_HOST` and `STAGING_TEST_MAILPIT_API` are absent but the local smoke script defaults to loopback and CI supplies explicit values. Classify and document remaining local-only variables without adding credentials or persistent database URLs to `.env.example`.
- The assessment labels logging framework and error tracking as absent. The current tree includes operational diagnostics and a structured/redacted runtime logger; external error reporting, alert delivery, and on-call configuration remain unverified. Do not add a second logger package without first identifying a concrete gap.
- PR #67 remains merged. GitHub reports Issue [#46](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/issues/46) open; its full acceptance checklist is not verified by this report. PR [#34](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/pull/34) remains draft under the Azure no-go hold. No deployment or production operation was authorized.
- PR #67's historical local runs started with >3 GiB free and the lowest sampled runtime reading was 1.36 GiB, above the 500 MiB floor. This is not a current memory reading and is not new acceptance on the post-#75–#77 tree.

## Report history and current status

PR #68's initial evidence-based report was merged as `ff1445cb1fbf25e72f0c3825b273e7db8090582b`. PR #70 refreshed its caveats and was merged as `a7decff4d1b3cd6037129cab637780a08392a082`. Later quality work included PRs #72, #71, #52, #53, and #67. PR #75 merged as `d642510`, #76 as `3a41385`, and #77 as `e8fc706`; exact-main application CI [41693158778](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778) passed on the current snapshot.

PR #55's one-file formatter fix was confirmed superseded by the tested `format-base` helper on main, documented in its conversation, and closed without merging. PR #67's pre-merge acceptance reports are tied to candidate `ed02a9c361b34298f971359312c1ea962a530559` and its then-merged main tree at `28f8390fd824ad7cec6fbf8515f3b6ff6b3cd45b`; subsequent PRs #75–#77 changed the source tree. All current measurements in this report are tied to `e8fc7060c49e695ba34a5e80f4483e51f4c933ae` unless explicitly labeled as earlier PR evidence.

## Manual retest target and scope

No assessment has been requested or submitted to DataFactor. The 58.7 result remains historical. Owner-provided 61.3 and 60.7 emails have no verified assessment ID or assessed SHA and are not attributed to any commit, including `e8fc706`. No 80+ score is verified.

The exact measured application source snapshot is protected `main` `e8fc7060c49e695ba34a5e80f4483e51f4c933ae`, with successful post-merge application CI in [run 41693158778](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41693158778). The owner should perform any manual retest against the final protected-main SHA in force at submission and record the assessment ID, date, score, and provider-reported measurements. No score improvement is predicted or claimed here; no assessment has been requested or submitted.

No Azure or production deployment, persistent database migration, real financial operation, live provider activation, Scrolith change, credential change, DNS change, destructive local cleanup, DataFactor submission, or branch-protection bypass was performed for this report.
