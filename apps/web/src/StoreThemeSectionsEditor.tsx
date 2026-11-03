import type { Dispatch, SetStateAction } from "react";
import type { Theme, ThemeProductOption } from "./store-theme-types.js";

const sectionOptions: {
  type: Theme["sections"][number]["type"];
  title: string;
}[] = [
  { type: "featuredProducts", title: "Featured products" },
  { type: "categories", title: "Category highlights" },
  { type: "productCollection", title: "Curated collection" },
  { type: "promotion", title: "Promotional content" },
  { type: "brandHighlights", title: "Brand and feature highlights" },
];

export function StoreThemeSectionsEditor({
  theme,
  setTheme,
  availableProducts,
}: {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  availableProducts: ThemeProductOption[];
}) {
  const setSection = (
    type: Theme["sections"][number]["type"],
    visible: boolean,
  ) =>
    setTheme((current) => {
      const existing = current.sections.find(
        (section) => section.type === type,
      );
      const next = existing
        ? current.sections.map((section) =>
            section.type === type ? { ...section, visible } : section,
          )
        : [
            ...current.sections,
            {
              type,
              title:
                sectionOptions.find((item) => item.type === type)?.title ??
                type,
              productIds: [],
              categorySlug: null,
              visible,
            },
          ];
      return { ...current, sections: next };
    });
  const updateSection = (
    type: Theme["sections"][number]["type"],
    values: Partial<Theme["sections"][number]>,
  ) =>
    setTheme((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.type === type ? { ...section, ...values } : section,
      ),
    }));
  const moveSection = (index: number, delta: number) =>
    setTheme((current) => {
      const sections = [...current.sections];
      const target = index + delta;
      if (target < 0 || target >= sections.length) return current;
      [sections[index], sections[target]] = [
        sections[target]!,
        sections[index]!,
      ];
      return { ...current, sections };
    });

  return (
    <fieldset className="themeSectionsEditor">
      <legend>Sections · visibility, content and ordering</legend>
      {sectionOptions.map((option) => {
        const index = theme.sections.findIndex(
          (section) => section.type === option.type,
        );
        const section = index >= 0 ? theme.sections[index] : null;
        const categories = [
          ...new Map(
            availableProducts.flatMap((product) =>
              product.category
                ? [[product.category.slug, product.category.name] as const]
                : [],
            ),
          ).entries(),
        ];
        return (
          <div className="themeSectionEditor" key={option.type}>
            <div className="themeSectionRow">
              <label>
                <input
                  type="checkbox"
                  checked={section?.visible ?? false}
                  onChange={(event) =>
                    setSection(option.type, event.target.checked)
                  }
                />
                {option.title}
              </label>
              {section && (
                <div>
                  <button
                    type="button"
                    aria-label={`Move ${option.title} up`}
                    disabled={index === 0}
                    onClick={() => moveSection(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${option.title} down`}
                    disabled={index === theme.sections.length - 1}
                    onClick={() => moveSection(index, 1)}
                  >
                    ↓
                  </button>
                </div>
              )}
            </div>
            {section?.visible && (
              <div className="themeSectionOptions">
                <label>
                  Section heading
                  <input
                    maxLength={120}
                    value={section.title}
                    onChange={(event) =>
                      updateSection(option.type, { title: event.target.value })
                    }
                  />
                </label>
                {(option.type === "featuredProducts" ||
                  option.type === "productCollection") && (
                  <label>
                    Approved products (optional; choose up to 50)
                    <select
                      multiple
                      size={Math.min(6, Math.max(3, availableProducts.length))}
                      value={section.productIds}
                      onChange={(event) =>
                        updateSection(option.type, {
                          productIds: Array.from(
                            event.currentTarget.selectedOptions,
                          )
                            .slice(0, 50)
                            .map((selected) => selected.value),
                        })
                      }
                    >
                      {availableProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                          {product.category
                            ? ` · ${product.category.name}`
                            : ""}
                        </option>
                      ))}
                    </select>
                    <small className="muted">
                      No selection uses current approved listings. Removed or
                      unapproved listings are never displayed.
                    </small>
                  </label>
                )}
                {option.type === "productCollection" && (
                  <label>
                    Limit collection to category
                    <select
                      value={section.categorySlug ?? ""}
                      onChange={(event) =>
                        updateSection(option.type, {
                          categorySlug: event.target.value || null,
                        })
                      }
                    >
                      <option value="">All categories</option>
                      {categories.map(([categorySlug, name]) => (
                        <option key={categorySlug} value={categorySlug}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
