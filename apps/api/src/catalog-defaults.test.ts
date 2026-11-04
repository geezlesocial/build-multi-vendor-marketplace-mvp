import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedCatalogDefaults } from "../prisma/catalog-defaults.js";

type Row = {
  id?: string;
  name?: string;
  slug?: string;
  parentId?: string | null;
  status?: string;
  displayOrder?: number;
  defaultKey?: string;
  entityKind?: string;
  [key: string]: unknown;
};

function matches(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "equals" in value) {
      const condition = value as { equals: unknown; mode?: unknown };
      const actual = String(row[key] ?? "");
      const expected = String(condition.equals);
      return condition.mode === "insensitive"
        ? actual.toLocaleLowerCase() === expected.toLocaleLowerCase()
        : actual === expected;
    }
    return row[key] === value;
  });
}

function table() {
  const rows: Row[] = [];
  return {
    rows,
    async findUnique({ where }: { where: Row }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async findFirst({ where }: { where: Row }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async create({ data }: { data: Row }) {
      const row = {
        status: "ACTIVE",
        displayOrder: 0,
        parentId: null,
        ...data,
        id: typeof data.id === "string" ? data.id : `test-${rows.length}`,
      };
      rows.push(row);
      return row;
    },
  };
}

describe("catalog default seed", () => {
  const category = table();
  const brand = table();
  const catalogProductType = table();
  const catalogFeature = table();
  const catalogDefaultSuppression = table();
  const db = {
    category,
    brand,
    catalogProductType,
    catalogFeature,
    catalogDefaultSuppression,
  };

  beforeEach(() => {
    for (const model of Object.values(db)) model.rows.length = 0;
  });

  it("seeds the three-level taxonomy and unique, normalized starter brands idempotently", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedCatalogDefaults(db as never);
    const initialCounts = Object.values(db).map((model) => model.rows.length);

    expect(category.rows.filter((item) => item.parentId === null)).toHaveLength(
      17,
    );
    const byId = new Map(category.rows.map((item) => [item.id, item]));
    for (const item of category.rows) {
      let depth = 1;
      let parentId = item.parentId;
      while (parentId) {
        depth += 1;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      expect(depth).toBeLessThanOrEqual(3);
    }
    expect(brand.rows).toHaveLength(150);
    expect(new Set(brand.rows.map((item) => item.slug)).size).toBe(
      brand.rows.length,
    );
    expect(
      new Set(brand.rows.map((item) => String(item.name).toLocaleLowerCase()))
        .size,
    ).toBe(brand.rows.length);
    expect(brand.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Nestlé", slug: "nestle" }),
        expect.objectContaining({ name: "Nescafé", slug: "nescafe" }),
        expect.objectContaining({
          name: "L’Oréal Paris",
          slug: "loreal-paris",
        }),
      ]),
    );
    expect(catalogProductType.rows).toHaveLength(4);
    expect(catalogFeature.rows.length).toBeGreaterThan(20);

    await seedCatalogDefaults(db as never);
    expect(Object.values(db).map((model) => model.rows.length)).toEqual(
      initialCounts,
    );
    log.mockRestore();
  });

  it("preserves administrator edits and records removals of seeded brands across later runs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedCatalogDefaults(db as never);
    const apple = brand.rows.find(
      (item) => item.id === "catalog-default-brand-apple",
    );
    expect(apple).toBeDefined();
    apple!.name = "Apple marketplace display name";
    apple!.slug = "apple-marketplace-display-name";
    apple!.status = "INACTIVE";

    const removed = brand.rows.findIndex(
      (item) => item.id === "catalog-default-brand-google",
    );
    brand.rows.splice(removed, 1);
    catalogDefaultSuppression.rows.push({
      defaultKey: "catalog-default-brand-google",
      entityKind: "brand",
    });
    await seedCatalogDefaults(db as never);

    expect(brand.rows).toContainEqual(
      expect.objectContaining({
        id: apple!.id,
        name: "Apple marketplace display name",
        slug: "apple-marketplace-display-name",
        status: "INACTIVE",
      }),
    );
    expect(
      brand.rows.some((item) => item.id === "catalog-default-brand-google"),
    ).toBe(false);
    log.mockRestore();
  });

  it("preserves inactive category defaults and keeps new descendants inactive", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    category.rows.push({
      id: "catalog-default-category-electronics-technology",
      name: "Electronics & Technology",
      slug: "electronics-technology",
      parentId: null,
      status: "INACTIVE",
    });

    await seedCatalogDefaults(db as never);

    expect(
      category.rows.find(
        (item) => item.id === "catalog-default-category-electronics-technology",
      )?.status,
    ).toBe("INACTIVE");
    expect(
      category.rows.find(
        (item) =>
          item.id ===
          "catalog-default-category-electronics-technology-mobile-phones-accessories",
      )?.status,
    ).toBe("INACTIVE");
    log.mockRestore();
  });
});
