import React from "react";

export function PreviousPageButton({ fallbackHref }: { fallbackHref: string }) {
  const goBack = () => {
    const referrer = document.referrer;
    try {
      if (
        window.history.length > 1 &&
        referrer &&
        new URL(referrer).origin === window.location.origin
      ) {
        window.history.back();
        return;
      }
    } catch {
      // An invalid referrer is treated like a direct visit.
    }
    window.location.assign(fallbackHref);
  };

  return (
    <button
      className="workspaceNavigationButton"
      type="button"
      onClick={goBack}
      aria-label="Go back to the previous page"
    >
      Previous page
    </button>
  );
}

export function WorkspaceRouteNavigation({
  dashboardHref,
  dashboardLabel = "Back to dashboard",
}: {
  dashboardHref: string;
  dashboardLabel?: string;
}) {
  return (
    <nav className="workspaceRouteNavigation" aria-label="Workspace navigation">
      <PreviousPageButton fallbackHref={dashboardHref} />
      <a className="workspaceNavigationLink" href={dashboardHref}>
        {dashboardLabel}
      </a>
    </nav>
  );
}

export function DashboardHomeAction({
  onClick,
  label = "Back to dashboard",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      className="workspaceNavigationButton"
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function WorkspaceLoadingPage({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="workspaceLoadingPage" role="status" aria-busy="true">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="muted">{description}</p>
      <div className="workspaceLoadingSkeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
