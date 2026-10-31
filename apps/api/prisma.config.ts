import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: process.env.PRISMA_MIGRATIONS_PATH ?? 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') }
});
