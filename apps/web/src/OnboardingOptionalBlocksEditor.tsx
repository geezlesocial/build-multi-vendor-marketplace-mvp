import {
  ONBOARDING_ICON_GLYPHS,
  type OnboardingBlock,
  type OnboardingExperience,
} from "./onboarding-experience.js";

export function OnboardingOptionalBlocksEditor({
  config,
  onChange,
  disabled,
}: {
  config: OnboardingExperience;
  onChange: (next: OnboardingExperience) => void;
  disabled: boolean;
}) {
  const updateBlock = (
    id: string,
    transform: (block: OnboardingBlock) => OnboardingBlock,
  ) =>
    onChange({
      ...config,
      blocks: config.blocks.map((block) =>
        block.id === id ? transform(block) : block,
      ),
    });

  const resetBlock = (block: OnboardingBlock) => {
    updateBlock(block.id, () => {
      if (block.kind === "faq")
        return {
          id: block.id,
          kind: "faq",
          question: "A common question",
          answer: "Add a clear, accurate answer.",
          placement: block.placement,
        };
      if (block.kind === "trust")
        return {
          id: block.id,
          kind: "trust",
          title: "Shop with confidence",
          body: "Add a short reassurance for new members.",
          placement: block.placement,
        };
      return {
        id: block.id,
        kind: "benefit",
        title: "Discover more",
        body: "Explain a useful marketplace benefit.",
        icon: "spark",
        placement: block.placement,
      };
    });
  };

  const add = (kind: OnboardingBlock["kind"]) => {
    const id = crypto.randomUUID();
    const block: OnboardingBlock =
      kind === "faq"
        ? {
            id,
            kind,
            question: "A common question",
            answer: "Add a clear, accurate answer.",
            placement: "AFTER_STORES",
          }
        : kind === "trust"
          ? {
              id,
              kind,
              title: "Shop with confidence",
              body: "Add a short reassurance for new members.",
              placement: "AFTER_STORES",
            }
          : {
              id,
              kind,
              title: "Discover more",
              body: "Explain a useful marketplace benefit.",
              icon: "spark",
              placement: "AFTER_STORES",
            };
    onChange({ ...config, blocks: [...config.blocks, block] });
  };

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= config.blocks.length) return;
    const blocks = [...config.blocks];
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    onChange({ ...config, blocks });
  };

  return (
    <section className="card cardBody onboardingEditorCard">
      <div className="onboardingEditorCardHeading">
        <div>
          <p className="eyebrow">Optional content</p>
          <h3>Benefits, trust notes, and FAQs</h3>
          <p className="muted">
            Plain text only; optional content never affects account rules.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...config, blocks: [] })}
        >
          Remove all optional blocks
        </button>
      </div>
      <div className="onboardingEditorAddBlock">
        {(["benefit", "trust", "faq"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={disabled || config.blocks.length >= 8}
            onClick={() => add(kind)}
          >
            Add{" "}
            {kind === "faq"
              ? "FAQ"
              : kind === "trust"
                ? "trust note"
                : "benefit"}
          </button>
        ))}
        <small>Up to eight optional blocks.</small>
      </div>
      {config.blocks.map((block, index) => (
        <fieldset
          className="onboardingSectionEditor"
          key={block.id}
          disabled={disabled}
        >
          <legend>
            {block.kind} block {index + 1}
          </legend>
          <div className="onboardingEditorOrder">
            <strong>Position {index + 1}</strong>
            <div>
              <button
                type="button"
                aria-label={`Move optional block ${index + 1} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move optional block ${index + 1} down`}
                disabled={disabled || index === config.blocks.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => resetBlock(block)}
            >
              Reset block
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...config,
                  blocks: config.blocks.filter((item) => item.id !== block.id),
                })
              }
            >
              Remove
            </button>
          </div>
          <label>
            Placement
            <select
              value={block.placement}
              onChange={(event) =>
                updateBlock(block.id, (item) => ({
                  ...item,
                  placement: event.target.value as OnboardingBlock["placement"],
                }))
              }
            >
              <option value="BEFORE_ACCOUNT">Before account step</option>
              <option value="AFTER_STORES">After store discovery</option>
              <option value="BEFORE_FOOTER">Before completion button</option>
            </select>
          </label>
          {block.kind === "benefit" && (
            <label>
              Icon
              <select
                value={block.icon}
                onChange={(event) =>
                  updateBlock(block.id, (item) =>
                    item.kind === "benefit"
                      ? {
                          ...item,
                          icon: event.target.value as Extract<
                            OnboardingBlock,
                            { kind: "benefit" }
                          >["icon"],
                        }
                      : item,
                  )
                }
              >
                {Object.keys(ONBOARDING_ICON_GLYPHS).map((icon) => (
                  <option key={icon} value={icon}>
                    {icon}
                  </option>
                ))}
              </select>
            </label>
          )}
          {block.kind === "faq" ? (
            <>
              <label>
                Question
                <input
                  value={block.question}
                  maxLength={180}
                  onChange={(event) =>
                    updateBlock(block.id, (item) =>
                      item.kind === "faq"
                        ? { ...item, question: event.target.value }
                        : item,
                    )
                  }
                />
              </label>
              <label>
                Answer
                <textarea
                  rows={2}
                  value={block.answer}
                  maxLength={600}
                  onChange={(event) =>
                    updateBlock(block.id, (item) =>
                      item.kind === "faq"
                        ? { ...item, answer: event.target.value }
                        : item,
                    )
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label>
                Title
                <input
                  value={block.title}
                  maxLength={100}
                  onChange={(event) =>
                    updateBlock(block.id, (item) =>
                      item.kind !== "faq"
                        ? { ...item, title: event.target.value }
                        : item,
                    )
                  }
                />
              </label>
              <label>
                Body
                <textarea
                  rows={2}
                  value={block.body}
                  maxLength={320}
                  onChange={(event) =>
                    updateBlock(block.id, (item) =>
                      item.kind !== "faq"
                        ? { ...item, body: event.target.value }
                        : item,
                    )
                  }
                />
              </label>
            </>
          )}
        </fieldset>
      ))}
    </section>
  );
}
