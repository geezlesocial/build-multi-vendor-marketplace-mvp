import { BrandingImageControl } from "./BrandingImageControl.js";
import {
  DEFAULT_ONBOARDING_EXPERIENCE,
  type OnboardingExperience,
} from "./onboarding-experience.js";

const mediaUrls = {
  list: "/api/admin/platform/onboarding-media",
  upload: "/api/admin/platform/onboarding-media/uploads",
  preview: (id: string) =>
    `/api/admin/platform/onboarding-media/${encodeURIComponent(id)}/preview`,
};

export function OnboardingWelcomeEditor({
  config,
  published,
  disabled,
  onChange,
}: {
  config: OnboardingExperience;
  published: OnboardingExperience | null;
  disabled: boolean;
  onChange: (next: OnboardingExperience) => void;
}) {
  const set = (
    field: keyof OnboardingExperience["welcome"],
    value: string | number | null,
  ) => onChange({ ...config, welcome: { ...config.welcome, [field]: value } });
  const reset = () =>
    onChange({
      ...config,
      welcome: { ...DEFAULT_ONBOARDING_EXPERIENCE.welcome },
    });
  const imageFields = (kind: "logo" | "hero") => {
    const isLogo = kind === "logo";
    const title = isLogo ? "Logo" : "Hero";
    const mediaId = isLogo
      ? config.welcome.logoMediaId
      : config.welcome.heroMediaId;
    const publishedId = isLogo
      ? published?.welcome.logoMediaId
      : published?.welcome.heroMediaId;
    const alt = isLogo ? config.welcome.logoAlt : config.welcome.heroAlt;
    const fit = isLogo ? config.welcome.logoFit : config.welcome.heroFit;
    const focalX = isLogo
      ? config.welcome.logoFocalX
      : config.welcome.heroFocalX;
    const focalY = isLogo
      ? config.welcome.logoFocalY
      : config.welcome.heroFocalY;
    return (
      <>
        <BrandingImageControl
          label={isLogo ? "Onboarding logo" : "Onboarding hero image"}
          ratio={isLogo ? 3 : 2.7}
          value={mediaId}
          publishedValue={publishedId}
          onChange={(id) => set(isLogo ? "logoMediaId" : "heroMediaId", id)}
          disabled={disabled}
          listUrl={mediaUrls.list}
          uploadUrl={mediaUrls.upload}
          previewUrl={mediaUrls.preview}
        />
        <label>
          {title} alternative text
          <input
            value={alt}
            maxLength={180}
            disabled={disabled}
            onChange={(event) =>
              set(isLogo ? "logoAlt" : "heroAlt", event.target.value)
            }
          />
        </label>
        <label>
          {title} image fit
          <select
            value={fit}
            disabled={disabled}
            onChange={(event) =>
              set(isLogo ? "logoFit" : "heroFit", event.target.value)
            }
          >
            <option value="contain">Contain</option>
            <option value="cover">Cover</option>
          </select>
        </label>
        <label>
          {title} horizontal focal point
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={focalX}
            disabled={disabled}
            onChange={(event) =>
              set(
                isLogo ? "logoFocalX" : "heroFocalX",
                Number(event.target.value),
              )
            }
          />
        </label>
        <label>
          {title} vertical focal point
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={focalY}
            disabled={disabled}
            onChange={(event) =>
              set(
                isLogo ? "logoFocalY" : "heroFocalY",
                Number(event.target.value),
              )
            }
          />
        </label>
      </>
    );
  };

  return (
    <section className="card cardBody onboardingEditorCard">
      <div className="onboardingEditorCardHeading">
        <div>
          <p className="eyebrow">Welcome</p>
          <h3>Brand and first impression</h3>
        </div>
        <button type="button" disabled={disabled} onClick={reset}>
          Reset welcome fields
        </button>
      </div>
      <label>
        Eyebrow
        <input
          value={config.welcome.eyebrow}
          maxLength={64}
          disabled={disabled}
          onChange={(event) => set("eyebrow", event.target.value)}
        />
      </label>
      <label>
        Welcome heading
        <input
          value={config.welcome.title}
          maxLength={140}
          disabled={disabled}
          onChange={(event) => set("title", event.target.value)}
        />
        <small>
          Use {"{platformName}"} to insert the published platform name.
        </small>
      </label>
      <label>
        Welcome description
        <textarea
          rows={3}
          value={config.welcome.description}
          maxLength={420}
          disabled={disabled}
          onChange={(event) => set("description", event.target.value)}
        />
      </label>
      <label>
        Fallback platform name
        <input
          value={config.welcome.platformFallbackName}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => set("platformFallbackName", event.target.value)}
        />
      </label>
      <div className="onboardingEditorImages">
        {imageFields("logo")}
        {imageFields("hero")}
      </div>
    </section>
  );
}

export function OnboardingDesignEditor({
  config,
  disabled,
  onChange,
}: {
  config: OnboardingExperience;
  disabled: boolean;
  onChange: (next: OnboardingExperience) => void;
}) {
  const set = (field: keyof OnboardingExperience["design"], value: string) =>
    onChange({
      ...config,
      design: {
        ...config.design,
        [field]: value,
      } as OnboardingExperience["design"],
    });
  const choices = [
    [
      "variant",
      "Design variant",
      [
        ["SOFT", "Soft"],
        ["EDITORIAL", "Editorial"],
        ["BOLD", "Bold"],
      ],
    ],
    [
      "typography",
      "Typography",
      [
        ["SANS", "Sans serif"],
        ["SERIF", "Serif"],
      ],
    ],
    [
      "cardStyle",
      "Card corners",
      [
        ["ROUNDED", "Rounded"],
        ["SHARP", "Sharp"],
      ],
    ],
    [
      "density",
      "Content density",
      [
        ["COMFORTABLE", "Comfortable"],
        ["COMPACT", "Compact"],
      ],
    ],
    [
      "decoration",
      "Decoration",
      [
        ["ORBIT", "Orbit"],
        ["ARC", "Arc"],
        ["NONE", "None"],
      ],
    ],
    [
      "motion",
      "Motion",
      [
        ["SUBTLE", "Subtle transitions"],
        ["NONE", "No motion"],
      ],
    ],
  ] as const;
  const colors = [
    ["primaryColor", "Primary color"],
    ["accentColor", "Accent color"],
    ["surfaceColor", "Page surface"],
    ["textColor", "Text color"],
  ] as const;

  return (
    <section className="card cardBody onboardingEditorCard">
      <div className="onboardingEditorCardHeading">
        <div>
          <p className="eyebrow">Design system</p>
          <h3>Curated visual options</h3>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...config,
              design: { ...DEFAULT_ONBOARDING_EXPERIENCE.design },
            })
          }
        >
          Reset design fields
        </button>
      </div>
      <div className="onboardingEditorFields">
        {choices.map(([key, label, options]) => (
          <label key={key}>
            {label}
            <select
              value={config.design[key]}
              disabled={disabled}
              onChange={(event) => set(key, event.target.value)}
            >
              {options.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ))}
        {colors.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="color"
              value={config.design[key]}
              disabled={disabled}
              onChange={(event) => set(key, event.target.value)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
