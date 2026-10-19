# AI features

The API exposes a safe deterministic search fallback at `/api/ai/search` and returns a clear `503` from `/api/ai/chat` while no owner-approved AI provider is configured. Browsing, cart, checkout, payments, seller isolation, and messaging do not depend on AI.

No provider account or key is selected. Before enabling AI, the owner must approve a provider, budget/rate limits, retention and deletion rules, privacy notice/consent, and a kill switch. The provider adapter must run server-side, log only minimized usage data, ground answers in authorized catalog/public content, validate product/page identifiers against the database, resist prompt injection from retrieved content, and explain uncertainty. AI must not invent stock, prices, discounts, policy text, or buyer/seller data.

