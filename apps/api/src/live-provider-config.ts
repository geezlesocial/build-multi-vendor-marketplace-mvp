import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { configureLiveProvider, credentialsFromEnvironment, liveProvider, type LiveKitCredentials } from './live-provider.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const CONFIGURATION_ID = 'default';

const inputSchema = z.object({
  serverUrl: z.string().trim().url().refine(value => /^(https?|wss?):\/\//i.test(value), 'Use an HTTPS or WSS LiveKit server URL.'),
  apiKey: z.string().trim().max(200).optional().default(''),
  apiSecret: z.string().max(500).optional().default(''),
  deploymentGateEnabled: z.boolean(),
  reason: z.string().trim().min(3).max(500)
}).strict();

function encryptionKey() {
  return crypto.createHash('sha256').update(`${env.PASSWORD_PEPPER}:livekit-admin-config`).digest();
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decrypt(value: string | null | undefined) {
  if (!value) return null;
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Stored LiveKit credential format is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

function mask(value: string | null) {
  if (!value) return null;
  if (value.length <= 6) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

type StoredConfiguration = { serverUrl: string; apiKey: string | null; apiSecret: string | null; deploymentGateEnabled: boolean; source: 'ADMIN_DASHBOARD' | 'DEPLOYMENT_ENVIRONMENT' | 'NOT_CONFIGURED'; configurationError?: string };

async function readConfiguration(): Promise<StoredConfiguration | null> {
  const record = await prisma.liveKitConfiguration.findUnique({ where: { id: CONFIGURATION_ID } });
  if (!record) {
    const fallback = credentialsFromEnvironment();
    return fallback ? { serverUrl: fallback.url, apiKey: fallback.apiKey, apiSecret: fallback.apiSecret, deploymentGateEnabled: env.LIVE_SHOPPING_AVAILABLE, source: 'DEPLOYMENT_ENVIRONMENT' } : null;
  }
  try {
    return { serverUrl: record.serverUrl, apiKey: decrypt(record.apiKeyCiphertext), apiSecret: decrypt(record.apiSecretCiphertext), deploymentGateEnabled: record.deploymentGateEnabled, source: 'ADMIN_DASHBOARD' };
  } catch {
    return { serverUrl: record.serverUrl, apiKey: null, apiSecret: null, deploymentGateEnabled: record.deploymentGateEnabled, source: 'ADMIN_DASHBOARD', configurationError: 'Stored credentials could not be decrypted. Replace both LiveKit credentials.' };
  }
}

export async function syncLiveProviderFromDatabase() {
  const configuration = await readConfiguration();
  if (configuration?.apiKey && configuration.apiSecret) {
    configureLiveProvider({ url: configuration.serverUrl, apiKey: configuration.apiKey, apiSecret: configuration.apiSecret });
  } else if (!configuration) {
    configureLiveProvider(credentialsFromEnvironment());
  } else {
    configureLiveProvider(null);
  }
  return configuration;
}

function publicConfiguration(configuration: StoredConfiguration | null) {
  return {
    provider: 'LIVEKIT',
    configured: Boolean(configuration?.serverUrl && configuration.apiKey && configuration.apiSecret),
    serverUrl: configuration?.serverUrl ?? null,
    apiKeyConfigured: Boolean(configuration?.apiKey),
    apiSecretConfigured: Boolean(configuration?.apiSecret),
    apiKeyMasked: mask(configuration?.apiKey ?? null),
    deploymentGateEnabled: configuration?.deploymentGateEnabled ?? env.LIVE_SHOPPING_AVAILABLE,
    source: configuration?.source ?? 'NOT_CONFIGURED',
    configurationError: configuration?.configurationError ?? null
  };
}

export function registerLiveProviderConfigurationRoutes(app: Express) {
  app.get('/api/admin/live-provider', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const configuration = await syncLiveProviderFromDatabase();
    res.json({ configuration: publicConfiguration(configuration), readiness: await liveProvider.getReadiness() });
  }));

  app.put('/api/admin/live-provider', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const input = inputSchema.parse(req.body);
    const user = res.locals.user as { id: string };
    const current = await readConfiguration();
    const environment = credentialsFromEnvironment();
    const apiKey = input.apiKey || current?.apiKey || environment?.apiKey;
    const apiSecret = input.apiSecret || current?.apiSecret || environment?.apiSecret;
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'LiveKit API key and API secret are required before saving the provider.' });

    const credentials: LiveKitCredentials = { url: input.serverUrl, apiKey, apiSecret };
    const saved = await prisma.liveKitConfiguration.upsert({
      where: { id: CONFIGURATION_ID },
      update: { serverUrl: credentials.url, apiKeyCiphertext: encrypt(credentials.apiKey), apiSecretCiphertext: encrypt(credentials.apiSecret), deploymentGateEnabled: input.deploymentGateEnabled, updatedById: user.id },
      create: { id: CONFIGURATION_ID, serverUrl: credentials.url, apiKeyCiphertext: encrypt(credentials.apiKey), apiSecretCiphertext: encrypt(credentials.apiSecret), deploymentGateEnabled: input.deploymentGateEnabled, updatedById: user.id }
    });
    configureLiveProvider(credentials);
    await audit(user.id, 'LIVE_PROVIDER_CONFIGURATION_UPDATED', 'LiveKitConfiguration', saved.id, { reason: input.reason, deploymentGateEnabled: input.deploymentGateEnabled, serverUrl: credentials.url, apiKeyChanged: Boolean(input.apiKey), apiSecretChanged: Boolean(input.apiSecret) });
    const configuration = await readConfiguration();
    res.json({ configuration: publicConfiguration(configuration), readiness: await liveProvider.getReadiness() });
  }));
}
