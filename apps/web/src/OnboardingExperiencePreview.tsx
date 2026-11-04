import React, { type CSSProperties } from "react";
import {
  ONBOARDING_ICON_GLYPHS,
  type OnboardingBlock,
  type OnboardingExperience,
} from "./onboarding-experience.js";

export function OnboardingExperiencePreview({
  configuration,
  mobile,
}: {
  configuration: OnboardingExperience;
  mobile: boolean;
}) {
  const style = {
    "--ob-primary": configuration.design.primaryColor,
    "--ob-accent": configuration.design.accentColor,
    "--ob-surface": configuration.design.surfaceColor,
    "--ob-text": configuration.design.textColor,
  } as CSSProperties;
  const platformName = "Market Lane";
  const title = configuration.welcome.title.replace(
    "{platformName}",
    platformName,
  );

  return (
    <div
      className={`onboardingPreviewFrame${mobile ? " isMobile" : ""}`}
      style={style}
      data-variant={configuration.design.variant.toLowerCase()}
      data-typography={configuration.design.typography.toLowerCase()}
      data-card-style={configuration.design.cardStyle.toLowerCase()}
      data-density={configuration.design.density.toLowerCase()}
      data-motion={configuration.design.motion.toLowerCase()}
    >
      <div className="onboardingPreviewTop">
        <strong>
          {configuration.welcome.logoMediaId
            ? "Custom onboarding logo"
            : platformName}
        </strong>
        <span>Step 1 / 1</span>
      </div>
      <section
        className="onboardingPreviewHero"
        data-decoration={configuration.design.decoration.toLowerCase()}
      >
        {configuration.welcome.heroUrl && (
          <img
            src={configuration.welcome.heroUrl}
            alt={configuration.welcome.heroAlt}
            style={{
              objectFit: configuration.welcome.heroFit,
              objectPosition: `${configuration.welcome.heroFocalX * 100}% ${configuration.welcome.heroFocalY * 100}%`,
            }}
          />
        )}
        <div>
          {configuration.welcome.logoUrl && (
            <img
              className="onboardingPreviewLogo"
              src={configuration.welcome.logoUrl}
              alt={configuration.welcome.logoAlt}
              style={{
                display: "block",
                width: 120,
                height: 42,
                marginBottom: 8,
                objectFit: configuration.welcome.logoFit,
                objectPosition: `${configuration.welcome.logoFocalX * 100}% ${configuration.welcome.logoFocalY * 100}%`,
              }}
            />
          )}
          <p>{configuration.welcome.eyebrow}</p>
          <h3>{title}</h3>
          <span>{configuration.welcome.description}</span>
        </div>
      </section>
      {configuration.blocks
        .filter((block) => block.placement === "BEFORE_ACCOUNT")
        .map((block) => (
          <PreviewBlock key={block.id} block={block} />
        ))}
      {configuration.sections.map((section) => (
        <React.Fragment key={section.id}>
          <article className="onboardingPreviewCard">
            <small>
              <span className="onboardingContentIcon" aria-hidden="true">
                {ONBOARDING_ICON_GLYPHS[section.icon]}
              </span>
              {section.eyebrow || section.id}
            </small>
            <h4>{section.title}</h4>
            <p>{section.description}</p>
            <div className="onboardingPreviewSample">
              {section.id === "ACCOUNT"
                ? "Member name · member@example.test"
                : section.id === "STORES"
                  ? "Official Platform Store · Featured Store"
                  : section.id === "CURRENCY"
                    ? "USD · United States Dollar"
                    : "Introduced by a Friend · Google · Others"}
            </div>
            <small>{section.helpText}</small>
          </article>
          {section.id === "STORES" &&
            configuration.blocks
              .filter((block) => block.placement === "AFTER_STORES")
              .map((block) => <PreviewBlock key={block.id} block={block} />)}
        </React.Fragment>
      ))}
      {configuration.blocks
        .filter((block) => block.placement === "BEFORE_FOOTER")
        .map((block) => (
          <PreviewBlock key={block.id} block={block} />
        ))}
      <footer className="onboardingPreviewFooter">
        <p>{configuration.footer.helpText}</p>
        <button type="button" disabled>
          {configuration.footer.submitLabel}
        </button>
      </footer>
    </div>
  );
}

function PreviewBlock({ block }: { block: OnboardingBlock }) {
  return (
    <article className="onboardingPreviewCard onboardingPreviewOptional">
      <strong>
        {block.kind === "faq" ? (
          block.question
        ) : (
          <>
            {block.kind === "benefit" && (
              <span className="onboardingContentIcon" aria-hidden="true">
                {ONBOARDING_ICON_GLYPHS[block.icon]}
              </span>
            )}
            {block.title}
          </>
        )}
      </strong>
      <p>{block.kind === "faq" ? block.answer : block.body}</p>
    </article>
  );
}
