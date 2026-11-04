export type OnboardingSectionId =
  "ACCOUNT" | "STORES" | "CURRENCY" | "REFERRAL";
export type ReferralSource =
  | "FRIEND"
  | "GOOGLE"
  | "FACEBOOK"
  | "TWITTER_X"
  | "LINKEDIN"
  | "SCROLITH"
  | "AI_RECOMMENDATION"
  | "OTHER";
export type OnboardingStore = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isOfficial: boolean;
  category: string | null;
  logoUrl: string | null;
  following: boolean;
  followerCount: number;
};
export type OnboardingCurrency = { code: string; name: string; symbol: string };
export type OnboardingAccount = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
};
export type OnboardingBrand = {
  platformName: string | null;
  tagline: string;
  logoUrl: string | null;
  bannerUrl: string | null;
};
export const ONBOARDING_ICON_GLYPHS = {
  spark: "✦",
  shield: "◆",
  store: "▦",
  heart: "♥",
  globe: "◎",
  truck: "↗",
  support: "?",
} as const;
export type OnboardingSection = {
  id: OnboardingSectionId;
  eyebrow: string;
  title: string;
  description: string;
  helpText: string;
  icon: "spark" | "shield" | "store" | "heart" | "globe" | "truck" | "support";
};
export type OnboardingBlock =
  | {
      id: string;
      kind: "benefit";
      title: string;
      body: string;
      icon:
        "spark" | "shield" | "store" | "heart" | "globe" | "truck" | "support";
      placement: "BEFORE_ACCOUNT" | "AFTER_STORES" | "BEFORE_FOOTER";
    }
  | {
      id: string;
      kind: "trust";
      title: string;
      body: string;
      placement: "BEFORE_ACCOUNT" | "AFTER_STORES" | "BEFORE_FOOTER";
    }
  | {
      id: string;
      kind: "faq";
      question: string;
      answer: string;
      placement: "BEFORE_ACCOUNT" | "AFTER_STORES" | "BEFORE_FOOTER";
    };
export type OnboardingExperience = {
  welcome: {
    eyebrow: string;
    title: string;
    description: string;
    platformFallbackName: string;
    logoMediaId: string | null;
    logoAlt: string;
    logoFit: "cover" | "contain";
    logoFocalX: number;
    logoFocalY: number;
    logoUrl?: string | null;
    heroMediaId: string | null;
    heroAlt: string;
    heroUrl?: string | null;
    heroFit: "cover" | "contain";
    heroFocalX: number;
    heroFocalY: number;
  };
  design: {
    variant: "SOFT" | "EDITORIAL" | "BOLD";
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
    typography: "SANS" | "SERIF";
    cardStyle: "ROUNDED" | "SHARP";
    density: "COMFORTABLE" | "COMPACT";
    decoration: "ORBIT" | "ARC" | "NONE";
    motion: "SUBTLE" | "NONE";
  };
  sections: OnboardingSection[];
  blocks: OnboardingBlock[];
  footer: { helpText: string; submitLabel: string };
};

export const DEFAULT_ONBOARDING_EXPERIENCE: OnboardingExperience = {
  welcome: {
    eyebrow: "A more personal marketplace",
    title: "Welcome to {platformName}",
    description:
      "Follow a few marketplace stores and choose how you prefer to browse. Your choices can be changed later in account settings.",
    platformFallbackName: "Market Lane",
    logoMediaId: null,
    logoAlt: "",
    logoFit: "contain",
    logoFocalX: 0.5,
    logoFocalY: 0.5,
    heroMediaId: null,
    heroAlt: "",
    heroFit: "cover",
    heroFocalX: 0.5,
    heroFocalY: 0.5,
  },
  design: {
    variant: "SOFT",
    primaryColor: "#315a45",
    accentColor: "#a94b2c",
    surfaceColor: "#f3f4ee",
    textColor: "#18211d",
    typography: "SANS",
    cardStyle: "ROUNDED",
    density: "COMFORTABLE",
    decoration: "ORBIT",
    motion: "SUBTLE",
  },
  sections: [
    {
      id: "ACCOUNT",
      eyebrow: "Your account",
      title: "Review your details",
      description: "These are the details you used to create your account.",
      helpText: "You can edit profile details after onboarding.",
      icon: "shield",
    },
    {
      id: "STORES",
      eyebrow: "Discover marketplace stores",
      title: "Choose stores to follow",
      description:
        "Follow at least two eligible stores to complete setup. The official platform store is always recommended. You can change your follows later.",
      helpText: "Your follows can be changed later.",
      icon: "store",
    },
    {
      id: "CURRENCY",
      eyebrow: "Your browsing preferences",
      title: "Choose your default currency",
      description:
        "This sets your default display preference where supported. Product prices, checkout, and payments remain in their existing currencies.",
      helpText:
        "Your currency preference can be changed later in account settings.",
      icon: "globe",
    },
    {
      id: "REFERRAL",
      eyebrow: "A quick question",
      title: "Where did you hear about us?",
      description:
        "This helps us understand how people find the marketplace. It does not sign you up for marketing emails.",
      helpText: "Your answer is separate from marketing consent.",
      icon: "heart",
    },
  ],
  blocks: [],
  footer: {
    helpText:
      "Your referral answer is separate from marketing consent. You can update your currency preference later in settings.",
    submitLabel: "Complete onboarding & continue",
  },
};
