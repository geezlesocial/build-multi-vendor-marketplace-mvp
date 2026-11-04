import { z } from "zod";

const plainText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !/[<>]/.test(value), "Use plain text without markup.");
const mediaId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .nullable();
const iconKey = z.enum([
  "spark",
  "shield",
  "store",
  "heart",
  "globe",
  "truck",
  "support",
]);

function relativeLuminance(hex: string) {
  const linear = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return (
    (linear[0] ?? 0) * 0.2126 +
    (linear[1] ?? 0) * 0.7152 +
    (linear[2] ?? 0) * 0.0722
  );
}

function contrastRatio(first: string, second: string) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

export const onboardingSectionIds = [
  "ACCOUNT",
  "STORES",
  "CURRENCY",
  "REFERRAL",
] as const;
export type OnboardingSectionId = (typeof onboardingSectionIds)[number];

const sectionSchema = z
  .object({
    id: z.enum(onboardingSectionIds),
    eyebrow: plainText(48),
    title: plainText(100, 1),
    description: plainText(320),
    helpText: plainText(240),
    icon: iconKey,
  })
  .strict();

const optionalBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      kind: z.literal("benefit"),
      title: plainText(100, 1),
      body: plainText(320, 1),
      icon: iconKey,
      placement: z.enum(["BEFORE_ACCOUNT", "AFTER_STORES", "BEFORE_FOOTER"]),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      kind: z.literal("trust"),
      title: plainText(100, 1),
      body: plainText(320, 1),
      placement: z.enum(["BEFORE_ACCOUNT", "AFTER_STORES", "BEFORE_FOOTER"]),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      kind: z.literal("faq"),
      question: plainText(180, 1),
      answer: plainText(600, 1),
      placement: z.enum(["BEFORE_ACCOUNT", "AFTER_STORES", "BEFORE_FOOTER"]),
    })
    .strict(),
]);

export const onboardingExperienceSchema = z
  .object({
    welcome: z
      .object({
        eyebrow: plainText(64, 1),
        title: plainText(140, 1),
        description: plainText(420, 1),
        platformFallbackName: plainText(80, 1),
        logoMediaId: mediaId,
        logoAlt: plainText(180),
        logoFit: z.enum(["cover", "contain"]),
        logoFocalX: z.number().min(0).max(1),
        logoFocalY: z.number().min(0).max(1),
        heroMediaId: mediaId,
        heroAlt: plainText(180),
        heroFit: z.enum(["cover", "contain"]),
        heroFocalX: z.number().min(0).max(1),
        heroFocalY: z.number().min(0).max(1),
      })
      .strict(),
    design: z
      .object({
        variant: z.enum(["SOFT", "EDITORIAL", "BOLD"]),
        primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        surfaceColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        typography: z.enum(["SANS", "SERIF"]),
        cardStyle: z.enum(["ROUNDED", "SHARP"]),
        density: z.enum(["COMFORTABLE", "COMPACT"]),
        decoration: z.enum(["ORBIT", "ARC", "NONE"]),
        motion: z.enum(["SUBTLE", "NONE"]),
      })
      .strict()
      .superRefine((design, context) => {
        if (contrastRatio(design.textColor, design.surfaceColor) < 4.5)
          context.addIssue({
            code: "custom",
            path: ["textColor"],
            message:
              "Text and page surface colors need at least 4.5:1 contrast.",
          });
        if (contrastRatio(design.textColor, "#ffffff") < 4.5)
          context.addIssue({
            code: "custom",
            path: ["textColor"],
            message: "Text and white cards need at least 4.5:1 contrast.",
          });
        if (contrastRatio(design.accentColor, design.surfaceColor) < 4.5)
          context.addIssue({
            code: "custom",
            path: ["accentColor"],
            message:
              "Accent text and page surface colors need at least 4.5:1 contrast.",
          });
        if (contrastRatio(design.accentColor, "#ffffff") < 4.5)
          context.addIssue({
            code: "custom",
            path: ["accentColor"],
            message:
              "Accent text and white cards need at least 4.5:1 contrast.",
          });
        if (contrastRatio(design.primaryColor, "#ffffff") < 4.5)
          context.addIssue({
            code: "custom",
            path: ["primaryColor"],
            message:
              "Primary controls need at least 4.5:1 contrast against white.",
          });
      }),
    sections: z
      .array(sectionSchema)
      .length(4)
      .refine(
        (sections) => new Set(sections.map((section) => section.id)).size === 4,
        "All required onboarding sections must appear exactly once.",
      ),
    blocks: z
      .array(optionalBlockSchema)
      .max(8)
      .refine(
        (blocks) =>
          new Set(blocks.map((block) => block.id)).size === blocks.length,
        "Optional block identifiers must be unique.",
      ),
    footer: z
      .object({ helpText: plainText(240, 1), submitLabel: plainText(80, 1) })
      .strict(),
  })
  .strict();

export type OnboardingExperience = z.infer<typeof onboardingExperienceSchema>;

export const defaultOnboardingExperience: OnboardingExperience = {
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

export function safeOnboardingExperience(value: unknown): OnboardingExperience {
  const parsed = onboardingExperienceSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultOnboardingExperience;
}
