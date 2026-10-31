# LiveKit migration-order hotfix: compatibility and deployment review

## Root cause and intended schema

Migration `20261026173141` attempted to alter `LiveKitConfiguration` before migration `20261026210000_livekit_admin_configuration` created it. The hotfix guards only for table absence, so missing-table state is skipped without suppressing errors from a real `ALTER TABLE`. The later create migration is unchanged. Migration `20261027140000_livekit_configuration_id_default` enforces the schema's `LiveKitConfiguration.id String @id @default("default")` after table creation. Its SQL changes no other column, constraint, or index.

## Checksums

The detailed historical-ledger behavior below was documented with the repository's Prisma 6 workflow. This staging preparation upgrades Prisma to 7.10.1. A fresh PostgreSQL 17 database successfully applied the full current migration chain and seed with Prisma 7.10.1, but the historical applied-checksum scenarios below were not rerun with the upgraded migration engine in this preparation. Keep the migration-order and checksum warnings as release gates; verify actual ledger/checksum state and the deployed Prisma CLI behavior on a disposable clone before any persistent migration.

Checksums below are SHA-256 of the exact migration file bytes (Prisma's `_prisma_migrations.checksum` format):

| Migration | Historical / currently deployed candidate | Current working tree |
| --- | --- | --- |
| `20261026173141/migration.sql` | `059a2627b30ee949fca755e84606b47ab3193e7a70ba327c5105438392cf2f84` | `fe9e3b6e70d5831a153a5c6a4bd34e8e7313f93a984eb188868b87d4e5db2df4` |
| `20261026210000_livekit_admin_configuration/migration.sql` | `ca3890aaad173b22f1b8d91f475fba6feaed1a27d81d856a42c8df81a9dc6c25` | unchanged |
| `20261027140000_livekit_configuration_id_default/migration.sql` | not previously present | `6fffb69349707e3455dc7f6b65f0fdcd92b7576cb0b9d9be497a459b1fe530ef` |

The original local database was inspected read-only: it records the historical checksum for `20261026173141` and the unchanged checksum for the table-creation migration, both finished, and its `id` default is already `'default'`. Their recorded timestamps are not in folder-name order. The project owner reports that this project has only been used with a local database and has no shared or deployed database. This is an owner confirmation, not an independent infrastructure audit. Do not reset or use this persistent local database as a clean migration test; its ledger retains the historical checksum while the working-tree migration has changed.

With this repository's Prisma 6 workflow, `prisma migrate deploy` warns when an applied migration's file has changed, then applies pending migrations; it does not reconcile or repair the recorded checksum. `prisma migrate dev` treats modified applied history as a conflict and can prompt for a database reset. A successful disposable `deploy` is therefore not approval to run the changed history against a persistent database.

## Expected behavior by database state

1. **Brand-new database:** the guarded earlier migration sees no table and does nothing; the existing create migration creates the table and index; the added migration sets `id DEFAULT 'default'`. This complete chain was applied and checked on a new disposable PostgreSQL database.
2. **Database with both historical migrations applied:** the historical ALTER is not executed again by `prisma migrate deploy`; the new default migration is pending and sets the default. This exact sequence succeeded on a disposable database with the historical records and old checksum. The changed file still differs from the checksum stored by databases that applied the old version. Do not use `prisma migrate dev` on a valuable database or suppress/alter its ledger to silence history differences. Review with the database owner and back up before deployment.
3. **Database with a failed earlier migration row:** Prisma blocks later migrations while that failed row is unresolved (P3018/P3009, depending on command/state). Inspect the failed SQL/log, schema, and ledger first. Only if the failed attempt is proven to have made no lasting changes should the operator resolve it as rolled back and rerun with the repaired file. Do not mark it applied. The reported failure was an `ALTER TABLE` against an absent relation, but that report alone is not proof of the state of every environment.
4. **Table exists but has no expected default:** if the historical create migration is recorded and the new repair migration is pending, it applies `SET DEFAULT 'default'`. If the new migration is already recorded but the default is absent, this migration will not rerun; diagnose the drift and add a separately reviewed corrective migration. If the table exists but the create migration is not recorded, do not assume it is equivalent or mark it applied: the create migration may fail on the existing relation, and the operator must reconcile actual columns, constraints, index, ownership, and migration ledger first.

## Recommendation / release gate

Keep the fresh-database repair in this hotfix: restoring the historical SQL would reintroduce a deterministic clean-database failure. Based on the owner's local-only confirmation, there is no known shared/deployed migration ledger to reconcile. The existing local database is nevertheless persistent and has applied the original file, so preserve it and do not use `prisma migrate dev` on it: Prisma can report a history conflict and prompt for a reset. The disposable tests cover both the fresh path and a database carrying the historical applied record and old checksum; they do not make rewriting applied history generally safe. If another developer or any hosted environment has used this repository, audit that database's migration ledger before deploying.
