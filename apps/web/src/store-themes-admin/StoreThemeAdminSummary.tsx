import type { AdminData } from "./types.js";

type StoreThemeAdminSummaryProps = {
  data: AdminData;
  reason: string;
  busy: boolean;
  onReasonChange: (reason: string) => void;
  onSave: () => void;
};

export function StoreThemeAdminSummary({
  data,
  reason,
  busy,
  onReasonChange,
  onSave,
}: StoreThemeAdminSummaryProps) {
  return (
    <>
      <section className="card cardBody themeAdminSave">
        <h3>Publish safe catalog defaults</h3>
        <p className="muted">
          Text contrast is validated at 4.5:1 against card and surface colors.
          The three paid templates remain inaccessible to free or legacy sellers
          regardless of catalog order.
        </p>
        <label>
          Audit reason
          <input
            value={reason}
            maxLength={500}
            minLength={5}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </label>
        <button
          className="primary"
          type="button"
          disabled={busy || reason.trim().length < 5}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save catalog configuration"}
        </button>
      </section>
      <section className="themeAdminUsage">
        <h3>Published theme assignments</h3>
        <p className="muted">
          Counts show saved published presets; an inactive premium subscription
          is still rendered publicly with the free Classic fallback and is not
          deleted.
        </p>
        {data.stores.length ? (
          <div className="table">
            {data.stores.map((store) => (
              <div className="row" key={store.id}>
                <strong>
                  {store.name}
                  {store.isPlatformStore ? " · Official platform Store" : ""}
                </strong>
                <span>
                  {store.themePreset
                    ? String(store.themePreset).replaceAll("_", " ")
                    : "Default Classic"}
                </span>
                <span>
                  {store.publishedAt
                    ? new Date(store.publishedAt).toLocaleDateString()
                    : "Not published"}
                </span>
                <a href={`/store/${encodeURIComponent(store.slug)}`}>
                  View Store
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">
            No approved Stores have published a custom theme.
          </p>
        )}
      </section>
      <section className="themeRevisionList themeAdminHistory">
        <h3>Catalog audit history</h3>
        {data.history.length ? (
          data.history.map((entry) => (
            <article key={entry.id}>
              <div>
                <strong>
                  {entry.actor?.name || entry.actor?.email || "Administrator"} ·{" "}
                  {entry.metadata?.reason || "Catalog configuration updated"}
                </strong>
                <small>{new Date(entry.createdAt).toLocaleString()}</small>
              </div>
              <span>
                {entry.metadata?.config?.displayOrder?.length ?? 0} themes
                retained
              </span>
            </article>
          ))
        ) : (
          <p className="empty">Catalog changes will be recorded here.</p>
        )}
      </section>
      <p>
        <a href="/admin/platform?section=plans">
          Manage Store Plan theme availability
        </a>
      </p>
    </>
  );
}
