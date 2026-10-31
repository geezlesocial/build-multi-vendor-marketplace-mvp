import { Prisma, Role } from '@prisma/client';
import { env } from './config.js';
import { hashPassword, prisma } from './security.js';

function readBootstrapInput() {
  if (process.env.STAGING_ADMIN_BOOTSTRAP_ENABLED !== 'true') {
    throw new Error('One-time staging administrator bootstrap is not enabled.');
  }
  if (env.NODE_ENV !== 'production') {
    throw new Error('The staging administrator bootstrap only runs in the production-mode staging container.');
  }
  const database = new URL(env.DATABASE_URL);
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ''));
  if (!database.hostname.startsWith('mpstg-pg-')
    || !database.hostname.endsWith('.postgres.database.azure.com')
    || databaseName !== 'marketplace_staging') {
    throw new Error('The bootstrap target is not the dedicated Marketplace staging database.');
  }

  const email = process.env.STAGING_ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.STAGING_ADMIN_NAME?.trim();
  const password = process.env.STAGING_ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 120 || !password || password.length < 16) {
    throw new Error('Provide a valid staging owner email, name, and password of at least 16 characters.');
  }
  return { email, name, password };
}

async function main() {
  const { email, name, password } = readBootstrapInput();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async tx => {
    const existingAdminCount = await tx.user.count({ where: { role: Role.ADMIN } });
    if (existingAdminCount !== 0) throw new Error('An administrator already exists; bootstrap refused without changes.');
    if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new Error('The requested administrator email already belongs to an account; bootstrap refused without changes.');
    }

    const user = await tx.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: Role.ADMIN,
        emailVerifiedAt: new Date(),
        onboardingCompletedAt: new Date()
      },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'STAGING_INITIAL_ADMIN_BOOTSTRAPPED',
        entity: 'User',
        entityId: user.id,
        metadata: { method: 'one-time-staging-job' }
      }
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  process.stdout.write('Staging administrator bootstrap succeeded.\n');
}

main()
  .catch(() => {
    // Never log user input, connection details, or provider/database error text.
    process.stderr.write('Staging administrator bootstrap failed; inspect restricted platform diagnostics.\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
