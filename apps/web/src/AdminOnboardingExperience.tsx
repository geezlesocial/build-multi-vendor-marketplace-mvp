import React, { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_ONBOARDING_EXPERIENCE,
  type OnboardingExperience,
  type OnboardingSection,
} from "./onboarding-experience.js";
import { OnboardingExperiencePreview } from "./OnboardingExperiencePreview.js";
import { OnboardingOptionalBlocksEditor } from "./OnboardingOptionalBlocksEditor.js";
import {
  OnboardingDesignEditor,
  OnboardingWelcomeEditor,
} from "./OnboardingWelcomeDesignEditors.js";
import {
  OnboardingFooterEditor,
  OnboardingSectionsEditor,
} from "./OnboardingSectionsEditor.js";
import { OnboardingRevisionHistory } from "./OnboardingRevisionHistory.js";
import "./AdminOnboardingExperience.css";

type Revision = {
  version: number;
  changeNote: string | null;
  createdAt: string;
  editor: { id: string; name: string; email: string };
};
type EditorState = {
  draft: OnboardingExperience;
  published: OnboardingExperience | null;
  draftVersion: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  revisions: Revision[];
};
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? "Onboarding settings could not be saved.");
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function AdminOnboardingExperience() {
  const [state, setState] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [resetFieldPath, setResetFieldPath] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setState(await request<EditorState>("/api/admin/onboarding/experience"));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Onboarding settings could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const update = (draft: OnboardingExperience) =>
    setState((current) => (current ? { ...current, draft } : current));

  const resetOneField = () => {
    if (!state || !resetFieldPath) return;
    const [group, key, field] = resetFieldPath.split(".");
    if (group === "welcome" && key) {
      update({
        ...state.draft,
        welcome: {
          ...state.draft.welcome,
          [key]:
            DEFAULT_ONBOARDING_EXPERIENCE.welcome[
              key as keyof typeof DEFAULT_ONBOARDING_EXPERIENCE.welcome
            ],
        },
      });
    } else if (group === "design" && key) {
      update({
        ...state.draft,
        design: {
          ...state.draft.design,
          [key]:
            DEFAULT_ONBOARDING_EXPERIENCE.design[
              key as keyof typeof DEFAULT_ONBOARDING_EXPERIENCE.design
            ],
        },
      });
    } else if (group === "sections" && key && field) {
      const id = key as OnboardingSection["id"];
      const sectionField = field as keyof OnboardingSection;
      const baseline = DEFAULT_ONBOARDING_EXPERIENCE.sections.find(
        (item) => item.id === id,
      );
      if (!baseline) return;
      update({
        ...state.draft,
        sections: state.draft.sections.map((item) =>
          item.id === id
            ? { ...item, [sectionField]: baseline[sectionField] }
            : item,
        ),
      });
    } else if (group === "footer" && key) {
      update({
        ...state.draft,
        footer: {
          ...state.draft.footer,
          [key]:
            DEFAULT_ONBOARDING_EXPERIENCE.footer[
              key as keyof typeof DEFAULT_ONBOARDING_EXPERIENCE.footer
            ],
        },
      });
    }
    setMessage("That field was restored in the private draft preview.");
  };

  const runAction = async (
    action: () => Promise<unknown>,
    success: string,
    fallback: string,
  ) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!state) return;
    return runAction(
      () =>
        request("/api/admin/onboarding/experience/draft", {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: state.draftVersion,
            configuration: state.draft,
          }),
        }),
      "Draft saved. It is not visible to members until you publish it.",
      "Draft could not be saved.",
    );
  };
  const publish = () => {
    if (
      !state ||
      !window.confirm(
        "Publish this onboarding experience? Only approved images will become visible to members.",
      )
    )
      return;
    return runAction(
      () =>
        request("/api/admin/onboarding/experience/publish", {
          method: "POST",
          body: JSON.stringify({ expectedVersion: state.draftVersion }),
        }),
      "Onboarding experience published for new and in-progress members.",
      "The draft could not be published.",
    );
  };
  const reset = () => {
    if (
      !state ||
      !window.confirm(
        "Reset the editor to the default onboarding experience? This saves a new draft; it does not publish it.",
      )
    )
      return;
    return runAction(
      () =>
        request("/api/admin/onboarding/experience/reset", {
          method: "POST",
          body: JSON.stringify({ expectedVersion: state.draftVersion }),
        }),
      "Default experience saved as a draft.",
      "The default draft could not be restored.",
    );
  };
  const restore = (version: number) => {
    if (
      !state ||
      !window.confirm(
        `Restore revision ${version} as a new draft? The published experience will stay unchanged.`,
      )
    )
      return;
    return runAction(
      () =>
        request(
          `/api/admin/onboarding/experience/revisions/${version}/restore`,
          {
            method: "POST",
            body: JSON.stringify({ expectedVersion: state.draftVersion }),
          },
        ),
      `Revision ${version} restored as a new draft.`,
      "The revision could not be restored.",
    );
  };

  if (loading)
    return (
      <section
        className="card cardBody adminOnboardingExperience"
        aria-busy="true"
      >
        <p role="status">Loading onboarding experience…</p>
      </section>
    );
  if (!state)
    return (
      <section className="card cardBody adminOnboardingExperience">
        <h2>Onboarding experience editor</h2>
        <p className="notice" role="alert">
          {error || "Onboarding settings are unavailable."}
        </p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </section>
    );

  const config = state.draft;
  const baseline = state.published ?? DEFAULT_ONBOARDING_EXPERIENCE;
  const changedAreas = (
    ["welcome", "design", "sections", "blocks", "footer"] as const
  ).filter(
    (area) => JSON.stringify(config[area]) !== JSON.stringify(baseline[area]),
  );
  const resettableFields: [string, string][] = [
    ...Object.keys(DEFAULT_ONBOARDING_EXPERIENCE.welcome)
      .filter((key) => !key.endsWith("Url"))
      .map((key): [string, string] => [`welcome.${key}`, `Welcome - ${key}`]),
    ...Object.keys(DEFAULT_ONBOARDING_EXPERIENCE.design).map(
      (key): [string, string] => [`design.${key}`, `Design - ${key}`],
    ),
    ...DEFAULT_ONBOARDING_EXPERIENCE.sections.flatMap((section) =>
      ["eyebrow", "title", "description", "helpText", "icon"].map(
        (field): [string, string] => [
          `sections.${section.id}.${field}`,
          `${section.id} - ${field}`,
        ],
      ),
    ),
    ...Object.keys(DEFAULT_ONBOARDING_EXPERIENCE.footer).map(
      (key): [string, string] => [`footer.${key}`, `Footer - ${key}`],
    ),
  ];
  const previewConfiguration: OnboardingExperience = {
    ...config,
    welcome: {
      ...config.welcome,
      logoUrl: config.welcome.logoMediaId
        ? `/api/admin/platform/onboarding-media/${encodeURIComponent(config.welcome.logoMediaId)}/preview`
        : null,
      heroUrl: config.welcome.heroMediaId
        ? `/api/admin/platform/onboarding-media/${encodeURIComponent(config.welcome.heroMediaId)}/preview`
        : null,
    },
  };

  return (
    <section
      className="adminOnboardingExperience"
      aria-labelledby="onboarding-experience-title"
    >
      <header className="card cardBody onboardingEditorHeader">
        <div>
          <p className="eyebrow">Member journey · Admin managed</p>
          <h2 id="onboarding-experience-title">Onboarding experience</h2>
          <p className="muted">
            Edit the welcome journey, required step copy, visual system, and
            optional trust content. Required setup steps and server-side
            completion rules cannot be removed or changed here.
          </p>
        </div>
        <div className="onboardingEditorBadges">
          <span>Draft v{state.draftVersion}</span>
          <span>
            {state.publishedVersion
              ? `Published v${state.publishedVersion}`
              : "Using platform defaults"}
          </span>
        </div>
        <p className="muted onboardingDiffSummary" aria-live="polite">
          {changedAreas.length
            ? `Draft differs from the public baseline in: ${changedAreas.join(", ")}.`
            : "Draft matches the current public baseline."}
        </p>
      </header>
      {error && (
        <div className="notice onboardingEditorError" role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Reload the latest saved version? Unsaved preview changes will be discarded.",
                )
              )
                void load();
            }}
          >
            Reload latest saved version
          </button>
        </div>
      )}
      {message && (
        <p className="onboardingEditorStatus" role="status" aria-live="polite">
          {message}
        </p>
      )}
      <section
        className="card cardBody onboardingSingleFieldReset"
        aria-label="Restore one field"
      >
        <label>
          Restore one field to its safe default
          <select
            value={resetFieldPath}
            onChange={(event) => setResetFieldPath(event.target.value)}
          >
            <option value="">Choose a field</option>
            {resettableFields.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !resetFieldPath}
          onClick={resetOneField}
        >
          Restore field
        </button>
      </section>
      <div className="onboardingEditorGrid">
        <div className="onboardingEditorControls">
          <OnboardingWelcomeEditor
            config={config}
            published={state.published}
            disabled={busy}
            onChange={update}
          />
          <OnboardingDesignEditor
            config={config}
            disabled={busy}
            onChange={update}
          />
          <OnboardingSectionsEditor
            config={config}
            disabled={busy}
            onChange={update}
          />
          <OnboardingOptionalBlocksEditor
            config={config}
            disabled={busy}
            onChange={update}
          />
          <OnboardingFooterEditor
            config={config}
            disabled={busy}
            onChange={update}
          />
        </div>
        <aside className="card cardBody onboardingEditorPreview">
          <div className="onboardingEditorCardHeading">
            <div>
              <p className="eyebrow">Live preview</p>
              <h3>Member onboarding</h3>
            </div>
            <div className="onboardingPreviewToggle">
              <button
                type="button"
                aria-pressed={!mobilePreview}
                onClick={() => setMobilePreview(false)}
              >
                Desktop
              </button>
              <button
                type="button"
                aria-pressed={mobilePreview}
                onClick={() => setMobilePreview(true)}
              >
                Mobile
              </button>
            </div>
          </div>
          <OnboardingExperiencePreview
            configuration={previewConfiguration}
            mobile={mobilePreview}
          />
          <p className="muted">
            Preview uses sample member and store content. Real eligibility and
            completion requirements remain enforced by the server.
          </p>
        </aside>
      </div>
      <section className="card cardBody onboardingEditorActions">
        <div>
          <strong>Publishing</strong>
          <p className="muted">
            Save creates a versioned private draft. Publish is explicit and only
            approved, scanned images can go live.
          </p>
          <small>
            Current public version:{" "}
            {state.publishedVersion ?? "platform defaults"}
            {state.publishedAt
              ? ` · ${new Date(state.publishedAt).toLocaleString()}`
              : ""}
          </small>
        </div>
        <div>
          <button type="button" disabled={busy} onClick={() => void reset()}>
            Reset all to default
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save draft"}
          </button>
          <button type="button" disabled={busy} onClick={() => void publish()}>
            {busy ? "Working…" : "Publish experience"}
          </button>
        </div>
      </section>
      <OnboardingRevisionHistory
        revisions={state.revisions}
        draftVersion={state.draftVersion}
        disabled={busy}
        onRestore={(version) => void restore(version)}
      />
    </section>
  );
}
