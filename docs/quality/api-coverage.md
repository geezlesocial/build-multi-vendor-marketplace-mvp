# API test coverage gate

The API coverage command is `npm run test:coverage -w apps/api`. CI runs it after
the complete unit-test suite and uploads `apps/api/coverage/coverage-summary.json`.
Vitest enforces global statement, branch, function, and line floors; a regression
below any floor fails the job.

## Measured baseline and floors

The local baseline reproduction used `b5de1a8fa3910fd9029cbcdc10f608d7cd5e6b7b`,
the locked dependency set, Node 22.18.0, and the V8 coverage provider:

| Metric     | Baseline | Enforced floor |
| ---------- | -------: | -------------: |
| Statements |   15.35% |            15% |
| Branches   |   15.78% |            15% |
| Functions  |   19.25% |            19% |
| Lines      |   17.06% |            17% |

The successful GitHub Actions coverage artifact for the same main commit reports
15.79% branches (the local rerun reports 15.78%); the other displayed metrics
match to two decimal places. The 15% branch floor is below both measurements.

The floors are deliberately just below the reproducible baseline to allow small
runtime/tooling variance while preventing a material coverage regression. They
are not a claim that coverage is sufficient: route-heavy areas still have large
untested regions. Raise the floors only after focused tests increase the measured
main baseline, and do not lower them to accommodate a regression without
documenting and reviewing the reason.

Coverage includes production TypeScript under `apps/api/src/**/*.ts`, excluding
test files. It does not include browser E2E instrumentation, so E2E coverage
should not be inferred from these figures.
