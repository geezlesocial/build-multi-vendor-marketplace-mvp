import React, { useEffect, useState } from 'react';

type Readiness = { eligibleStoreCount: number; minimumStores: number; ready: boolean; availableCurrencyCount: number; pendingAccountCount: number };

export function AdminOnboardingReadiness() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/onboarding/readiness', { credentials: 'include' });
      const body = await response.json().catch(() => ({})) as Readiness & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Onboarding readiness could not be checked.');
      setData(body);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  return <section className="card cardBody adminOnboardingReadiness" aria-labelledby="admin-onboarding-readiness-title">
    <p className="eyebrow">New member experience</p><h2 id="admin-onboarding-readiness-title">Onboarding readiness</h2>
    {loading ? <p role="status">Checking eligible stores and currencies…</p> : error ? <div className="notice" role="alert">{error}<button type="button" onClick={() => void load()}>Retry</button></div> : data && <>
      <div className="heroPills"><span>{data.eligibleStoreCount} eligible stores · {data.minimumStores} required</span><span>{data.availableCurrencyCount} display currencies</span><span>{data.pendingAccountCount} accounts awaiting onboarding</span></div>
      {data.ready ? <p className="muted">New members can complete onboarding with the current store and currency configuration.</p> : <div className="notice" role="alert"><strong>New member onboarding is blocked.</strong> {data.eligibleStoreCount < data.minimumStores ? 'Approve eligible sellers and ensure their stores have approved, in-stock products.' : 'Enable at least one display currency in Currency catalog & FX.'}</div>}
      <div className="toolbar"><a href="/admin/platform?section=vendors">Review sellers &amp; stores</a><a href="/admin/currencies">Review currency catalog</a><button type="button" onClick={() => void load()}>Refresh readiness</button></div>
    </>}
  </section>;
}
