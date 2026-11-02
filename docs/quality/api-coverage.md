# API test coverage gate

The API coverage command is `npm run test:coverage -w apps/api`. CI runs it after
the complete unit-test suite and uploads `apps/api/coverage/coverage-summary.json`.
Vitest enforces global statement, branch, function, and line floors; a regression
below any floor fails the job.

## Measured baselines and floors

The initial floor candidate was measured against
`b5de1a8fa3910fd9029cbcdc10f608d7cd5e6b7b` with Node 22.18.0 and the V8 coverage
provider:

| Metric     | Historical baseline | Candidate floor |
| ---------- | ------------------: | --------------: |
| Statements |              15.35% |             15% |
| Branches   |              15.78% |             15% |
| Functions  |              19.25% |             19% |
| Lines      |              17.06% |             17% |

The protected-main snapshot was measured on
`416fb937fbe1f025c5a6f359e2e29cec2df62279` by [application CI run
41454763749](https://github.com/geezlesocial/build-multi-vendor-marketplace-mvp/actions/runs/41454763749)
using Node 22.23.4 and the V8 coverage provider. CI passed 79 files / 405 API
tests and measured 16.77% statements, 17.02% branches, 21.02% functions, and
18.80% lines. These are the current-main measurements at the time of the run;
the later PR #60 database integration test is not part of this baseline.

| Metric     | Current-main measured value | Enforced candidate floor |
| ---------- | --------------------------: | -----------------------: |
| Statements |                      16.77% |                      15% |
| Branches   |                      17.02% |                      15% |
| Functions  |                      21.02% |                      19% |
| Lines      |                      18.80% |                      17% |

The 15/15/19/17 floors raise the previous protected-main gate of 11/12/14/12
while retaining at least 1.7 percentage points of margin under the current
measurements. They are regression guards, not a claim that coverage is
sufficient: route-heavy and financial paths still have large untested regions.
Raise floors further only after focused tests increase the measured baseline;
do not lower them to accommodate a regression without documenting and reviewing
the reason.

Coverage includes production TypeScript under `apps/api/src/**/*.ts`, excluding
test files. It does not include browser E2E instrumentation, so E2E coverage
should not be inferred from these figures.
