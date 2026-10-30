import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { AuthPageLayout, AuthPageMotion, Prisma, Role, SocialLoginProvider } from '@prisma/client';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, createSession, hashPassword, prisma, requireAuth, requireRole } from './security.js';
import { createAccountVerificationChallenge, deliverAccountVerification } from './account-verification-routes.js';
import { authPageCustomizationSchema, callbackUrl, oidcIssuerByProvider, oauthProviderEndpoints, parseSocialProfile, safeScrolithIssuer, socialLoginProviders, socialProviderLabels, socialProviderUpdateSchema, stateCookieName, type SocialProfile } from './social-auth-domain.js';
import { createRoleNotifications, createUserNotification } from './notification-delivery.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const stateCookie = { httpOnly: true as const, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 5 * 60 * 1000 };
const authDefaults = {
  id: 'default', signInHeading: 'Sign in', signInText: 'Welcome back. Sign in to continue.',
  signUpHeading: 'Create account', signUpText: 'Join the marketplace and discover independent stores.',
  logoMediaId: null as string | null, layout: AuthPageLayout.CENTERED, motion: AuthPageMotion.FADE, accentColor: '#315d47'
};

function encryptionKey() {
  return crypto.createHash('sha256').update(env.SOCIAL_LOGIN_ENCRYPTION_KEY ?? `${env.PASSWORD_PEPPER}:social-login-provider-config`).digest();
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decrypt(value: string | null) {
  if (!value) return null;
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Stored provider credential format is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

function masked(value: string | null) {
  if (!value) return null;
  return value.length <= 8 ? `${value.slice(0, 2)}••••` : `${value.slice(0, 4)}••••${value.slice(-3)}`;
}

function providerFromPath(value: string): SocialLoginProvider | null {
  const provider = value.toUpperCase();
  return socialLoginProviders.includes(provider as SocialLoginProvider) ? provider as SocialLoginProvider : null;
}

function pathValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function secureExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function callbackCookiePath(provider: SocialLoginProvider) {
  return `/api/auth/social/${provider.toLowerCase()}/callback`;
}

const oidcClientCache = new Map<SocialLoginProvider, { signature: string; client: oidc.Configuration }>();

function expectedIssuer(provider: SocialLoginProvider, configuredIssuer: string | null) {
  if (provider === 'SCROLITH') {
    if (!configuredIssuer || !safeScrolithIssuer(configuredIssuer)) throw new Error('Scrolith requires its verified HTTPS OIDC issuer URL.');
    return configuredIssuer;
  }
  const issuer = oidcIssuerByProvider[provider];
  if (!issuer) throw new Error('This provider does not use OpenID Connect.');
  return issuer;
}

function hostAllowedForProvider(provider: SocialLoginProvider, hostname: string) {
  const host = hostname.toLowerCase();
  if (provider === 'GOOGLE') return ['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com'].includes(host);
  if (provider === 'LINKEDIN') return ['www.linkedin.com', 'api.linkedin.com'].includes(host);
  return host === 'scrolith.com' || host.endsWith('.scrolith.com');
}

async function oidcClientFor(provider: SocialLoginProvider, row: { clientId: string | null; clientSecretCiphertext: string | null; issuerUrl: string | null }) {
  if (!row.clientId || !row.clientSecretCiphertext) throw new Error('Provider client credentials are incomplete.');
  const secret = decrypt(row.clientSecretCiphertext);
  if (!secret) throw new Error('Provider client secret is not configured.');
  const issuer = expectedIssuer(provider, row.issuerUrl);
  const signature = crypto.createHash('sha256').update(`${issuer}\n${row.clientId}\n${secret}`).digest('hex');
  const cached = oidcClientCache.get(provider);
  if (cached?.signature === signature) return cached.client;
  const client = await oidc.discovery(new URL(issuer), row.clientId, secret);
  const metadata = client.serverMetadata();
  if (metadata.issuer !== issuer) throw new Error('Provider discovery issuer does not match the configured issuer.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri'] as const) {
    const endpoint = metadata[key];
    if (!endpoint) throw new Error('Provider discovery is missing a required OIDC endpoint.');
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || !hostAllowedForProvider(provider, parsed.hostname)) throw new Error('Provider discovery returned an endpoint outside its approved HTTPS domain.');
  }
  oidcClientCache.set(provider, { signature, client });
  return client;
}

async function requestProviderJson(url: URL, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('The identity provider did not complete authentication. Check its credentials and permissions.');
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The identity provider returned an invalid profile.');
  return value as Record<string, unknown>;
}

async function manualProviderProfile(provider: 'FACEBOOK' | 'X', row: { clientId: string | null; clientSecretCiphertext: string | null }, code: string, redirectUri: string, codeVerifier: string) {
  if (!row.clientId || !row.clientSecretCiphertext) throw new Error('Provider client credentials are incomplete.');
  const secret = decrypt(row.clientSecretCiphertext);
  if (!secret) throw new Error('Provider client secret is not configured.');
  const endpoints = oauthProviderEndpoints[provider];
  const parameters = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (endpoints.pkce) parameters.set('code_verifier', codeVerifier);
  let token: Record<string, unknown>;
  if (endpoints.tokenAuth === 'basic') {
    parameters.set('client_id', row.clientId);
    const basic = Buffer.from(`${encodeURIComponent(row.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
    token = await requestProviderJson(new URL(endpoints.token), { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: parameters });
  } else {
    const url = new URL(endpoints.token);
    url.searchParams.set('client_id', row.clientId);
    url.searchParams.set('client_secret', secret);
    url.searchParams.set('code', code);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('grant_type', 'authorization_code');
    token = await requestProviderJson(url, { headers: { accept: 'application/json' } });
  }
  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (!accessToken) throw new Error('The identity provider did not return an access token.');
  const profileUrl = new URL(endpoints.userInfo);
  return requestProviderJson(profileUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
}

function authRedirect(res: Response, status: 'connected' | 'error', code?: string) {
  const target = new URL(env.WEB_ORIGIN);
  target.pathname = '/';
  target.search = '';
  target.searchParams.set('auth', 'login');
  target.searchParams.set('social', status);
  if (code) target.searchParams.set('social_error', code);
  res.redirect(303, target.toString());
}

async function redirectAfterProviderLogin(userId: string, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { onboardingCompletedAt: true } });
  if (!user?.onboardingCompletedAt) {
    const target = new URL('/onboarding', env.WEB_ORIGIN);
    return res.redirect(303, target.toString());
  }
  return authRedirect(res, 'connected');
}

async function startProviderLogin(res: Response, provider: SocialLoginProvider) {
  const row = await prisma.socialLoginProviderConfiguration.findUnique({ where: { provider } });
  if (!row?.enabled || !row.clientId || !row.clientSecretCiphertext) return authRedirect(res, 'error', 'provider_disabled');
  await prisma.oAuthLoginAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const state = oidc.randomState();
  const verifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  const redirectUri = callbackUrl(env.SITE_URL, provider);
  await prisma.oAuthLoginAttempt.create({ data: { provider, stateHash: crypto.createHash('sha256').update(state).digest('hex'), codeVerifier: encrypt(verifier), nonce, expiresAt: new Date(Date.now() + 5 * 60_000) } });
  const cookieName = stateCookieName(state);
  res.cookie(cookieName, state, { ...stateCookie, path: callbackCookiePath(provider) });

  if (provider === 'GOOGLE' || provider === 'LINKEDIN' || provider === 'SCROLITH') {
    const client = await oidcClientFor(provider, row);
    const authorizationUrl = oidc.buildAuthorizationUrl(client, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256'
    });
    return res.redirect(302, authorizationUrl.toString());
  }

  const endpoints = oauthProviderEndpoints[provider];
  const authorizationUrl = new URL(endpoints.authorization);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', row.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('scope', endpoints.scope);
  authorizationUrl.searchParams.set('state', state);
  if (endpoints.pkce) {
    authorizationUrl.searchParams.set('code_challenge', await oidc.calculatePKCECodeChallenge(verifier));
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  }
  return res.redirect(302, authorizationUrl.toString());
}

async function completeProviderLogin(provider: SocialLoginProvider, profile: SocialProfile, res: Response) {
  const existingIdentity = await prisma.socialLoginIdentity.findUnique({ where: { provider_subject: { provider, subject: profile.subject } }, include: { user: true } });
  if (existingIdentity) {
    if (existingIdentity.user.accountStatus !== 'ACTIVE') return authRedirect(res, 'error', 'account_unavailable');
    await createSession(existingIdentity.userId, res);
    return redirectAfterProviderLogin(existingIdentity.userId, res);
  }

  const existingUser = await prisma.user.findUnique({ where: { email: profile.email } });
  if (existingUser && (!profile.emailVerified || existingUser.accountStatus !== 'ACTIVE')) return authRedirect(res, 'error', existingUser.accountStatus === 'ACTIVE' ? 'email_conflict' : 'account_unavailable');

  let userId = existingUser?.id;
  let verificationNeeded = false;
  try {
    if (!userId) {
      const created = await prisma.$transaction(async tx => {
        const user = await tx.user.create({ data: {
          email: profile.email,
          name: profile.name,
          passwordHash: await hashPassword(crypto.randomBytes(48).toString('base64url')),
          ...(profile.emailVerified ? { emailVerifiedAt: new Date() } : {})
        } });
        await tx.socialLoginIdentity.create({ data: { provider, subject: profile.subject, email: profile.email, userId: user.id } });
        await createUserNotification(tx, { userId: user.id, eventType: 'ACCOUNT_CREATED', title: 'Welcome to Market Lane', body: 'Your account is ready. Complete onboarding to start exploring the marketplace.', link: '/onboarding', payloadJson: { userId: user.id } }, 'account');
        await createRoleNotifications(tx, Role.ADMIN, { eventType: 'ACCOUNT_CREATED', title: 'New member account created', body: `${user.name} (${user.email}) created an account using ${socialProviderLabels[provider]}.`, link: '/admin/platform?section=members', payloadJson: { userId: user.id, provider } }, 'account');
        return user;
      });
      userId = created.id;
      verificationNeeded = !profile.emailVerified;
    } else {
      await prisma.socialLoginIdentity.create({ data: { provider, subject: profile.subject, email: profile.email, userId } });
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const racedIdentity = await prisma.socialLoginIdentity.findUnique({ where: { provider_subject: { provider, subject: profile.subject } }, include: { user: true } });
      if (racedIdentity?.user.accountStatus === 'ACTIVE') {
        await createSession(racedIdentity.userId, res);
        return redirectAfterProviderLogin(racedIdentity.userId, res);
      }
      return authRedirect(res, 'error', 'email_conflict');
    }
    throw error;
  }

  if (!userId) return authRedirect(res, 'error', 'try_again');
  if (verificationNeeded) {
    try {
      const challenge = await createAccountVerificationChallenge(userId);
      await deliverAccountVerification(challenge);
    } catch { /* The account remains unverified; the existing resend-verification flow is available after sign-in. */ }
  }
  await createSession(userId, res);
  return redirectAfterProviderLogin(userId, res);
}

export function registerSocialAuthRoutes(app: Express) {
  app.get('/api/auth/presentation', run(async (_req, res) => {
    const page = await prisma.authPageCustomization.findUnique({ where: { id: 'default' }, include: { logoMedia: { select: { scanStatus: true, uploadStatus: true } } } });
    const settings = page ?? authDefaults;
    const logoReady = Boolean(page?.logoMedia && page.logoMedia.scanStatus === 'APPROVED' && page.logoMedia.uploadStatus === 'COMPLETE');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ signInHeading: settings.signInHeading, signInText: settings.signInText, signUpHeading: settings.signUpHeading, signUpText: settings.signUpText, logoUrl: logoReady && page?.logoMediaId ? `/content-media/${encodeURIComponent(page.logoMediaId)}` : null, layout: settings.layout, motion: settings.motion, accentColor: settings.accentColor });
  }));

  app.get('/api/auth/social/providers', run(async (_req, res) => {
    const rows = await prisma.socialLoginProviderConfiguration.findMany({ where: { enabled: true, clientId: { not: null }, clientSecretCiphertext: { not: null } }, select: { provider: true, logoUrl: true } });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ providers: rows.map(row => ({ id: row.provider, label: socialProviderLabels[row.provider], logoUrl: row.logoUrl })) });
  }));

  app.get('/api/admin/auth/social/providers', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const rows = await prisma.socialLoginProviderConfiguration.findMany();
    const byProvider = new Map(rows.map(row => [row.provider, row]));
    res.json({ providers: socialLoginProviders.map(provider => {
      const row = byProvider.get(provider);
      return { id: provider, label: socialProviderLabels[provider], enabled: row?.enabled ?? false, configured: Boolean(row?.clientId && row?.clientSecretCiphertext), clientId: row?.clientId ?? '', clientIdMasked: masked(row?.clientId ?? null), clientSecretConfigured: Boolean(row?.clientSecretCiphertext), issuerUrl: row?.issuerUrl ?? '', logoUrl: row?.logoUrl ?? '', callbackUrl: callbackUrl(env.SITE_URL, provider), requiresIssuer: provider === 'SCROLITH' };
    }) });
  }));

  app.put('/api/admin/auth/social/providers/:provider', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const provider = providerFromPath(pathValue(req.params.provider));
    if (!provider) return res.status(404).json({ error: 'Social login provider not found.' });
    const input = socialProviderUpdateSchema.parse(req.body);
    const user = res.locals.user as { id: string };
    const current = await prisma.socialLoginProviderConfiguration.findUnique({ where: { provider } });
    const clientId = input.clientId || current?.clientId || null;
    const clientSecretCiphertext = input.clientSecret ? encrypt(input.clientSecret) : current?.clientSecretCiphertext ?? null;
    const issuerUrl = input.issuerUrl || current?.issuerUrl || null;
    if (provider === 'SCROLITH' && issuerUrl && !safeScrolithIssuer(issuerUrl)) return res.status(400).json({ error: 'Use the HTTPS OIDC issuer supplied by Scrolith on scrolith.com.' });
    if (provider !== 'SCROLITH' && input.issuerUrl) return res.status(400).json({ error: 'Google and LinkedIn use their built-in official issuer; Facebook and X do not accept a custom issuer.' });
    if (input.logoUrl && !secureExternalUrl(input.logoUrl)) return res.status(400).json({ error: 'Provider logo must use a secure HTTPS URL.' });
    if (input.enabled && (!clientId || !clientSecretCiphertext)) return res.status(400).json({ error: 'Client ID and client secret are required before enabling this provider.' });
    if (input.enabled && provider === 'SCROLITH' && !issuerUrl) return res.status(400).json({ error: 'Scrolith cannot be enabled until Scrolith provides its OIDC issuer URL.' });

    if (input.enabled && (provider === 'GOOGLE' || provider === 'LINKEDIN' || provider === 'SCROLITH')) {
      try { await oidcClientFor(provider, { clientId, clientSecretCiphertext, issuerUrl }); }
      catch { return res.status(400).json({ error: 'OIDC discovery could not be verified. Check the provider issuer, app credentials, and network reachability.' }); }
    }

    const saved = await prisma.socialLoginProviderConfiguration.upsert({
      where: { provider },
      update: { enabled: input.enabled, clientId, clientSecretCiphertext, issuerUrl, logoUrl: input.logoUrl || null, updatedById: user.id },
      create: { provider, enabled: input.enabled, clientId, clientSecretCiphertext, issuerUrl, logoUrl: input.logoUrl || null, updatedById: user.id }
    });
    await audit(user.id, 'SOCIAL_LOGIN_PROVIDER_UPDATED', 'SocialLoginProviderConfiguration', saved.id, { provider, enabled: saved.enabled, clientIdChanged: Boolean(input.clientId), secretChanged: Boolean(input.clientSecret), issuerUrl: provider === 'SCROLITH' ? issuerUrl : undefined });
    res.json({ ok: true, provider: saved.provider, enabled: saved.enabled, configured: Boolean(saved.clientId && saved.clientSecretCiphertext), clientIdMasked: masked(saved.clientId), clientSecretConfigured: Boolean(saved.clientSecretCiphertext) });
  }));

  app.get('/api/admin/auth/presentation', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const page = await prisma.authPageCustomization.findUnique({ where: { id: 'default' } });
    res.json(page ?? authDefaults);
  }));

  app.put('/api/admin/auth/presentation', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const input = authPageCustomizationSchema.parse(req.body);
    const user = res.locals.user as { id: string };
    if (input.logoMediaId) {
      const asset = await prisma.mediaAsset.findFirst({ where: { id: input.logoMediaId, storeId: null, kind: 'IMAGE', uploadStatus: 'COMPLETE', scanStatus: 'APPROVED' }, select: { id: true } });
      if (!asset) return res.status(400).json({ error: 'Choose an approved, completely uploaded platform image for the sign-in logo.' });
    }
    const page = await prisma.authPageCustomization.upsert({ where: { id: 'default' }, update: { ...input, updatedById: user.id }, create: { ...input, updatedById: user.id } });
    await audit(user.id, 'AUTH_PAGE_CUSTOMIZATION_UPDATED', 'AuthPageCustomization', page.id, { layout: page.layout, motion: page.motion, logoChanged: input.logoMediaId !== undefined });
    res.json(page);
  }));

  app.get('/api/auth/social/:provider/start', run(async (req, res) => {
    const provider = providerFromPath(pathValue(req.params.provider));
    if (!provider) return res.status(404).json({ error: 'Social login provider not found.' });
    try { await startProviderLogin(res, provider); }
    catch { authRedirect(res, 'error', 'provider_error'); }
  }));

  app.get('/api/auth/social/:provider/callback', run(async (req, res) => {
    const provider = providerFromPath(pathValue(req.params.provider));
    if (!provider) return authRedirect(res, 'error', 'provider_error');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state || !/^[A-Za-z0-9_-]{16,200}$/.test(state)) return authRedirect(res, 'error', 'try_again');
    const cookieName = stateCookieName(state);
    const cookieState = req.cookies?.[cookieName];
    if (typeof cookieState !== 'string') return authRedirect(res, 'error', 'try_again');
    const cookieStateBytes = Buffer.from(cookieState);
    const stateBytes = Buffer.from(state);
    if (cookieStateBytes.length !== stateBytes.length || !crypto.timingSafeEqual(cookieStateBytes, stateBytes)) return authRedirect(res, 'error', 'try_again');
    res.clearCookie(cookieName, { path: callbackCookiePath(provider), secure: env.NODE_ENV === 'production', sameSite: 'lax' });
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const attempt = await prisma.oAuthLoginAttempt.findUnique({ where: { stateHash } });
    if (!attempt || attempt.provider !== provider || attempt.expiresAt <= new Date() || attempt.consumedAt) return authRedirect(res, 'error', 'try_again');
    const consumed = await prisma.oAuthLoginAttempt.updateMany({ where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (!consumed.count) return authRedirect(res, 'error', 'try_again');
    if (typeof req.query.error === 'string') return authRedirect(res, 'error', 'provider_error');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return authRedirect(res, 'error', 'provider_error');
    const row = await prisma.socialLoginProviderConfiguration.findUnique({ where: { provider } });
    if (!row?.enabled || !row.clientId || !row.clientSecretCiphertext) return authRedirect(res, 'error', 'provider_disabled');
    const redirectUri = callbackUrl(env.SITE_URL, provider);

    let rawProfile: unknown;
    if (provider === 'GOOGLE' || provider === 'LINKEDIN' || provider === 'SCROLITH') {
      const client = await oidcClientFor(provider, row);
      const callback = new URL(req.originalUrl, env.SITE_URL);
      const tokens = await oidc.authorizationCodeGrant(client, callback, { expectedState: state, expectedNonce: attempt.nonce ?? undefined, pkceCodeVerifier: decrypt(attempt.codeVerifier) ?? '' });
      const claims = tokens.claims();
      if (!claims?.sub || !tokens.access_token) return authRedirect(res, 'error', 'provider_error');
      const userInfo = await oidc.fetchUserInfo(client, tokens.access_token, claims.sub);
      const profileEmail = typeof userInfo.email === 'string' ? userInfo.email : claims.email;
      const emailVerified = typeof profileEmail === 'string' && ((userInfo.email === profileEmail && userInfo.email_verified === true) || (claims.email === profileEmail && claims.email_verified === true));
      rawProfile = { ...claims, ...userInfo, email: profileEmail, email_verified: emailVerified };
    } else {
      const codeVerifier = decrypt(attempt.codeVerifier) ?? '';
      rawProfile = await manualProviderProfile(provider, row, code, redirectUri, codeVerifier);
    }
    let profile: SocialProfile;
    try { profile = parseSocialProfile(provider, rawProfile); }
    catch { return authRedirect(res, 'error', 'email_required'); }
    await completeProviderLogin(provider, profile, res);
  }));
}
