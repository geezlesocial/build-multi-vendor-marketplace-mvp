# Wallet and Club Coins

This increment adds the storage and authorization boundary for a user wallet and a separate Club Coins loyalty ledger. It is additive and does not replace the existing Stripe, PayPal, COD, POS, seller payout, or seller settlement systems.

## Safety defaults

- `MONEY_MOVEMENT_HARD_DISABLED=true` by default. This server-side gate overrides admin switches.
- Wallet funding, wallet checkout, transfers, and withdrawals are disabled by default.
- Funding also requires `WALLET_FUNDING_PROVIDER_READY=true`, an approved provider, signed webhook verification, replay protection, and reconciliation evidence. The implemented Stripe adapter is restricted to an explicit disposable test configuration; the default remains disabled.
- `walletEmergencyPause` defaults to `true` in the database.
- Club Coins are non-cash, non-withdrawable, and non-transferable by default. Conversion is never implied by a balance or redemption ratio.
- `CLUB_COINS_HARD_DISABLED=true` is the default environment-wide launch hold. Set it to `false` only after the separate Club Coins policy, compliance, and launch review is approved.
- `CLUB_COINS_HARD_DISABLED` accepts only explicit `true` or `false` strings (case-insensitive; surrounding whitespace is ignored). Missing configuration defaults to `true`; any other value, including a typo, prevents startup.

## Ledger boundaries

`WalletAccount`, `WalletBalance`, `WalletLedgerTransaction`, and `WalletLedgerPosting` form the monetary wallet boundary. Wallet balances are derived snapshots updated in the same transaction as immutable, idempotent double-entry postings. Ledger transactions and postings are append-only at the database trigger boundary; corrections require compensating entries. The database checks positive integer minor units, uppercase three-character currency codes, account ownership shape, and deferred debit/credit balance.

`SellerPayoutLedgerEntry` and `SellerPayout` remain separate. A seller payout balance must not be inferred from a user wallet balance, and the existing checkout payment records remain the source for external order payments.

`ClubCoinAccount` and `ClubCoinEntry` are a separate integer loyalty ledger. Coin entries carry an idempotency key, reference, policy version, expiry, and reversal reference. They do not represent bank deposits or guaranteed cash value.

## API behavior

User routes:

- `GET /api/wallet`
- `GET /api/wallet/transactions`
- `POST /api/wallet/funding-intents` — fail-closed until provider readiness and policy gates pass
- `POST /api/wallet/transfers` — implemented atomically but disabled by default
- `POST /api/wallet/withdrawals` — fail-closed until an approved settlement workflow exists
- `POST /api/wallet/checkout-authorize` — fail-closed until order-lifecycle integration is approved
- `GET /api/club-coins`
- `POST /api/webhooks/stripe/wallet-funding` — accepts only verified Stripe test-mode events in the explicit sandbox configuration

Admin routes expose summaries, wallet account status controls, policy switches, reward rules, searchable/paginated Club Coins member accounts, paginated read-only coin ledgers, audited manual coin adjustments, and a read-only wallet reconciliation report. Manual Club Coin adjustments require an operator-supplied idempotency key, reason, and reference; a same-payload retry replays the original entry, while key reuse with different data is rejected. State-changing wallet and Club Coins admin operations write their audit record in the same database transaction as the change, so an audit failure rolls back the change. Admin switches cannot override the server hard-disable or emergency pause.

Connected reward events are account email verification, paid and receipt-confirmed purchases, admin-approved reviews from verified purchasers, and provider-backed live attendance after five eligible minutes. Awards and event-level reversals are idempotent and audited. Refunds/disputes reverse purchase rewards and verified-review rewards tied to the refunded order; removing or rejecting an approved review reverses its review award. Live attendance accrues only from bounded heartbeat intervals while the session is provider-backed and in LIVE state. Custom triggers, group targeting, and reward expiry remain unavailable and fail closed. Club Coins remain hard-disabled by the server default until the owner completes launch review; admin controls cannot override that environment safeguard. Live rewards also remain unavailable until a real streaming provider is configured, healthy, and enabled.

### Sandbox provider top-ups

The Stripe top-up flow requires `NODE_ENV=test`, `WALLET_FUNDING_SANDBOX_MODE=true`, `WALLET_FUNDING_PROVIDER_READY=true`, `MONEY_MOVEMENT_HARD_DISABLED=false` for the disposable process only, a Stripe `sk_test_` key and webhook signing secret, and an explicitly configured `WALLET_FUNDING_TREASURY_ACCOUNT_ID` with an approved disposable opening baseline. Production and ordinary development processes cannot activate it. The repository default keeps `MONEY_MOVEMENT_HARD_DISABLED=true`.

For local regression tests, each run must generate a fresh random 32-character lowercase hexadecimal `WALLET_FUNDING_SANDBOX_ID` and create a new database named exactly `wallet_funding_test_<ID>` or `wallet_funding_e2e_<ID>`. The URL must use `localhost`, `127.0.0.1`, or `::1` on a non-default port (not 5432). `WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST`, if used, is an additional restrictive name allowlist only: it cannot authorize a remote host, port 5432, a reserved owner/staging/production name, or an identity that does not match this run. Reserved names are rejected before the allowlist is evaluated.

The runtime guard validates URL syntax, loopback host, non-default port, exact database-name pattern, and equality with the process's per-run identity. It cannot prove that an operator created a fresh PostgreSQL cluster, that an identity was never reused in a prior process, that no other process is connected, that the server is PostgreSQL 17, or that the target is disposable by ownership or policy. Test orchestration must generate the random identity, create a new isolated local instance/database, keep credentials process-local, and remove only resources it created. Never treat the allowlist or URL guard as evidence that a database is safe to delete.

The funding-intent route creates one provider PaymentIntent with funding-intent, owner, idempotency, and purpose metadata and stores only its provider intent reference. A retry by that same owner may retrieve an existing PaymentIntent, but the server returns its client secret only after checking its reference, metadata, owner, amount, currency, recoverable status, and non-live mode. Provider failures or invalid responses leave the funding intent unchanged and return a generic retryable error. It never credits a wallet from the client response. The webhook route verifies Stripe's signature over the exact raw request body, requires a non-live event, matches the funding intent, provider reference, amount, currency, and metadata, and then credits the wallet in the same transaction as the immutable double-entry posting and balance allocation. An additive database trigger enforces that the funding intent's account is a USER wallet owned by its `userId`, prevents reassignment of a referenced account, and webhook processing independently locks and revalidates that owner/type before any financial action. Funding-intent owner and account identity cannot be changed after creation. The insert guard takes `WalletAccount FOR UPDATE` before inserting the intent; this conflicts with the wallet row locks used by updates to its `type` or owner. The reciprocal wallet trigger runs after the wallet row is locked and checks for references without locking intent rows, avoiding an account/intent lock cycle. A PostgreSQL regression test exercises both lock acquisition orders on separate connections. Invalid legacy targets are placed in review with a recorded event reason and audit entry, without crediting the account. Failed and cancelled payment events do not credit funds. Funding events are serialized by a row lock on the intent. Refunds use the provider's cumulative refunded amount: only the newly observed delta is posted, and the cumulative observed, applied, and unresolved-shortfall amounts are stored on the funding intent. A full refund creates compensating `REFUND` entries for the remaining delta; a partial refund applies the delta when recoverable wallet funds exist and remains in `REVIEW` until the provider amount is fully accounted for. If available and held funds cannot cover the delta, the wallet account is frozen, no unbalanced entry is written, and the shortfall remains a durable manual-recovery obligation. A dispute creates an append-only available-to-held hold for the newly disputed delta. A won dispute releases the held amount back to available; a lost dispute removes held funds through a compensating reversal to the treasury. A dispute that cannot be held, a dispute before credit, or a partial loss remains `REVIEW` and cannot silently make funds spendable. Duplicate event IDs and duplicate cumulative amounts do not apply a financial amount twice. A reversal arriving before credit also moves the intent to `REVIEW` and prevents a later success from creating spendable funds. If the required source balance is no longer available, processing fails closed for manual review rather than creating a negative balance.

Processed provider event IDs are unique, and the funding intent is locked while its state transition is evaluated, so duplicate and concurrent distinct deliveries cannot create more than one funding credit. Rejected signed events are recorded as received without changing balances. Raw webhook payloads, card data, client secrets, and payment details are not persisted or logged. Provider-reference persistence remains retryable with the same deterministic provider idempotency key if the local write fails after provider creation. Tests use synthetic Stripe event payloads and a fresh local disposable database; no Stripe sandbox credentials or network calls are part of local validation.

#### Partial refund and dispute review procedure

- `refundObservedMinor` is the provider's cumulative refund amount, while `refundAppliedMinor` is the cumulative amount represented by compensating ledger entries. A new refund event applies only `refundObservedMinor - prior refundObservedMinor`; equal or lower cumulative values are no-ops. `refundShortfallMinor` records any amount that could not be recovered.
- A partial refund uses available funds. A full cumulative refund may also consume an existing dispute hold belonging to the same funding intent; unrelated holds on the wallet account remain untouched. If the required amount is unavailable, the operation is atomic: the wallet account is frozen, the intent remains `REVIEW`, and no partial or unbalanced ledger entry is written.
- A dispute-created event moves the newly disputed delta from `AVAILABLE` to `HELD`. A dispute win moves the held amount back to `AVAILABLE`; a dispute loss moves held funds to the treasury through a compensating reversal. If a loss arrives without a recorded hold, the system recovers available funds or freezes the wallet and records a review shortfall.
- Dispute wins/losses, partial outcomes, and events received before a funding credit are retained in the funding intent status and audit log. Operators must reconcile the provider cumulative amounts, wallet snapshot, allocations, and ledger postings before any manual recovery. Manual recovery must use an approved compensating ledger transaction; direct snapshot or historical-posting edits are prohibited.

`GET /api/admin/wallet/reconciliation` is a read-only report. It compares the full union of snapshot, POSTED economic-posting, and append-only allocation keys by account, currency, and balance state. It never writes balances or ledger rows. Missing, single-source, mismatched, or unverified-opening evidence is reported as `INCONCLUSIVE` or `DISCREPANCY`; no automatic repair is attempted.

## Database-role separation

The migration role and runtime role must be separate. The migration role owns the schema or has explicitly approved DDL rights for deployment. The runtime role may connect, use the application schema, and perform only the application DML required by approved routes; it must not own the immutable ledger tables, create or alter schemas/tables/triggers, use `TRIGGER` or `TRUNCATE`, or `UPDATE`/`DELETE` wallet ledger transactions, wallet postings, or Club Coin entries. It must not be a member of the migration role, superuser, replication role, or a role with `BYPASSRLS`. These permissions must be verified in the disposable validation database and then independently confirmed in each deployed environment; this change does not alter any owner database privileges.

### Reconciliation procedure

1. Capture the read-only reconciliation report and its timestamp.
2. For each `DISCREPANCY` row, compare the account/currency snapshot with the POSTED posting totals and inspect transaction reference and audit records.
3. For each `INCONCLUSIVE` row, identify the pending/held/frozen workflow that owns the state; do not infer it from available postings.
4. Preserve the original rows and obtain database-owner and security approval before any compensating ledger entry or balance correction.
5. Re-run the report and retain both reports as evidence. Direct balance or ledger edits are prohibited.

## Not enabled by this increment

Live provider funding, production settlement, wallet checkout capture integration, withdrawal processing, coin earning from verified events, coin redemption during checkout, coin conversion, and user-to-user coin transfers require separate implementation and owner/security approval. No live provider call is made by the new routes.

## Operational requirements

Before enabling any money movement, define provider ownership, supported currencies, limits, cooling-off and review rules, reconciliation jobs, backup/recovery procedures, incident response, and a staging-only sandbox validation plan. Never put provider secrets in source control or client code.

## Reconciliation design and money-movement enablement gate

The reconciliation report is intentionally read-only and fail-closed. `WalletLedgerPosting` remains the economic double-entry record, while `WalletBalanceAllocation` records the state effect needed to reconcile available, pending, held, and frozen projections. A ledger-only account/currency key, allocation-only key, snapshot-only nonzero state, or opening balance not supported by evidence remains `INCONCLUSIVE` rather than being treated as zero.

The implemented forward-only design is an append-only `WalletBalanceAllocation` ledger linked to the economic transaction or posting. Each row records an account, currency, balance state (`AVAILABLE`, `PENDING`, `HELD`, or `FROZEN`), signed delta, source transaction, idempotency key, and timestamp. Existing `WalletLedgerTransaction`, `WalletLedgerPosting`, and snapshot rows are not rewritten. A state transition creates a negative allocation in the source state and a positive allocation in the destination state in one transaction. A deferred database invariant requires transaction-linked allocation totals to equal the signed economic posting effect, rejects negative cumulative state totals, and requires two balanced entries for a state transition. Allocations and snapshot changes are written by the same transaction-scoped service flow.

`WalletBalance` remains a current projection. Reconciliation performs a full outer comparison of snapshot, posting, and allocation keys by account, currency, and state. Available economic postings are signed `DEBIT` positive / `CREDIT` negative; verified opening-baseline allocations are added to the economic total before comparing to the snapshot. Pending, held, and frozen values reconcile through state allocations rather than being inferred from available postings. Existing balances require an approved cutover baseline. If historical state or opening evidence cannot be reconstructed reliably, the legacy portion is recorded as `INCONCLUSIVE` and money movement remains disabled; it must not be backfilled as `AVAILABLE` by assumption.

### State-aware invariants and opening-balance procedure

1. The database migration is additive and does not rewrite historical postings, allocations, or snapshots.
2. Every future economic transaction must append one allocation per posting, in the same transaction, with `DEBIT` represented as a positive balance effect and `CREDIT` as a negative balance effect under the existing wallet convention.
3. Every future state transition must update the snapshot and append a balanced source/destination allocation pair in one transaction. The source state must remain non-negative after the transition.
4. A verified opening baseline is permitted only when a database/release owner records the evidence reference, captures the snapshot and supporting records, and marks the baseline verified. An opening row without reliable evidence remains `INCONCLUSIVE`.
5. Reconciliation compares the complete union, including snapshot-only, posting-only, and allocation-only keys. It reports findings only; it never updates a snapshot or ledger row.
6. An operator investigates discrepancies by preserving the report, checking transaction/reference and audit records, confirming the opening evidence, and obtaining approval for a compensating transaction. Direct balance or historical-ledger edits are prohibited.

An alternative is separate state-specific ledger accounts, such as an available, pending, held, and frozen account for each user/currency. That gives strong double-entry treatment to state transfers, but increases account topology, posting complexity, and operational reconciliation burden. The allocation ledger is the smaller change for this product because it preserves the existing economic postings and makes state transitions explicit without inventing new economic counterparties. Either design must preserve immutable history and require a compensating event rather than edits.

## Runtime database-role verification

Disposable validation checks the intended role shape: the runtime role has only the application DML required for the test, has no `UPDATE`/`DELETE`/`TRUNCATE` privilege on immutable wallet ledger or allocation tables, and has no schema `CREATE` privilege. This is not production evidence and does not prove deployed ownership, inherited grants, trigger privileges, or `BYPASSRLS` state. Before enabling any wallet or Club Coins capability, the database owner must independently verify the deployed runtime role's memberships, ownership, schema privileges, table/column privileges, `TRIGGER`, `TRUNCATE`, `CREATE`, and `BYPASSRLS` status. Snapshot-write authority must also be reviewed because the application currently updates `WalletBalance` and `ClubCoinAccount` projections inside posting transactions.

The role review must be performed without changing the owner database. Until the deployed role and the state-aware reconciliation baseline are independently approved, all hard-disable gates remain enabled.
