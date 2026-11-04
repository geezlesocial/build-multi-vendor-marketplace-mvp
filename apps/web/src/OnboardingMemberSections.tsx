import React from "react";
import {
  ONBOARDING_ICON_GLYPHS,
  type OnboardingAccount,
  type OnboardingCurrency,
  type OnboardingExperience,
  type OnboardingStore,
  type ReferralSource,
} from "./onboarding-experience.js";

const referralOptions: { value: ReferralSource; label: string }[] = [
  { value: "FRIEND", label: "Introduced by a Friend" },
  { value: "GOOGLE", label: "Google" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "TWITTER_X", label: "Twitter / X" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "SCROLITH", label: "Scrolith" },
  { value: "AI_RECOMMENDATION", label: "AI Recommendation" },
  { value: "OTHER", label: "Others" },
];

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0]?.toLocaleUpperCase() ?? "")
      .join("") || "?"
  );
}

export function OnboardingMemberSections({
  experience,
  account,
  stores,
  filteredStores,
  eligibleStoreCount,
  currencies,
  currency,
  onCurrencyChange,
  referralSource,
  onReferralChange,
  referralOther,
  onReferralOtherChange,
  search,
  onSearchChange,
  selectedCount,
  enoughStoresExist,
  pendingStore,
  saving,
  retrying,
  onToggleFollow,
  onRetry,
  currencyError,
}: {
  experience: OnboardingExperience;
  account?: OnboardingAccount;
  stores: OnboardingStore[];
  filteredStores: OnboardingStore[];
  eligibleStoreCount: number;
  currencies: OnboardingCurrency[];
  currency: string;
  onCurrencyChange: (value: string) => void;
  referralSource: ReferralSource | "";
  onReferralChange: (value: ReferralSource) => void;
  referralOther: string;
  onReferralOtherChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selectedCount: number;
  enoughStoresExist: boolean;
  pendingStore: string;
  saving: boolean;
  retrying: boolean;
  onToggleFollow: (store: OnboardingStore) => void;
  onRetry: () => void;
  currencyError?: string | null;
}) {
  const blocksAt = (
    placement: OnboardingExperience["blocks"][number]["placement"],
  ) => experience.blocks.filter((block) => block.placement === placement);
  const renderBlock = (block: OnboardingExperience["blocks"][number]) => (
    <article
      className={`onboardingOptionalBlock onboardingOptionalBlock-${block.kind}`}
      key={block.id}
    >
      {block.kind === "faq" ? (
        <details>
          <summary>{block.question}</summary>
          <p>{block.answer}</p>
        </details>
      ) : (
        <>
          <strong>
            {block.kind === "benefit" && (
              <span className="onboardingContentIcon" aria-hidden="true">
                {ONBOARDING_ICON_GLYPHS[block.icon]}
              </span>
            )}
            {block.title}
          </strong>
          <p>{block.body}</p>
        </>
      )}
    </article>
  );
  const heading = (
    section: OnboardingExperience["sections"][number],
    id: string,
  ) => (
    <div className="onboardingSectionHeading">
      <div>
        <p className="eyebrow">
          <span className="onboardingContentIcon" aria-hidden="true">
            {ONBOARDING_ICON_GLYPHS[section.icon]}
          </span>
          {section.eyebrow}
        </p>
        <h2 id={id}>{section.title}</h2>
        <p>{section.description}</p>
      </div>
    </div>
  );
  const renderSection = (section: OnboardingExperience["sections"][number]) => {
    if (section.id === "ACCOUNT")
      return (
        <section
          className="onboardingSection onboardingAccount"
          aria-labelledby="onboarding-account-title"
          key={section.id}
        >
          {heading(section, "onboarding-account-title")}
          <div className="onboardingAccountCard">
            {account?.avatarUrl ? (
              <img
                className="onboardingAvatar"
                src={account.avatarUrl}
                alt=""
              />
            ) : (
              <span
                className="onboardingAvatar onboardingAvatarFallback"
                aria-hidden="true"
              >
                {initials(account?.name ?? "")}
              </span>
            )}
            <div>
              <strong>{account?.name}</strong>
              <span>{account?.email}</span>
            </div>
            <small>{section.helpText}</small>
          </div>
        </section>
      );
    if (section.id === "STORES")
      return (
        <section
          className="onboardingSection"
          aria-labelledby="onboarding-stores-title"
          key={section.id}
        >
          <div className="onboardingSectionHeading onboardingStoreHeading">
            <div>
              <p className="eyebrow">
                <span className="onboardingContentIcon" aria-hidden="true">
                  {ONBOARDING_ICON_GLYPHS[section.icon]}
                </span>
                {section.eyebrow}
              </p>
              <h2 id="onboarding-stores-title">{section.title}</h2>
              <p>{section.description}</p>
            </div>
            <div className="onboardingFollowCount" aria-live="polite">
              <strong>
                {selectedCount} of {stores.length}
              </strong>
              <span>selected</span>
            </div>
          </div>
          {!enoughStoresExist && (
            <div className="onboardingEmptyStores" role="status">
              <strong>
                More stores are needed before setup can be completed.
              </strong>
              <p>
                There are {eligibleStoreCount} eligible stores right now; at
                least two are required. A marketplace administrator can review
                store approvals and approved in-stock products in Control Center
                → Sellers &amp; stores.
              </p>
              <button type="button" onClick={onRetry} disabled={retrying}>
                {retrying ? "Checking…" : "Check again"}
              </button>
            </div>
          )}
          {stores.length > 4 && (
            <label className="onboardingStoreSearch">
              Search stores
              <input
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Store name or category"
              />
            </label>
          )}
          {stores.length > 0 && (
            <>
              <div className="onboardingStoreGrid">
                {filteredStores.map((store) => (
                  <article
                    className={`onboardingStoreCard${store.following ? " isFollowing" : ""}${store.isOfficial ? " isOfficial" : ""}`}
                    key={store.id}
                  >
                    <div className="onboardingStoreIdentity">
                      {store.logoUrl ? (
                        <img src={store.logoUrl} alt="" />
                      ) : (
                        <span
                          className="onboardingStoreFallback"
                          aria-hidden="true"
                        >
                          {initials(store.name)}
                        </span>
                      )}
                      <div>
                        <h3>
                          <a href={`/store/${encodeURIComponent(store.slug)}`}>
                            {store.name}
                          </a>
                        </h3>
                        {store.isOfficial && (
                          <span className="onboardingOfficialBadge">
                            Official platform store
                          </span>
                        )}
                        {store.category && (
                          <span className="onboardingStoreCategory">
                            {store.category}
                          </span>
                        )}
                      </div>
                    </div>
                    <p>
                      {store.description?.trim() ||
                        "Explore this independent marketplace store."}
                    </p>
                    <div className="onboardingStoreActions">
                      <small>
                        {store.followerCount.toLocaleString()}{" "}
                        {store.followerCount === 1 ? "follower" : "followers"}
                      </small>
                      <button
                        type="button"
                        aria-pressed={store.following}
                        disabled={pendingStore === store.id || saving}
                        onClick={() => onToggleFollow(store)}
                      >
                        {pendingStore === store.id
                          ? "Saving…"
                          : store.following
                            ? "Following"
                            : "Follow"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {filteredStores.length === 0 && (
                <p className="muted">
                  No recommended stores match that search.
                </p>
              )}
              <p className="onboardingRequirement" role="status">
                {selectedCount >= 2
                  ? "You have enough stores selected."
                  : `Follow ${2 - selectedCount} more ${2 - selectedCount === 1 ? "store" : "stores"} to continue.`}
              </p>
            </>
          )}
          {stores.length === 0 && (
            <div className="empty">
              No currently eligible stores are available. An administrator must
              approve stores with approved in-stock products before onboarding
              can be completed.
            </div>
          )}
          <p className="onboardingSectionHelp">{section.helpText}</p>
        </section>
      );
    if (section.id === "CURRENCY")
      return (
        <section
          className="onboardingSection onboardingPreferences"
          aria-labelledby="onboarding-currency-title"
          key={section.id}
        >
          {heading(section, "onboarding-currency-title")}
          {currencies.length ? (
            <label className="onboardingCurrencySelect">
              Default display currency
              <select
                required
                value={currency}
                onChange={(event) => onCurrencyChange(event.target.value)}
              >
                {currencies.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.code} · {option.name}
                    {option.symbol ? ` (${option.symbol})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="notice" role="alert">
              {currencyError || "No currencies are currently available."}
            </p>
          )}
          <p className="onboardingSectionHelp">{section.helpText}</p>
        </section>
      );
    return (
      <section
        className="onboardingSection"
        aria-labelledby="onboarding-referral-title"
        key={section.id}
      >
        {heading(section, "onboarding-referral-title")}
        <fieldset className="onboardingReferralOptions">
          <legend className="visuallyHidden">
            Select where you heard about the marketplace
          </legend>
          {referralOptions.map((option) => (
            <label
              key={option.value}
              className={referralSource === option.value ? "selected" : ""}
            >
              <input
                type="radio"
                name="referralSource"
                value={option.value}
                required
                checked={referralSource === option.value}
                onChange={() => onReferralChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        {referralSource === "OTHER" && (
          <label className="onboardingOtherSource">
            Optional clarification
            <input
              value={referralOther}
              onChange={(event) =>
                onReferralOtherChange(event.target.value.slice(0, 120))
              }
              maxLength={120}
              placeholder="Tell us a little more (optional)"
            />
            <small>{referralOther.length}/120 characters</small>
          </label>
        )}
        <p className="onboardingSectionHelp">{section.helpText}</p>
      </section>
    );
  };

  return (
    <>
      {blocksAt("BEFORE_ACCOUNT").map(renderBlock)}
      {experience.sections.map((section) => (
        <React.Fragment key={section.id}>
          {renderSection(section)}
          {section.id === "STORES" && blocksAt("AFTER_STORES").map(renderBlock)}
        </React.Fragment>
      ))}
      {blocksAt("BEFORE_FOOTER").map(renderBlock)}
    </>
  );
}
