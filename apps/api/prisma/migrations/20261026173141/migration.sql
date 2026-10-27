-- AlterTable
DO $$
BEGIN
    IF to_regclass('"LiveKitConfiguration"') IS NOT NULL THEN
        ALTER TABLE "LiveKitConfiguration" ALTER COLUMN "id" SET DEFAULT 'default';
    END IF;
END $$;
