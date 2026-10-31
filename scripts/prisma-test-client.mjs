import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function createTestPrismaClient(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error('A guarded disposable test database URL is required.');
  }

  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!loopbackHosts.has(url.hostname) || !/(?:e2e|test)/i.test(databaseName)) {
    throw new Error('Prisma test clients may connect only to loopback disposable test databases.');
  }

  const schema = url.searchParams.get('schema') ?? 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('Test database schema must be a safe PostgreSQL identifier.');
  }
  url.searchParams.delete('schema');

  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url.toString(),
      options: `-c search_path=${schema}`
    })
  });
}
