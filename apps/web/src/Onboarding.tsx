import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./session.js";
import { OnboardingMemberSections } from "./OnboardingMemberSections.js";
import {
  DEFAULT_ONBOARDING_EXPERIENCE,
  type OnboardingAccount,
  type OnboardingBrand,
  type OnboardingCurrency,
  type OnboardingExperience,
  type OnboardingStore,
  type ReferralSource,
} from "./onboarding-experience.js";
import "./Onboarding.css";
import "./OnboardingExperience.css";

type OnboardingData = {
  completed: boolean;
  account?: OnboardingAccount;
  brand?: OnboardingBrand;
  experience?: OnboardingExperience;
  stores?: OnboardingStore[];
  eligibleStoreCount?: number;
  minimumStores?: number;
  currencies?: OnboardingCurrency[];
  defaultCurrency?: string;
  currencyError?: string | null;
  referralSource?: ReferralSource | null;
  referralOther?: string | null;
};
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split("; ").find((value) => value.startsWith("marketplace_csrf="))?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.headers ?? {}) },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401 || response.status === 428) {
      window.location.assign("/?auth=login&returnTo=%2Fonboarding");
      throw new Error(response.status === 401 ? "Your session expired. Sign in again to continue onboarding." : body.error ?? "Sign in again to continue onboarding.");
    }
    throw new Error(body.error ?? "The request could not be completed.");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function Onboarding() {
  const { refreshUser } = useSession();
  const loadGeneration = useRef(0);
  const [data, setData] = useState<OnboardingData | null>(null);
  const [experience, setExperience] = useState<OnboardingExperience>(DEFAULT_ONBOARDING_EXPERIENCE);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState("");
  const [referralSource, setReferralSource] = useState<ReferralSource | "">("");
  const [referralOther, setReferralOther] = useState("");
  const [pendingStore, setPendingStore] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [status, setStatus] = useState("");
  const [failedLogoUrls, setFailedLogoUrls] = useState<string[]>([]);
  const [failedHeroUrls, setFailedHeroUrls] = useState<string[]>([]);

  const load = useCallback(async (isRetry = false) => {
    const generation = ++loadGeneration.current;
    setLoading(!isRetry);
    setRetrying(isRetry);
    setError("");
    try {
      const result = await api<OnboardingData>("/api/onboarding");
      if (generation !== loadGeneration.current) return;
      if (result.completed) { window.location.replace("/"); return; }
      setData(result);
      setExperience(result.experience ?? DEFAULT_ONBOARDING_EXPERIENCE);
      setCurrency(result.defaultCurrency ?? "");
      setReferralSource(result.referralSource ?? "");
      setReferralOther(result.referralOther ?? "");
    } catch (reason) {
      if (generation === loadGeneration.current) setError((reason as Error).message);
    } finally {
      if (generation === loadGeneration.current) { setLoading(false); setRetrying(false); }
    }
  }, []);

  const refreshExperience = useCallback(async () => {
    try {
      const result = await api<{ experience: OnboardingExperience }>("/api/onboarding?view=experience", { cache: "no-store" });
      setExperience(result.experience);
    } catch { /* Keep the last published configuration if a refresh is unavailable. */ }
  }, []);

  useEffect(() => {
    void load();
    const online = () => setOffline(false);
    const offlineNow = () => setOffline(true);
    const refreshOnVisible = () => { if (document.visibilityState === "visible") void refreshExperience(); };
    const timer = window.setInterval(() => void refreshExperience(), 15_000);
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineNow);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      loadGeneration.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offlineNow);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [load, refreshExperience]);

  const storeData = data?.stores;
  const stores = useMemo(() => storeData ?? [], [storeData]);
  const currencies = data?.currencies ?? [];
  const filteredStores = useMemo(() => stores.filter((store) => `${store.name} ${store.description ?? ""} ${store.category ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [stores, search]);
  const selectedCount = stores.filter((store) => store.following).length;
  const enoughStoresExist = (data?.eligibleStoreCount ?? 0) >= 2;
  const canComplete = selectedCount >= 2 && Boolean(currency) && Boolean(referralSource) && !saving && !loading && currencies.length > 0;

  const toggleFollow = async (store: OnboardingStore) => {
    if (!data || pendingStore) return;
    setPendingStore(store.id);
    setError("");
    setStatus("");
    try {
      const result = await api<{ storeId: string; following: boolean }>(`/api/onboarding/stores/${encodeURIComponent(store.id)}/follow`, {
        method: store.following ? "DELETE" : "POST",
        ...(store.following ? {} : { body: "{}" }),
      });
      setData((current) => current ? { ...current, stores: current.stores?.map((item) => item.id === result.storeId ? { ...item, following: result.following } : item) } : current);
      setStatus(result.following ? `Following ${store.name}.` : `Unfollowed ${store.name}.`);
    } catch (reason) {
      const message = (reason as Error).message;
      await load(true);
      setError(message);
    } finally { setPendingStore(""); }
  };

  const complete = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canComplete) return;
    setSaving(true);
    setError("");
    setStatus("Saving your preferences…");
    try {
      await api("/api/onboarding/complete", { method: "POST", body: JSON.stringify({ displayCurrency: currency, referralSource, ...(referralSource === "OTHER" && referralOther.trim() ? { referralOther: referralOther.trim() } : {}) }) });
      setStatus("Your preferences are saved. Taking you to the marketplace…");
      await refreshUser();
      window.location.assign("/");
    } catch (reason) {
      setStatus("");
      const message = (reason as Error).message;
      setError(message);
      if (/currency|store|follow/i.test(message)) { await load(true); setError(message); }
    } finally { setSaving(false); }
  };

  const signOut = async () => {
    setSigningOut(true);
    setError("");
    try { await api("/api/auth/logout", { method: "POST" }); await refreshUser(); window.location.assign("/"); }
    catch (reason) { setError((reason as Error).message); setSigningOut(false); }
  };

  if (loading) return <section className="onboardingPage" aria-busy="true"><p className="eyebrow">Account setup · Step 1 of 1</p><h1>Preparing your welcome…</h1><p className="muted" role="status">Loading your account, eligible stores, and available currencies.</p><div className="onboardingSkeleton" /></section>;
  if (error && !data) return <section className="onboardingPage"><p className="eyebrow">Account setup</p><h1>We couldn’t load onboarding</h1><p className="notice" role="alert">{error}</p>{offline && <p className="muted">You appear to be offline. Reconnect and retry.</p>}<button className="primary" type="button" disabled={retrying} onClick={() => void load(true)}>{retrying ? "Retrying…" : "Try again"}</button></section>;

  const account = data?.account;
  const brand = data?.brand;
  const platformName = brand?.platformName || experience.welcome.platformFallbackName;
  const title = experience.welcome.title.replaceAll("{platformName}", platformName);
  const logoUrl = experience.welcome.logoUrl || brand?.logoUrl;
  const heroUrl = experience.welcome.heroUrl || brand?.bannerUrl;
  const displayedLogoUrl =
    (logoUrl && !failedLogoUrls.includes(logoUrl) ? logoUrl : null) ??
    (brand?.logoUrl && !failedLogoUrls.includes(brand.logoUrl)
      ? brand.logoUrl
      : null);
  const displayedHeroUrl =
    heroUrl && !failedHeroUrls.includes(heroUrl) ? heroUrl : null;
  const designStyle = {
    "--onboarding-primary": experience.design.primaryColor,
    "--onboarding-accent": experience.design.accentColor,
    "--onboarding-surface": experience.design.surfaceColor,
    "--onboarding-text": experience.design.textColor,
  } as React.CSSProperties;

  return (
    <section className={`onboardingPage onboardingDesign-${experience.design.variant.toLowerCase()} onboardingTypography-${experience.design.typography.toLowerCase()} onboardingCards-${experience.design.cardStyle.toLowerCase()} onboardingDensity-${experience.design.density.toLowerCase()}`} style={designStyle} data-decoration={experience.design.decoration.toLowerCase()} data-motion={experience.design.motion.toLowerCase()} aria-labelledby="onboarding-title">
      <header className="onboardingHeader">
        <a className="onboardingBrand" href="/" aria-label={`${platformName} home`}>
          {displayedLogoUrl ? <img className="onboardingExperienceLogo" src={displayedLogoUrl} alt={displayedLogoUrl === logoUrl && experience.welcome.logoMediaId ? experience.welcome.logoAlt : `${platformName} logo`} onError={() => setFailedLogoUrls((current) => [...new Set([...current, displayedLogoUrl])])} style={{ objectFit: experience.welcome.logoFit, objectPosition: `${experience.welcome.logoFocalX * 100}% ${experience.welcome.logoFocalY * 100}%` }} /> : <span className="onboardingBrandFallback">{platformName}</span>}
        </a>
        <div className="onboardingHeaderActions"><span className="onboardingStep">Step 1 <span aria-hidden="true">/</span> 1</span><button type="button" className="onboardingSignOut" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button></div>
      </header>
      <div className={`onboardingHero${displayedHeroUrl ? " hasBanner" : ""}`}>
        {displayedHeroUrl ? <img className="onboardingHeroImage" src={displayedHeroUrl} alt={experience.welcome.heroMediaId ? experience.welcome.heroAlt : ""} onError={() => setFailedHeroUrls((current) => [...new Set([...current, displayedHeroUrl])])} style={{ objectFit: experience.welcome.heroFit, objectPosition: `${experience.welcome.heroFocalX * 100}% ${experience.welcome.heroFocalY * 100}%` }} /> : <div className="onboardingHeroArtwork" aria-hidden="true"><span /><span /><span /></div>}
        <div className="onboardingHeroCopy"><p className="eyebrow">{experience.welcome.eyebrow}</p><h1 id="onboarding-title">{title}</h1><p>{experience.welcome.description || brand?.tagline}</p></div>
      </div>
      <div className="onboardingProgress" aria-label="Onboarding progress"><span className="onboardingProgressTrack"><span /></span><span>Step 1 of 1 · Personalize your marketplace</span></div>
      {error && <p className="notice onboardingNotice" role="alert">{error}</p>}
      {offline && <p className="notice onboardingNotice" role="status">You are offline. Your choices will only be saved after the server confirms them.</p>}
      {status && <p className="onboardingStatus" role="status" aria-live="polite">{status}</p>}
      <form className="onboardingForm" onSubmit={(event) => void complete(event)}>
        <OnboardingMemberSections
          experience={experience}
          account={account}
          stores={stores}
          filteredStores={filteredStores}
          eligibleStoreCount={data?.eligibleStoreCount ?? 0}
          currencies={currencies}
          currency={currency}
          onCurrencyChange={setCurrency}
          referralSource={referralSource}
          onReferralChange={setReferralSource}
          referralOther={referralOther}
          onReferralOtherChange={setReferralOther}
          search={search}
          onSearchChange={setSearch}
          selectedCount={selectedCount}
          enoughStoresExist={enoughStoresExist}
          pendingStore={pendingStore}
          saving={saving}
          retrying={retrying}
          onToggleFollow={(store) => void toggleFollow(store)}
          onRetry={() => void load(true)}
          currencyError={data?.currencyError}
        />
        <footer className="onboardingFooter"><p>{experience.footer.helpText}</p><button className="primary onboardingComplete" type="submit" disabled={!canComplete}>{saving ? "Saving your preferences…" : experience.footer.submitLabel}</button></footer>
      </form>
    </section>
  );
}
