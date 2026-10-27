# Social login and account-entry appearance

Social sign-in is managed at **Admin dashboard → Control center → Members and security → Sign-in & social login**. Provider client secrets are encrypted by the API before they are stored, and the admin API never returns their plaintext values. Set `SOCIAL_LOGIN_ENCRYPTION_KEY` to a unique, random secret of at least 32 characters before configuring providers. Keep it stable in your deployment secret manager and back it up securely: rotating it makes previously saved provider secrets unreadable, so re-enter each provider secret after a planned key rotation. Local development falls back to a key derived from `PASSWORD_PEPPER` if this dedicated variable is omitted.

## Configure a provider

1. Run the database migration and generate Prisma Client using the project’s normal setup. Back up any database that contains valuable data before applying a schema change.
2. Set `SITE_URL` to the API’s externally reachable origin. For local development this is normally `http://localhost:4000`; production must use HTTPS.
3. In the marketplace admin screen, copy the provider’s exact callback URL.
4. Create a Web OAuth application in the provider’s developer console. Register the callback URL there, then enter its client ID and client secret in the admin screen.
5. Save while disabled first. Enable the provider only after its developer-console redirect URI, requested permissions, privacy policy, and app publication requirements are satisfied.
6. Test a complete sign-in in a separate browser session. Admin status reflects saved configuration; it does not prove that a provider has approved the app or that its credentials can complete a user authorization.

The local callback URL is `http://localhost:4000/api/auth/social/{provider}/callback`; the admin screen displays the exact URL for each provider. A production API must use its real HTTPS origin. OAuth state is one-time and expires after five minutes. Authorization Code with PKCE is used for OIDC and X; access tokens are used only for the profile lookup and are not stored. New accounts receive the buyer role. An account is linked to an existing email only when the provider asserts that exact email is verified. Facebook email is treated as unverified and the marketplace sends its own verification email. X sign-up requires X to return a confirmed email (`users.email` permission); otherwise account creation is rejected.

Provider documentation:

- [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [LinkedIn OpenID Connect sign-in](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
- [Facebook Login](https://developers.facebook.com/docs/facebook-login/)
- [X developer documentation](https://docs.x.com/)

## Scrolith status

The public [Scrolith site](https://scrolith.com/) was found, but no public developer OAuth/API guide or published OIDC metadata was discoverable during implementation. The admin screen therefore keeps Scrolith disabled by default and supports it only as an OIDC provider: activation requires an official HTTPS issuer on `scrolith.com` and a valid discovery document with authorization, token, user-info, and signing-key endpoints. Do not guess an issuer or use Scrolith API keys as login credentials. Request the official sign-in/OIDC documentation and callback registration instructions from Scrolith before enabling it.

## Customize the account pages

The same admin screen controls sign-in/sign-up headings and supporting text, an approved platform logo, one of three responsive layouts, reduced-motion-aware transitions, and the accent color. These changes take effect immediately after saving. Logo media must be uploaded through the managed platform branding media control and pass the configured malware scan before it is publicly served.

Keep provider secrets out of source files, browser code, URLs, chat messages, and Git. Use the admin screen only over HTTPS in production, restrict administrator access, and rotate a provider secret in its developer console if it may have been exposed.
