# DataFactor quality assessment reconciliation

This note compares the emailed assessment with the repository at the Marketplace release baseline `22627e4441aecef02ed82941aa047fc0553a08e8`. The assessment is a useful signal, not an authoritative build or runtime report. Findings below distinguish reproduced facts from scanner limitations.

## Reproduced findings

- The repository has an established GitHub Actions CI workflow that runs Prisma generation/deployment on its disposable PostgreSQL service, lint, TypeScript checks, API tests, production builds, and Playwright. Separate container-security automation performs dependency/image checks and SBOM work. The email's claim that the project lacks CI tests or an npm audit gate is not accurate for this baseline.
- Both API and web ESLint flat-config files existed, but only selected the TypeScript parser; they defined no lint rules. ESLint therefore completed without meaningfully checking the source.
- The baseline includes structured JSON diagnostics with request correlation IDs in `apps/api/runtime/structured-logger.cjs`, surfaced through `apps/api/src/diagnostics.ts`. This is not a hosted error-monitoring or alerting service, so operational observability remains limited, but it is inaccurate to say that all structured logging is absent.
- Direct API runtime dependencies are declared in `apps/api/package.json`; the scanner's count of zero is a workspace/package attribution error. The API currently declares 19 runtime packages.
- At the release baseline, six optional/defaulted `config.ts` settings were missing from `.env.example`: `FX_REFERENCE_API_BASE_URL`, `FX_REFERENCE_MAX_AGE_HOURS`, `STORE_PLAN_BILLING_SANDBOX_ENABLED`, `STRIPE_STORE_BILLING_SECRET_KEY`, `STRIPE_STORE_BILLING_WEBHOOK_SECRET`, and `TRUST_PROXY_HOPS`. This branch documents them with safe defaults/placeholders, and a schema-to-example check now finds all 73 runtime schema keys. The required database URL and password pepper were already documented. The email's approximate twenty-variable figure appears to mix runtime configuration with test/staging script variables; it is not a count of missing required runtime variables.
- The assessment's large-file observations are reproducible at the baseline: `apps/api/src/index.ts` is about 1,242 lines, `apps/web/src/LiveShopping.tsx` about 919, and `apps/web/src/Dashboard.tsx` about 817. These are worthwhile refactoring candidates, but splitting them needs behavior-preserving characterization tests and separate focused changes.
- The assessment's short history observation is consistent with the baseline's 39 commits, two authors, and no release tags. This is historical context, not a code defect to fix by manufacturing commits or tags.

## Lint and formatting baseline

The new ESLint presets currently produce no errors. To avoid mass-reformatting legacy application modules in a tooling-only change, Prettier checks all changed/new configuration and documentation files plus newly added source files; existing `apps/api/src` and `apps/web/src` files are incrementally exempt until they are refactored or intentionally formatted.

The first measured warning baseline was 37 API warnings (29 unused-symbol findings and 8 explicit `any` findings) and 102 web warnings (45 React hook dependency findings, 47 explicit `any` findings, and 10 unused-symbol findings). A follow-up removed the verified unused API symbols and web dead code, including an unmounted legacy home component, and fixed its stale query-loading effect. The current lint run measures 8 API warnings and 91 web warnings; the enforced ceilings are set to those exact values. Remaining warnings are still visible and are not presented as resolved. React Hooks rule-of-hooks violations and other recommended-rule errors remain fatal.

The first disposable-environment API coverage run passed 67 test files / 304 tests and measured 12.01% statements, 13.29% branches, 15.76% functions, and 13.25% lines. CI enforces conservative non-regression floors of 11%, 12%, 14%, and 12%, respectively. These are a baseline guard, not a claim of adequate coverage; route, payment, wallet, and provider integrations remain major follow-up targets.

`npm audit --omit=dev` reports zero production dependency vulnerabilities. A full local `npm audit` reports ten moderate findings in the development lint-tool dependency chain (including ESLint/minimatch transitive advisories) and currently offers no compatible automatic fix. Do not apply a blanket major-version override without testing the lint toolchain; keep this visible for a dedicated dependency review.

## Follow-up sequence

1. Reduce the lint warning budgets with focused, tested cleanup; prioritize hook dependencies and unused code, and replace `any` with domain types.
2. Expand API coverage with focused route, payment, wallet, and provider tests while maintaining the measured non-regression floors.
3. Refactor the three oversized modules separately. Extract existing route registration into modules first; split live-shopping UI only with interaction tests covering playback, cart/checkout, reactions, and store chrome.
4. Keep the existing structured request logger. Add hosted error reporting/alerting only after an owner selects a provider and approves data-retention and privacy settings.
5. Review test-only variables separately and document them as test configuration rather than required production settings.
