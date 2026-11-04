import {
  catalogInitials,
  type Brand,
  type CatalogEntity,
  type Category,
  type EntityKind,
  type Feature,
  type ProductType,
} from "./admin-catalog-helpers.js";

type Props = {
  categories: Category[];
  brands: Brand[];
  productTypes: ProductType[];
  features: Feature[];
  search: string;
  busyId: string;
  onEdit: (kind: EntityKind, item: CatalogEntity) => void;
  onStatus: (kind: EntityKind, item: CatalogEntity, status: string) => void;
  onDelete: (kind: EntityKind, item: CatalogEntity) => void;
};

function CatalogAvatar({
  name,
  imageId,
}: {
  name: string;
  imageId?: string | null;
}) {
  return (
    <span className="catalogAvatar" aria-hidden="true">
      <span>{catalogInitials(name)}</span>
      {imageId && (
        <img
          src={`/api/admin/platform/branding-media/${encodeURIComponent(imageId)}/preview`}
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

function CatalogActions({
  kind,
  item,
  busyId,
  onEdit,
  onStatus,
  onDelete,
}: {
  kind: EntityKind;
  item: CatalogEntity;
  busyId: string;
  onEdit: Props["onEdit"];
  onStatus: Props["onStatus"];
  onDelete: Props["onDelete"];
}) {
  const busy = busyId === item.id;
  return (
    <div className="catalogRowActions">
      <button type="button" disabled={busy} onClick={() => onEdit(kind, item)}>
        Edit
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onStatus(kind, item, item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")
        }
      >
        {item.status === "ACTIVE" ? "Deactivate" : "Activate"}
      </button>
      <button
        type="button"
        className="catalogDangerAction"
        disabled={busy}
        onClick={() => onDelete(kind, item)}
      >
        Delete
      </button>
    </div>
  );
}

function CategoryBranch({
  category,
  all,
  level,
  query,
  busyId,
  onEdit,
  onStatus,
  onDelete,
}: {
  category: Category;
  all: Category[];
  level: number;
  query: string;
  busyId: string;
  onEdit: Props["onEdit"];
  onStatus: Props["onStatus"];
  onDelete: Props["onDelete"];
}) {
  const children = all.filter((item) => item.parentId === category.id);
  const text =
    `${category.name} ${category.slug} ${category.status}`.toLocaleLowerCase();
  const childHasMatch = children.some((child) =>
    branchHasMatch(child, all, query),
  );
  if (query && !text.includes(query) && !childHasMatch) return null;
  const row = (
    <div className="catalogTreeRow" data-depth={level}>
      <CatalogAvatar
        name={category.name}
        imageId={
          category.imageUrl?.match(
            /^\/content-media\/([A-Za-z0-9_-]{1,100})$/,
          )?.[1]
        }
      />
      <div className="catalogTreeDetails">
        <strong>{category.name}</strong>
        <span>
          {category.slug} · {category.status.toLowerCase()} ·{" "}
          {category._count?.products ?? 0} products ·{" "}
          {category._count?.children ?? 0} children
        </span>
      </div>
    </div>
  );
  const actions = (
    <CatalogActions
      kind="category"
      item={category}
      busyId={busyId}
      onEdit={onEdit}
      onStatus={onStatus}
      onDelete={onDelete}
    />
  );
  if (!children.length)
    return (
      <article className="catalogTreeLeaf" key={category.id}>
        {row}
        {actions}
      </article>
    );
  return (
    <details
      className="catalogTreeNode"
      key={category.id}
      open={Boolean(query && (text.includes(query) || childHasMatch))}
    >
      <summary>{row}</summary>
      <div className="catalogTreeNodeBody">
        {actions}
        <div className="catalogTreeChildren">
          {children.map((child) => (
            <CategoryBranch
              key={child.id}
              category={child}
              all={all}
              level={level + 1}
              query={query}
              busyId={busyId}
              onEdit={onEdit}
              onStatus={onStatus}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function branchHasMatch(
  category: Category,
  all: Category[],
  query: string,
): boolean {
  if (
    `${category.name} ${category.slug} ${category.status}`
      .toLocaleLowerCase()
      .includes(query)
  )
    return true;
  return all
    .filter((item) => item.parentId === category.id)
    .some((child) => branchHasMatch(child, all, query));
}

function CatalogRecordGroup<T extends CatalogEntity>({
  title,
  kind,
  items,
  search,
  busyId,
  onEdit,
  onStatus,
  onDelete,
  describe,
  avatar,
}: {
  title: string;
  kind: EntityKind;
  items: T[];
  search: string;
  busyId: string;
  onEdit: Props["onEdit"];
  onStatus: Props["onStatus"];
  onDelete: Props["onDelete"];
  describe: (item: T) => string;
  avatar?: (item: T) => string | null | undefined;
}) {
  const records = items.filter((item) =>
    `${item.name} ${item.slug} ${item.status} ${describe(item)}`
      .toLocaleLowerCase()
      .includes(search),
  );
  return (
    <details className="catalogRecordGroup" open={Boolean(search)}>
      <summary>
        <span>{title}</span>
        <span className="catalogCount">{items.length}</span>
        <small>
          {search
            ? `${records.length} match${records.length === 1 ? "" : "es"}`
            : "Open to browse and manage"}
        </small>
      </summary>
      {records.length ? (
        <div className="catalogRecordList" role="list">
          {records.map((item) => (
            <article className="catalogRecordRow" role="listitem" key={item.id}>
              {avatar && (
                <CatalogAvatar name={item.name} imageId={avatar(item)} />
              )}
              <div className="catalogRecordInfo">
                <strong>{item.name}</strong>
                <span>{describe(item)}</span>
              </div>
              <span
                className={`catalogStatus catalogStatus--${item.status.toLowerCase()}`}
              >
                {item.status.toLowerCase()}
              </span>
              <CatalogActions
                kind={kind}
                item={item}
                busyId={busyId}
                onEdit={onEdit}
                onStatus={onStatus}
                onDelete={onDelete}
              />
            </article>
          ))}
        </div>
      ) : (
        <p className="empty catalogListEmpty">
          {search
            ? "No catalog records match this search."
            : "No records have been added yet."}
        </p>
      )}
    </details>
  );
}

export function AdminCatalogLists({
  categories,
  brands,
  productTypes,
  features,
  search,
  busyId,
  onEdit,
  onStatus,
  onDelete,
}: Props) {
  const query = search.trim().toLocaleLowerCase();
  const roots = categories.filter((category) => !category.parentId);
  const visibleRootCount = roots.filter(
    (category) => !query || branchHasMatch(category, categories, query),
  ).length;
  return (
    <div className="catalogRecordGroups">
      <details
        className="catalogRecordGroup catalogCategoryGroup"
        open={Boolean(query)}
      >
        <summary>
          <span>Categories</span>
          <span className="catalogCount">{categories.length}</span>
          <small>
            {query
              ? `${visibleRootCount} matching groups`
              : "Hierarchical catalog · three levels maximum"}
          </small>
        </summary>
        {visibleRootCount ? (
          <div className="catalogCategoryRoots">
            {roots.map((category) => (
              <CategoryBranch
                key={category.id}
                category={category}
                all={categories}
                level={1}
                query={query}
                busyId={busyId}
                onEdit={onEdit}
                onStatus={onStatus}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <p className="empty catalogListEmpty">
            No categories match this search.
          </p>
        )}
      </details>
      <CatalogRecordGroup
        title="Brands"
        kind="brand"
        items={brands}
        search={query}
        busyId={busyId}
        onEdit={onEdit}
        onStatus={onStatus}
        onDelete={onDelete}
        describe={(brand) =>
          `${brand.slug} · ${brand._count?.products ?? 0} products · marketplace-wide`
        }
        avatar={(brand) =>
          brand.imageUrl?.match(
            /^\/content-media\/([A-Za-z0-9_-]{1,100})$/,
          )?.[1]
        }
      />
      <CatalogRecordGroup
        title="Product types"
        kind="productType"
        items={productTypes}
        search={query}
        busyId={busyId}
        onEdit={onEdit}
        onStatus={onStatus}
        onDelete={onDelete}
        describe={(type) =>
          `${type.slug} · ${type.requiresShipping ? "shipping required" : "no shipping"} · ${type._count.products} products · ${type._count.features} features · order ${type.displayOrder}`
        }
      />
      <CatalogRecordGroup
        title="Product features"
        kind="feature"
        items={features}
        search={query}
        busyId={busyId}
        onEdit={onEdit}
        onStatus={onStatus}
        onDelete={onDelete}
        describe={(feature) =>
          `${feature.productType?.name ?? "All product types"} · ${feature.category?.name ?? "All categories"} · ${feature._count.products} products · order ${feature.displayOrder}`
        }
      />
    </div>
  );
}
