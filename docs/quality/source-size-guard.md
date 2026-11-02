# Production source-size guard

`npm run source:size:check` enforces a 500 physical-line ceiling for production
TypeScript and JavaScript modules under `apps/api/src` and `apps/web/src`.
Tests and declaration/spec files are excluded. A physical line includes blank
lines and is counted consistently across LF and CRLF checkouts.

The baseline records only modules already above the ceiling on protected
`main` at `ff1445cb1fbf25e72f0c3825b273e7db8090582b`. Those modules may shrink,
but may not grow. New or currently smaller modules use the 500-line ceiling.
When a refactor reduces a module below 500 lines, remove its exception in the
same change. A baseline increase should be exceptional, reviewed, and explained;
it must not be used to make a failing check pass without addressing the growth.

This is a growth guard, not a claim that the existing oversized modules are
well-factored. Split them incrementally with characterization tests.
