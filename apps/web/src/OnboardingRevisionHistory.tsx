type Revision = {
  version: number;
  changeNote: string | null;
  createdAt: string;
  editor: { id: string; name: string; email: string };
};

export function OnboardingRevisionHistory({
  revisions,
  draftVersion,
  disabled,
  onRestore,
}: {
  revisions: Revision[];
  draftVersion: number;
  disabled: boolean;
  onRestore: (version: number) => void;
}) {
  return (
    <section className="card cardBody onboardingEditorHistory">
      <p className="eyebrow">Audit history</p>
      <h3>Recent revisions</h3>
      {revisions.length ? (
        <ol>
          {revisions.map((revision) => (
            <li key={revision.version}>
              <div>
                <strong>Version {revision.version}</strong>
                <span>
                  {revision.changeNote || "Onboarding experience updated"} ·{" "}
                  {revision.editor.name} ·{" "}
                  {new Date(revision.createdAt).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                disabled={disabled || revision.version === draftVersion}
                onClick={() => onRestore(revision.version)}
              >
                Restore as draft
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No saved revisions yet.</p>
      )}
    </section>
  );
}
