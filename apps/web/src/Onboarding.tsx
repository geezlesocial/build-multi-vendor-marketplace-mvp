import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from './session.js';
import './Onboarding.css';

type ReferralSource = 'FRIEND' | 'GOOGLE' | 'FACEBOOK' | 'TWITTER_X' | 'LINKEDIN' | 'SCROLITH' | 'AI_RECOMMENDATION' | 'OTHER';
type OnboardingStore = { id: string; name: string; slug: string; description: string | null; isOfficial: boolean; category: string | null; logoUrl: string | null; following: boolean; followerCount: number };
type CurrencyOption = { code: string; name: string; symbol: string };
type OnboardingData = {
  completed: boolean;
  account?: { id: string; name: string; email: string; avatarUrl: string | null };
  brand?: { platformName: string; tagline: string; logoUrl: string | null; bannerUrl: string | null };
  stores?: OnboardingStore[];
  eligibleStoreCount?: number;
  minimumStores?: number;
  currencies?: CurrencyOption[];
  baseCurrency?: string;
  defaultCurrency?: string;
  currencyError?: string | null;
  referralSource?: ReferralSource | null;
  referralOther?: string | null;
};

const referralOptions: { value: ReferralSource; label: string }[] = [
  { value: 'FRIEND', label: 'Introduced by a Friend' },
  { value: 'GOOGLE', label: 'Google' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'TWITTER_X', label: 'Twitter / X' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
  { value: 'SCROLITH', label: 'Scrolith' },
  { value: 'AI_RECOMMENDATION', label: 'AI Recommendation' },
  { value: 'OTHER', label: 'Others' }
];

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401 || response.status === 428) {
      window.location.assign('/?auth=login&returnTo=%2Fonboarding');
      throw new Error(response.status === 401 ? 'Your session expired. Sign in again to continue onboarding.' : body.error ?? 'Sign in again to continue onboarding.');
    }
    throw new Error(body.error ?? 'The request could not be completed.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('') || '?';
}

export function Onboarding() {
  const { refreshUser } = useSession();
  const loadGeneration = useRef(0);
  const [data, setData] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [currency, setCurrency] = useState('');
  const [referralSource, setReferralSource] = useState<ReferralSource | ''>('');
  const [referralOther, setReferralOther] = useState('');
  const [pendingStore, setPendingStore] = useState('');
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [status, setStatus] = useState('');

  const load = async (isRetry = false) => {
    const generation = ++loadGeneration.current;
    setLoading(!isRetry);
    setRetrying(isRetry);
    setError('');
    try {
      const result = await api<OnboardingData>('/api/onboarding');
      if (generation !== loadGeneration.current) return;
      if (result.completed) { window.location.replace('/'); return; }
      setData(result);
      setCurrency(result.defaultCurrency ?? '');
      setReferralSource(result.referralSource ?? '');
      setReferralOther(result.referralOther ?? '');
    } catch (reason) {
      if (generation === loadGeneration.current) setError((reason as Error).message);
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setRetrying(false);
      }
    }
  };

  useEffect(() => {
    void load();
    const online = () => setOffline(false);
    const offlineNow = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineNow);
    return () => { loadGeneration.current += 1; window.removeEventListener('online', online); window.removeEventListener('offline', offlineNow); };
  }, []);

  const filteredStores = useMemo(() => (data?.stores ?? []).filter(store => `${store.name} ${store.description ?? ''} ${store.category ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [data?.stores, search]);
  const selectedCount = (data?.stores ?? []).filter(store => store.following).length;
  const enoughStoresExist = (data?.eligibleStoreCount ?? 0) >= 2;
  const canComplete = selectedCount >= 2 && Boolean(currency) && Boolean(referralSource) && !saving && !loading && Boolean(data?.currencies?.length);

  const toggleFollow = async (store: OnboardingStore) => {
    if (!data || pendingStore) return;
    setPendingStore(store.id);
    setError('');
    setStatus('');
    try {
      const result = await api<{ storeId: string; following: boolean }>(`/api/onboarding/stores/${encodeURIComponent(store.id)}/follow`, {
        method: store.following ? 'DELETE' : 'POST',
        ...(store.following ? {} : { body: '{}' })
      });
      setData(current => current ? { ...current, stores: current.stores?.map(item => item.id === result.storeId ? { ...item, following: result.following } : item) } : current);
      setStatus(result.following ? `Following ${store.name}.` : `Unfollowed ${store.name}.`);
    } catch (reason) {
      const message = (reason as Error).message;
      await load(true);
      setError(message);
    } finally {
      setPendingStore('');
    }
  };

  const complete = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canComplete) return;
    setSaving(true);
    setError('');
    setStatus('Saving your preferences…');
    try {
      await api('/api/onboarding/complete', { method: 'POST', body: JSON.stringify({ displayCurrency: currency, referralSource, ...(referralSource === 'OTHER' && referralOther.trim() ? { referralOther: referralOther.trim() } : {}) }) });
      setStatus('Your preferences are saved. Taking you to the marketplace…');
      await refreshUser();
      window.location.assign('/');
    } catch (reason) {
      setStatus('');
      const message = (reason as Error).message;
      setError(message);
      if (/currency|store|follow/i.test(message)) { await load(true); setError(message); }
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    setError('');
    try {
      await api('/api/auth/logout', { method: 'POST' });
      await refreshUser();
      window.location.assign('/');
    } catch (reason) {
      setError((reason as Error).message);
      setSigningOut(false);
    }
  };

  if (loading) return <section className="onboardingPage" aria-busy="true"><p className="eyebrow">Account setup · Step 1 of 1</p><h1>Preparing your welcome…</h1><p className="muted" role="status">Loading your account, eligible stores, and available currencies.</p><div className="onboardingSkeleton" /></section>;
  if (error && !data) return <section className="onboardingPage"><p className="eyebrow">Account setup</p><h1>We couldn’t load onboarding</h1><p className="notice" role="alert">{error}</p>{offline && <p className="muted">You appear to be offline. Reconnect and retry.</p>}<button className="primary" type="button" disabled={retrying} onClick={() => void load(true)}>{retrying ? 'Retrying…' : 'Try again'}</button></section>;

  const account = data?.account;
  const brand = data?.brand;
  const stores = data?.stores ?? [];
  const currencies = data?.currencies ?? [];

  return <section className="onboardingPage" aria-labelledby="onboarding-title">
    <header className="onboardingHeader">
      <a className="onboardingBrand" href="/" aria-label={`${brand?.platformName ?? 'Marketplace'} home`}>
        {brand?.logoUrl ? <img src={brand.logoUrl} alt={`${brand.platformName} logo`} /> : <span className="onboardingBrandFallback">{brand?.platformName ?? 'Marketplace'}</span>}
      </a>
      <div className="onboardingHeaderActions"><span className="onboardingStep">Step 1 <span aria-hidden="true">/</span> 1</span><button type="button" className="onboardingSignOut" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
    </header>

    <div className={`onboardingHero${brand?.bannerUrl ? ' hasBanner' : ''}`}>
      {brand?.bannerUrl ? <img className="onboardingHeroImage" src={brand.bannerUrl} alt="" /> : <div className="onboardingHeroArtwork" aria-hidden="true"><span /><span /><span /></div>}
      <div className="onboardingHeroCopy"><p className="eyebrow">A more personal marketplace</p><h1 id="onboarding-title">Welcome to {brand?.platformName || 'the Marketplace'}</h1><p>{brand?.tagline || 'Follow a few marketplace stores and choose how you prefer to browse. Your choices can be changed later in account settings.'}</p></div>
    </div>

    <div className="onboardingProgress" aria-label="Onboarding progress"><span className="onboardingProgressTrack"><span /></span><span>Step 1 of 1 · Personalize your marketplace</span></div>
    {error && <p className="notice onboardingNotice" role="alert">{error}</p>}
    {offline && <p className="notice onboardingNotice" role="status">You are offline. Your choices will only be saved after the server confirms them.</p>}
    {status && <p className="onboardingStatus" role="status" aria-live="polite">{status}</p>}

    <form className="onboardingForm" onSubmit={event => void complete(event)}>
      <section className="onboardingSection onboardingAccount" aria-labelledby="onboarding-account-title">
        <div className="onboardingSectionHeading"><div><p className="eyebrow">Your account</p><h2 id="onboarding-account-title">Review your details</h2><p>These are the details you used to create your account.</p></div></div>
        <div className="onboardingAccountCard">
          {account?.avatarUrl ? <img className="onboardingAvatar" src={account.avatarUrl} alt="" /> : <span className="onboardingAvatar onboardingAvatarFallback" aria-hidden="true">{initials(account?.name ?? '')}</span>}
          <div><strong>{account?.name}</strong><span>{account?.email}</span></div>
          <small>You can edit profile details after onboarding.</small>
        </div>
      </section>

      <section className="onboardingSection" aria-labelledby="onboarding-stores-title">
        <div className="onboardingSectionHeading onboardingStoreHeading"><div><p className="eyebrow">Discover marketplace stores</p><h2 id="onboarding-stores-title">Choose stores to follow</h2><p>Follow at least two eligible stores to complete setup. The official platform store is always recommended. You can change your follows later.</p></div><div className="onboardingFollowCount" aria-live="polite"><strong>{selectedCount} of {stores.length}</strong><span>selected</span></div></div>
        {!enoughStoresExist && <div className="onboardingEmptyStores" role="status"><strong>More stores are needed before setup can be completed.</strong><p>There are {data?.eligibleStoreCount ?? 0} eligible stores right now; at least two are required. A marketplace administrator can review store approvals and approved in-stock products in Control Center → Sellers &amp; stores.</p><button type="button" onClick={() => void load(true)} disabled={retrying}>{retrying ? 'Checking…' : 'Check again'}</button></div>}
        {stores.length > 4 && <label className="onboardingStoreSearch">Search stores<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Store name or category" /></label>}
        {stores.length > 0 && <>
          <div className="onboardingStoreGrid">{filteredStores.map(store => <article className={`onboardingStoreCard${store.following ? ' isFollowing' : ''}${store.isOfficial ? ' isOfficial' : ''}`} key={store.id}>
            <div className="onboardingStoreIdentity">{store.logoUrl ? <img src={store.logoUrl} alt="" /> : <span className="onboardingStoreFallback" aria-hidden="true">{initials(store.name)}</span>}<div><h3><a href={`/store/${encodeURIComponent(store.slug)}`}>{store.name}</a></h3>{store.isOfficial && <span className="onboardingOfficialBadge">Official platform store</span>}{store.category && <span className="onboardingStoreCategory">{store.category}</span>}</div></div>
            <p>{store.description?.trim() || 'Explore this independent marketplace store.'}</p>
            <div className="onboardingStoreActions"><small>{store.followerCount.toLocaleString()} {store.followerCount === 1 ? 'follower' : 'followers'}</small><button type="button" aria-pressed={store.following} disabled={pendingStore === store.id || saving} onClick={() => void toggleFollow(store)}>{pendingStore === store.id ? 'Saving…' : store.following ? 'Following' : 'Follow'}</button></div>
          </article>)}</div>
          {filteredStores.length === 0 && <p className="muted">No recommended stores match that search.</p>}
          <p className="onboardingRequirement" role="status">{selectedCount >= 2 ? 'You have enough stores selected.' : `Follow ${2 - selectedCount} more ${2 - selectedCount === 1 ? 'store' : 'stores'} to continue.`}</p>
        </>}
        {stores.length === 0 && <div className="empty">No currently eligible stores are available. An administrator must approve stores with approved in-stock products before onboarding can be completed.</div>}
      </section>

      <section className="onboardingSection onboardingPreferences" aria-labelledby="onboarding-currency-title">
        <div className="onboardingSectionHeading"><div><p className="eyebrow">Your browsing preferences</p><h2 id="onboarding-currency-title">Choose your default currency</h2><p>This sets your default display preference where supported. Product prices, checkout, and payments remain in their existing currencies.</p></div></div>
        {currencies.length ? <label className="onboardingCurrencySelect">Default display currency<select required value={currency} onChange={event => setCurrency(event.target.value)}>{currencies.map(option => <option key={option.code} value={option.code}>{option.code} · {option.name}{option.symbol ? ` (${option.symbol})` : ''}</option>)}</select></label> : <p className="notice" role="alert">{data?.currencyError || 'No currencies are currently available.'}</p>}
      </section>

      <section className="onboardingSection" aria-labelledby="onboarding-referral-title">
        <div className="onboardingSectionHeading"><div><p className="eyebrow">A quick question</p><h2 id="onboarding-referral-title">Where did you hear about us?</h2><p>This helps us understand how people find the marketplace. It does not sign you up for marketing emails.</p></div></div>
        <fieldset className="onboardingReferralOptions"><legend className="visuallyHidden">Select where you heard about the marketplace</legend>{referralOptions.map(option => <label key={option.value} className={referralSource === option.value ? 'selected' : ''}><input type="radio" name="referralSource" value={option.value} required checked={referralSource === option.value} onChange={() => setReferralSource(option.value)} /><span>{option.label}</span></label>)}</fieldset>
        {referralSource === 'OTHER' && <label className="onboardingOtherSource">Optional clarification<input value={referralOther} onChange={event => setReferralOther(event.target.value.slice(0, 120))} maxLength={120} placeholder="Tell us a little more (optional)" /><small>{referralOther.length}/120 characters</small></label>}
      </section>

      <footer className="onboardingFooter"><p>Your referral answer is separate from marketing consent. You can update your currency preference later in settings.</p><button className="primary onboardingComplete" type="submit" disabled={!canComplete}>{saving ? 'Saving your preferences…' : 'Complete onboarding & continue'}</button></footer>
    </form>
  </section>;
}
