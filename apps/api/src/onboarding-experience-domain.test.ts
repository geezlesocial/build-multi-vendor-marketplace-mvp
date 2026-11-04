import { describe, expect, it } from "vitest";
import {
  defaultOnboardingExperience,
  onboardingExperienceSchema,
  safeOnboardingExperience,
} from "./onboarding-experience-domain.js";

describe("admin-managed onboarding experience contract", () => {
  it("accepts the default typed experience with all mandatory workflow sections", () => {
    expect(
      onboardingExperienceSchema.parse(defaultOnboardingExperience),
    ).toEqual(defaultOnboardingExperience);
  });

  it("rejects removing or duplicating required sections and rejects unknown executable fields", () => {
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        sections: defaultOnboardingExperience.sections.slice(1),
      }),
    ).toThrow();
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        design: {
          ...defaultOnboardingExperience.design,
          textColor: "#f3f4ee",
        },
      }),
    ).toThrow();
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        sections: [
          ...defaultOnboardingExperience.sections.slice(0, 3),
          defaultOnboardingExperience.sections[0],
        ],
      }),
    ).toThrow();
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        script: "alert(1)",
      }),
    ).toThrow();
  });

  it("rejects HTML, unsafe identifiers, invalid colors, and duplicate optional blocks", () => {
    const badCopy = structuredClone(defaultOnboardingExperience);
    badCopy.welcome.title = "<script>bad</script>";
    expect(() => onboardingExperienceSchema.parse(badCopy)).toThrow();
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        design: {
          ...defaultOnboardingExperience.design,
          primaryColor: "url(javascript:alert(1))",
        },
      }),
    ).toThrow();
    const block = {
      id: "trust",
      kind: "trust" as const,
      title: "Shop confidently",
      body: "Support is available.",
      placement: "AFTER_STORES" as const,
    };
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        blocks: [block, block],
      }),
    ).toThrow();
    expect(() =>
      onboardingExperienceSchema.parse({
        ...defaultOnboardingExperience,
        design: {
          ...defaultOnboardingExperience.design,
          primaryColor: "#eeeeee",
        },
      }),
    ).toThrow();
  });

  it("falls back to the safe default when persisted JSON is malformed", () => {
    expect(safeOnboardingExperience({ html: "<script>" })).toEqual(
      defaultOnboardingExperience,
    );
  });
});
