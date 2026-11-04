import {
  DEFAULT_ONBOARDING_EXPERIENCE,
  ONBOARDING_ICON_GLYPHS,
  type OnboardingExperience,
  type OnboardingSection,
} from "./onboarding-experience.js";

export function OnboardingSectionsEditor({
  config,
  disabled,
  onChange,
}: {
  config: OnboardingExperience;
  disabled: boolean;
  onChange: (next: OnboardingExperience) => void;
}) {
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= config.sections.length) return;
    const sections = [...config.sections];
    [sections[index], sections[target]] = [sections[target], sections[index]];
    onChange({ ...config, sections });
  };
  const updateSection = (
    id: OnboardingSection["id"],
    field: keyof OnboardingSection,
    value: string,
  ) =>
    onChange({
      ...config,
      sections: config.sections.map((section) =>
        section.id === id ? { ...section, [field]: value } : section,
      ),
    });

  return (
    <section className="card cardBody onboardingEditorCard">
      <div className="onboardingEditorCardHeading">
        <div>
          <p className="eyebrow">Required journey</p>
          <h3>Section copy and order</h3>
          <p className="muted">
            Every required section stays present; use the arrows to reorder its
            presentation.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...config,
              sections: DEFAULT_ONBOARDING_EXPERIENCE.sections.map(
                (section) => ({ ...section }),
              ),
            })
          }
        >
          Reset required sections
        </button>
      </div>
      {config.sections.map((section, index) => (
        <fieldset
          className="onboardingSectionEditor"
          key={section.id}
          disabled={disabled}
        >
          <legend>{section.id.toLowerCase()} step</legend>
          <div className="onboardingEditorOrder">
            <strong>Position {index + 1}</strong>
            <div>
              <button
                type="button"
                aria-label={`Move ${section.title} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${section.title} down`}
                disabled={disabled || index === config.sections.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </div>
          </div>
          <label>
            Eyebrow
            <input
              value={section.eyebrow}
              maxLength={48}
              onChange={(event) =>
                updateSection(section.id, "eyebrow", event.target.value)
              }
            />
          </label>
          <label>
            Heading
            <input
              value={section.title}
              maxLength={100}
              onChange={(event) =>
                updateSection(section.id, "title", event.target.value)
              }
            />
          </label>
          <label>
            Description
            <textarea
              rows={2}
              value={section.description}
              maxLength={320}
              onChange={(event) =>
                updateSection(section.id, "description", event.target.value)
              }
            />
          </label>
          <label>
            Help text
            <input
              value={section.helpText}
              maxLength={240}
              onChange={(event) =>
                updateSection(section.id, "helpText", event.target.value)
              }
            />
          </label>
          <label>
            Icon
            <select
              value={section.icon}
              onChange={(event) =>
                updateSection(section.id, "icon", event.target.value)
              }
            >
              {Object.keys(ONBOARDING_ICON_GLYPHS).map((icon) => (
                <option key={icon} value={icon}>
                  {icon}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      ))}
    </section>
  );
}

export function OnboardingFooterEditor({
  config,
  disabled,
  onChange,
}: {
  config: OnboardingExperience;
  disabled: boolean;
  onChange: (next: OnboardingExperience) => void;
}) {
  return (
    <section className="card cardBody onboardingEditorCard">
      <p className="eyebrow">Completion</p>
      <h3>Action and reassurance</h3>
      <label>
        Footer help text
        <textarea
          rows={2}
          value={config.footer.helpText}
          maxLength={240}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...config,
              footer: { ...config.footer, helpText: event.target.value },
            })
          }
        />
      </label>
      <label>
        Continue button
        <input
          value={config.footer.submitLabel}
          maxLength={80}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...config,
              footer: { ...config.footer, submitLabel: event.target.value },
            })
          }
        />
      </label>
    </section>
  );
}
