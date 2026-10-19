# Marketing and content operations

The existing structured CMS remains the source for public pages/blog content. The additive `MarketingCampaign` model supports typed JSON content, placements, priorities, scheduling, and draft/published/paused/archived state. Public `/api/campaigns/active?placement=...` returns only currently published, time-valid campaigns.

Campaign content must use the existing structured block/media validation. Do not accept arbitrary scripts, HTML widgets, fingerprinting, or sensitive demographic inference. Checkout/payment screens should not be blocked by default. Any email campaign requires explicit consent, unsubscribe/suppression handling, a separate queue, approved test recipients, and owner approval; no campaign is sent by this project automatically.

Metadata and structured content can improve crawlability but do not guarantee search ranking or indexing. The owner remains responsible for legal policy text, consent/lawful basis, retention, accessibility review, and launch approval.

