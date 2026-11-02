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

The current protected-main snapshot is
`4dbefcd92b637999b16412fb8b1ac3e9530cdead`. Its reported API baseline is 405
tests with 16.74% statements, 16.96% branches, 21.00% functions, and 18.78%
lines. A local V8 run on reconciled candidate commit
`732c8c3b5e6c690e8f3862a8366b78c73885896f` passed 79 files / 405 tests and
measured 16.74%, 16.95%, 21.00%, and 18.78%, respectively. The 0.01-point branch
difference is a local-versus-CI measurement variance; both are above the 15%
floor.

| Metric     | Current-main measured value | Enforced candidate floor |
| ---------- | --------------------------: | -----------------------: |
| Statements |                      16.74% |                      15% |
| Branches   |               16.95–16.96%* |                      15% |
| Functions  |                      21.00% |                      19% |
| Lines      |                      18.78% |                      17% |

*Local V8 run: 16.95%; supplied/CI baseline: 16.96%.

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
