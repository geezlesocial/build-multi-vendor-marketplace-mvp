import { z } from 'zod';
import type { SocialLoginProvider } from '@prisma/client';

export const socialLoginProviders: SocialLoginProvider[] = ['GOOGLE', 'LINKEDIN', 'FACEBOOK', 'X', 'SCROLITH'];

export const socialProviderLabels: Record<SocialLoginProvider, string> = {
  GOOGLE: 'Google',
  LINKEDIN: 'LinkedIn',
  FACEBOOK: 'Facebook',
  X: 'X',
  SCROLITH: 'Scrolith'
};

export const oidcIssuerByProvider: Partial<Record<SocialLoginProvider, string>> = {
  GOOGLE: 'https://accounts.google.com',
  LINKEDIN: 'https://www.linkedin.com'
};

export const oauthProviderEndpoints = {
  FACEBOOK: {
    authorization: 'https://www.facebook.com/v25.0/dialog/oauth',
    token: 'https://graph.facebook.com/v25.0/oauth/access_token',
    userInfo: 'https://graph.facebook.com/v25.0/me?fields=id,name,email',
    scope: 'public_profile email',
    pkce: false,
    tokenAuth: 'query' as const
  },
  X: {
    authorization: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    userInfo: 'https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url,confirmed_email',
    scope: 'tweet.read users.read users.email',
    pkce: true,
    tokenAuth: 'basic' as const
  }
} as const;

export const authPageCustomizationSchema = z.object({
  signInHeading: z.string().trim().min(2).max(100),
  signInText: z.string().trim().max(240),
  signUpHeading: z.string().trim().min(2).max(100),
  signUpText: z.string().trim().max(240),
  logoMediaId: z.string().trim().min(1).max(100).nullable(),
  layout: z.enum(['CENTERED', 'SPLIT', 'EDITORIAL']),
  motion: z.enum(['NONE', 'FADE', 'SLIDE']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/)
}).strict();

export const socialProviderUpdateSchema = z.object({
  clientId: z.string().trim().max(500).optional().default(''),
  clientSecret: z.string().max(2000).optional().default(''),
  issuerUrl: z.string().trim().max(500).optional().default(''),
  logoUrl: z.string().trim().max(1000).optional().default(''),
  enabled: z.boolean()
}).strict();

const profileSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(320).transform(value => value.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  emailVerified: z.boolean()
});

export type SocialProfile = z.infer<typeof profileSchema>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseSocialProfile(provider: SocialLoginProvider, input: unknown): SocialProfile {
  const data = record(input);
  if (provider === 'X') {
    const xUser = record(data.data);
    return profileSchema.parse({ subject: xUser.id, email: xUser.confirmed_email, name: xUser.name ?? xUser.username, emailVerified: Boolean(xUser.confirmed_email) });
  }
  if (provider === 'FACEBOOK') {
    return profileSchema.parse({ subject: data.id, email: data.email, name: data.name, emailVerified: false });
  }
  return profileSchema.parse({ subject: data.sub, email: data.email, name: data.name ?? data.given_name ?? data.email, emailVerified: data.email_verified === true });
}

export function safeScrolithIssuer(value: string) {
  let issuer: URL;
  try { issuer = new URL(value); } catch { return false; }
  const host = issuer.hostname.toLowerCase();
  return issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.search && !issuer.hash && (host === 'scrolith.com' || host.endsWith('.scrolith.com'));
}

export function callbackUrl(siteUrl: string, provider: SocialLoginProvider) {
  const origin = new URL(siteUrl).origin;
  return new URL(`/api/auth/social/${provider.toLowerCase()}/callback`, origin).toString();
}

export function stateCookieName(state: string) {
  return `oauth_state_${state.slice(0, 16)}`;
}
