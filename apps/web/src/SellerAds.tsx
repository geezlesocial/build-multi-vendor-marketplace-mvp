import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatMinor } from './money.js';
import { productMediaKindForFile, uploadContentType, uploadToSignedPostWithType } from './media-upload.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Media = { id: string; originalName: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; scanStatus: string; uploadStatus: string };
type BudgetCurrency = { code: string; name: string; symbol: string; minorUnitExponent: number; platformToCurrencyRate: string };
type Country = { code: string; name: string };
type Product = { id: string; name: string; status: string; inventory?: { quantity: number } | null };
type AdCampaign = {
  id: string; name: string; headline: string | null; adDescription: string | null; status: string; sponsored: boolean;
  billingModel: string | null; audience: string | null; targetCountryCodes: string[]; durationDays: number | null;
  dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; monthlyBudgetMinor: number; budgetCurrency: string | null; budgetTotalMinor: number | null;
  startsAt: string | null; endsAt: string | null;
  creatives: { mediaAsset: Media }[]; products: { product: { name: string } }[];
  metrics: { impressions: number; clicks: number; spendMinor: number }[];
};
type AdsData = {
  store: { name: string; slug: string }; enabledForPlan: boolean; sponsoredAvailable: boolean; currency: string; minorUnitExponent: number;
  pricePerClickMinor: number; pricePer100ViewsMinor: number; minimumCampaignUsdMinor: number; usdMinorUnitExponent: number; maxCampaignDurationDays: number;
  monthlyBudgetCapMinor: number; adBalance: { availableMinor: number; status: string }; budgetCurrencies: BudgetCurrency[]; countries: Country[]; campaigns: AdCampaign[]; message: string;
};
type Estimate = { budgetTotalMinor: number; budgetCurrency: string; lifetimeBudgetBaseMinor: number; monthlyBudgetBaseMinor: number; usdEquivalentMinor: number; minimumCampaignUsdMinor: number; eligible: boolean; withinMonthlyCap: boolean; budgetFitsBalance: boolean; monthlyBudgetCapMinor: number; platformCurrency: string };
type MediaResponse = { assets: Media[] };
type DashboardData = { products: Product[] };

function parseMinor(value: string, exponent: number): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d*)?$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > exponent) return null;
  const result = BigInt(whole) * (10n ** BigInt(exponent)) + BigInt((fraction || '').padEnd(exponent, '0') || '0');
  return result > 2_000_000_000n ? null : Number(result);
}

export function SellerAds() {
  const [data, setData] = useState<AdsData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [assets, setAssets] = useState<Media[]>([]);
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [productId, setProductId] = useState('');
  const [billingModel, setBillingModel] = useState<'CPC' | 'CPV'>('CPC');
  const [audience, setAudience] = useState<'BUYERS' | 'SELLERS' | 'BOTH'>('BUYERS');
  const [allCountries, setAllCountries] = useState(true);
  const [countryCodes, setCountryCodes] = useState<string[]>([]);
  const [budgetCurrency, setBudgetCurrency] = useState('USD');
  const [dailyBudget, setDailyBudget] = useState('10');
  const [durationDays, setDurationDays] = useState('7');
  const [creativeIds, setCreativeIds] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const estimateSequence = useRef(0);

  const load = async () => {
    const [ads, dashboard, media] = await Promise.all([
      api<AdsData>('/api/seller/store-buster'), api<DashboardData>('/api/dashboard/seller'), api<MediaResponse>('/api/seller/store-media')
    ]);
    setData(ads);
    const eligibleProducts = dashboard.products.filter(product => product.status === 'APPROVED' && (product.inventory?.quantity ?? 0) > 0);
    setProducts(eligibleProducts);
    if (!productId && eligibleProducts[0]) setProductId(eligibleProducts[0].id);
    setAssets(media.assets);
    if (!ads.budgetCurrencies.some(currency => currency.code === budgetCurrency)) setBudgetCurrency(ads.budgetCurrencies.find(currency => currency.code === ads.currency)?.code ?? ads.budgetCurrencies[0]?.code ?? ads.currency);
  };

  useEffect(() => { void load().catch(reason => setError((reason as Error).message)); }, []);
  useEffect(() => {
    if (data && billingModel === 'CPC' && data.pricePerClickMinor <= 0 && data.pricePer100ViewsMinor > 0) setBillingModel('CPV');
  }, [data, billingModel]);

  const selectedCurrency = data?.budgetCurrencies.find(currency => currency.code === budgetCurrency);
  const dailyBudgetMinor = selectedCurrency ? parseMinor(dailyBudget, selectedCurrency.minorUnitExponent) : null;
  const days = Number(durationDays);
  useEffect(() => {
    if (!data || !data.sponsoredAvailable || dailyBudgetMinor == null || dailyBudgetMinor < 1 || !Number.isSafeInteger(days) || days < 1 || !budgetCurrency) { setEstimate(null); setEstimateError(''); return; }
    const sequence = ++estimateSequence.current;
    const timer = window.setTimeout(() => {
      void api<Estimate>('/api/seller/store-buster/ads/estimate', { method: 'POST', body: JSON.stringify({ dailyBudgetMinor, durationDays: days, budgetCurrency }) })
        .then(result => { if (sequence === estimateSequence.current) { setEstimate(result); setEstimateError(''); } })
        .catch(reason => { if (sequence === estimateSequence.current) { setEstimate(null); setEstimateError((reason as Error).message); } });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [data?.sponsoredAvailable, dailyBudgetMinor, days, budgetCurrency]);

  const approvedAssets = useMemo(() => assets.filter(asset => asset.uploadStatus === 'COMPLETE' && asset.scanStatus === 'APPROVED' && ['IMAGE', 'VIDEO'].includes(asset.kind)), [assets]);
  const selectedAssets = creativeIds.map(id => approvedAssets.find(asset => asset.id === id)).filter((asset): asset is Media => Boolean(asset));
  const selectedImages = selectedAssets.filter(asset => asset.kind === 'IMAGE').length;
  const selectedVideos = selectedAssets.filter(asset => asset.kind === 'VIDEO').length;
  const imageAssets = approvedAssets.filter(asset => asset.kind === 'IMAGE');
  const videoAssets = approvedAssets.filter(asset => asset.kind === 'VIDEO');

  const toggleCreative = (asset: Media) => {
    setCreativeIds(current => {
      if (current.includes(asset.id)) return current.filter(id => id !== asset.id);
      if (asset.kind === 'IMAGE' && current.map(id => approvedAssets.find(item => item.id === id)).filter(item => item?.kind === 'IMAGE').length >= 3) { setError('Ads allow up to 3 images.'); return current; }
      if (asset.kind === 'VIDEO' && current.map(id => approvedAssets.find(item => item.id === id)).some(item => item?.kind === 'VIDEO')) { setError('Ads allow one video.'); return current; }
      setError('');
      return [...current, asset.id];
    });
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length || uploading) return;
    const staged = files.map(file => ({ file, kind: productMediaKindForFile(file.name), contentType: uploadContentType(file) }));
    if (staged.some(item => !item.kind || !item.contentType || !['IMAGE', 'VIDEO'].includes(item.kind))) { setError('Ad creatives accept supported image or video files only; documents are not accepted.'); return; }
    let imageCount = selectedImages;
    let videoCount = selectedVideos;
    for (const item of staged) {
      if (item.kind === 'IMAGE') imageCount += 1;
      if (item.kind === 'VIDEO') videoCount += 1;
    }
    if (imageCount > 3 || videoCount > 1) { setError('Choose no more than 3 images and 1 video for a campaign.'); return; }
    setUploading(true); setError(''); setMessage('');
    const newlyApproved: Media[] = [];
    const failures: string[] = [];
    try {
      for (const item of staged) {
        if (!item.kind || !item.contentType) continue;
        try {
          const reservation = await api<{ id: string; upload: { url: string; fields: Record<string, string> } }>('/api/seller/store-media/uploads', { method: 'POST', body: JSON.stringify({ fileName: item.file.name, contentType: item.contentType, sizeBytes: item.file.size }) });
          await uploadToSignedPostWithType(reservation.upload.url, reservation.upload.fields, item.file, setUploadProgress, item.contentType);
          const finalizePath = '/api/seller/store-media/' + encodeURIComponent(reservation.id) + '/finalize';
          const finalized = await api<{ kind: 'IMAGE' | 'VIDEO'; scanStatus: string; uploadStatus: string }>(finalizePath, { method: 'POST', body: '{}' });
          const asset: Media = { id: reservation.id, originalName: item.file.name, kind: finalized.kind, scanStatus: finalized.scanStatus, uploadStatus: finalized.uploadStatus };
          if (finalized.scanStatus === 'APPROVED' && finalized.uploadStatus === 'COMPLETE') newlyApproved.push(asset);
          else failures.push(item.file.name + ' is uploaded but not approved yet.');
        } catch (cause) { failures.push(item.file.name + ': ' + (cause as Error).message); }
      }
      if (newlyApproved.length) {
        setAssets(current => [...newlyApproved, ...current]);
        setCreativeIds(current => [...current, ...newlyApproved.map(asset => asset.id)]);
      }
      setMessage([newlyApproved.length + ' creative(s) scanned and ready.', ...failures].filter(Boolean).join(' '));
    } finally { setUploading(false); setUploadProgress(null); }
  };

  const createAd = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (!estimate?.eligible || !estimate.withinMonthlyCap || !estimate.budgetFitsBalance) throw new Error(estimateError || 'Increase the budget, reduce duration, or add prepaid credit before submitting.');
      if (!productId || !creativeIds.length) throw new Error('Select one approved in-stock product and at least one approved ad creative.');
      const created = await api<{ id: string }>('/api/seller/store-buster/campaigns', { method: 'POST', body: JSON.stringify({ name: headline.trim(), headline: headline.trim(), adDescription: description.trim(), goal: 'DISCOVERY', productIds: [productId], audienceCategoryIds: [], sponsored: true, monthlyBudgetMinor: 0, billingModel, audience, targetCountryCodes: allCountries ? [] : countryCodes, durationDays: days, dailyBudgetMinor, budgetCurrency, creativeAssetIds: creativeIds }) });
      await api('/api/seller/store-buster/campaigns/' + encodeURIComponent(created.id) + '/submit', { method: 'POST', body: '{}' });
      setHeadline(''); setDescription(''); setCreativeIds([]); setCountryCodes([]); setAllCountries(true);
      await load();
      setMessage('Ad submitted for admin review. Its schedule starts when approved, and it stops automatically at the end date or spending limits.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  if (error && !data) return <section className="sellerAds page"><h1>Ads</h1><p className="notice" role="alert">{error}</p><button type="button" onClick={() => { setError(''); void load().catch(reason => setError((reason as Error).message)); }}>Retry</button></section>;
  if (!data) return <section className="sellerAds page"><h1>Ads</h1><p className="empty" role="status" aria-busy="true">Loading advertising workspace…</p></section>;

  const selectedExponent = selectedCurrency?.minorUnitExponent ?? data.minorUnitExponent;
  return <section className="sellerAds page">
    <header className="sellerAdsHeading"><div><p className="eyebrow">Marketing · sponsored placements</p><h2>Ads</h2><p className="muted">Create a store-tagged campaign, choose who and where it reaches, and monitor verified performance.</p></div><a className="button" href="/seller/growth">Ad balance &amp; growth tools</a></header>
    {(error || message) && <p className={error ? 'notice' : 'notice storeEmailReady'} role={error ? 'alert' : 'status'}>{error || message}</p>}
    <section className="card cardBody sellerAdsBalance"><div><span>Available prepaid ad balance</span><strong>{formatMinor(data.adBalance.availableMinor, data.currency)}</strong><small>{data.adBalance.status === 'ACTIVE' ? 'Separate from seller proceeds' : 'Frozen — contact marketplace support'}</small></div><div><span>Pricing</span><strong>{data.pricePerClickMinor > 0 ? formatMinor(data.pricePerClickMinor, data.currency) + ' / click' : 'CPC off'}</strong><small>{data.pricePer100ViewsMinor > 0 ? formatMinor(data.pricePer100ViewsMinor, data.currency) + ' / 100 verified views' : 'CPV off'}</small></div><div><span>Campaign capacity</span><strong>{data.campaigns.filter(item => ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PAUSED'].includes(item.status)).length}</strong><small>Platform-wide campaign and budget limits apply equally to every Store plan</small></div></section>
    {!data.sponsoredAvailable && <p className="notice">{data.message} <a href="/seller/growth">Review advertising setup</a></p>}
    {data.sponsoredAvailable && <form className="card cardBody sellerAdsForm" onSubmit={event => void createAd(event)}>
      <p className="eyebrow">Campaign setup</p><h3>Create an ad</h3><p className="muted">The Store tag is applied automatically. Ads are not published until admin review, and the campaign clock starts after approval.</p>
      <label>Ad heading<input required minLength={2} maxLength={120} value={headline} onChange={event => setHeadline(event.target.value)} /></label>
      <label>Description<textarea required minLength={2} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>Promoted product<select required value={productId} onChange={event => setProductId(event.target.value)}><option value="">Choose an approved in-stock product</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      {!products.length && <p className="notice">Create and receive approval for an in-stock product before advertising.</p>}
      <div className="sellerAdsGrid">
        <label>Billing model<select value={billingModel} onChange={event => setBillingModel(event.target.value as 'CPC' | 'CPV')}><option value="CPC" disabled={data.pricePerClickMinor <= 0}>Price per click — {formatMinor(data.pricePerClickMinor, data.currency)} / qualified click</option><option value="CPV" disabled={data.pricePer100ViewsMinor <= 0}>Price per view — {formatMinor(data.pricePer100ViewsMinor, data.currency)} / 100 qualified views</option></select></label>
        <label>Target audience<select value={audience} onChange={event => setAudience(event.target.value as 'BUYERS' | 'SELLERS' | 'BOTH')}><option value="BUYERS">Buyers</option><option value="SELLERS">Sellers</option><option value="BOTH">Buyers and sellers</option></select></label>
        <label>Budget currency<select value={budgetCurrency} onChange={event => setBudgetCurrency(event.target.value)}>{data.budgetCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select><small>Budget uses a fresh platform FX rate. Ad balance funding remains in {data.currency}.</small></label>
        <label>Daily budget ({budgetCurrency})<input required type="number" min={selectedExponent === 0 ? '1' : `0.${'0'.repeat(selectedExponent - 1)}1`} step={selectedExponent === 0 ? '1' : `0.${'0'.repeat(selectedExponent - 1)}1`} value={dailyBudget} onChange={event => setDailyBudget(event.target.value)} /></label>
        <label>Run for (days)<input required type="number" min="1" max={data.maxCampaignDurationDays} step="1" value={durationDays} onChange={event => setDurationDays(event.target.value)} /></label>
      </div>
      <section className="sellerAdsBudget" aria-live="polite"><h4>Budget estimate</h4>{estimate && selectedCurrency ? <><p><strong>{formatMinor(estimate.budgetTotalMinor, estimate.budgetCurrency)}</strong> total · {days} days</p><p>Current FX estimate: {formatMinor(estimate.lifetimeBudgetBaseMinor, data.currency)} total · {formatMinor(estimate.monthlyBudgetBaseMinor, data.currency)} monthly cap · {formatMinor(estimate.usdEquivalentMinor, 'USD')} USD equivalent. Minimum: {formatMinor(estimate.minimumCampaignUsdMinor, 'USD')}.</p>{!estimate.withinMonthlyCap && <p className="notice">The monthly campaign budget exceeds your plan/platform cap of {formatMinor(estimate.monthlyBudgetCapMinor, data.currency)}.</p>}{!estimate.budgetFitsBalance && <p className="notice">Add at least {formatMinor(Math.max(0, estimate.lifetimeBudgetBaseMinor - data.adBalance.availableMinor), data.currency)} more prepaid balance.</p>}</> : <p className="muted">{estimateError || 'Enter a valid daily budget and duration to calculate the total automatically.'}</p>}</section>
      <section className="sellerAdsBudget" aria-live="polite"><h4>Budget estimate</h4>{estimate && selectedCurrency ? <><p><strong>{formatMinor(estimate.budgetTotalMinor, estimate.budgetCurrency)}</strong> total · {days} days</p><p>Current FX estimate: {formatMinor(estimate.lifetimeBudgetBaseMinor, data.currency)} total · {formatMinor(estimate.monthlyBudgetBaseMinor, data.currency)} monthly cap · {formatMinor(estimate.usdEquivalentMinor, 'USD')} USD equivalent. Minimum: {formatMinor(estimate.minimumCampaignUsdMinor, 'USD')}.</p>{!estimate.eligible && <p className="notice">The total budget must be at least {formatMinor(estimate.minimumCampaignUsdMinor, 'USD')} or the current equivalent.</p>}{!estimate.withinMonthlyCap && <p className="notice">The monthly campaign budget exceeds your plan/platform cap of {formatMinor(estimate.monthlyBudgetCapMinor, data.currency)}.</p>}{!estimate.budgetFitsBalance && <p className="notice">Add at least {formatMinor(Math.max(0, estimate.lifetimeBudgetBaseMinor - data.adBalance.availableMinor), data.currency)} more prepaid balance.</p>}</> : <p className="muted">{estimateError || 'Enter a valid daily budget and duration to calculate the total automatically.'}</p>}</section>
      <div className="sellerAdsTarget"><div><h4>Target countries</h4><label className="storePlanCheck"><input type="checkbox" checked={allCountries} onChange={event => { setAllCountries(event.target.checked); if (event.target.checked) setCountryCodes([]); }} />All countries</label></div>{!allCountries && <select multiple size={8} aria-label="Choose target countries" value={countryCodes} onChange={event => setCountryCodes(Array.from(event.currentTarget.selectedOptions, option => option.value))}>{data.countries.map(country => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}</select>}{!allCountries && <small>{countryCodes.length ? 'Selected countries only. Visitors without a matching saved country will not be targeted.' : 'Choose at least one country, or switch on All countries.'}</small>}</div>
      <fieldset className="sellerAdsCreatives"><legend>Ad creatives · up to 3 images and 1 video</legend><p className="muted">Only uploaded, malware-scanned, approved image/video files can be published. Documents are not accepted as ad creatives.</p>
        <label>Upload image or video<input type="file" accept=".jpg,.jpeg,.png,.webp,.avif,.gif,.heic,.heif,.mp4,.mov,.webm,.m4v,.3gp,.mkv" multiple disabled={uploading} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void uploadFiles(files); }} /></label>
        {uploadProgress != null && <progress value={uploadProgress} max="100" aria-label="Creative upload progress" />}
        <div className="sellerAdsMediaGrid"><div><h4>Approved images ({selectedImages}/3)</h4>{imageAssets.map(asset => <label className="sellerAdsMediaChoice" key={asset.id}><input type="checkbox" checked={creativeIds.includes(asset.id)} onChange={() => toggleCreative(asset)} /><img src={'/content-media/' + encodeURIComponent(asset.id)} alt="" /><span>{asset.originalName}</span></label>)}{!imageAssets.length && <small>No approved images in your media library yet.</small>}</div><div><h4>Approved video ({selectedVideos}/1)</h4>{videoAssets.map(asset => <label className="sellerAdsMediaChoice" key={asset.id}><input type="checkbox" checked={creativeIds.includes(asset.id)} onChange={() => toggleCreative(asset)} /><span>{asset.originalName}</span></label>)}{!videoAssets.length && <small>No approved video in your media library yet.</small>}</div></div>
        {selectedAssets.length > 0 && <p className="muted">{selectedAssets.length} creative(s) selected for this campaign.</p>}
      </fieldset>
      <p className="muted">Ads are clearly labeled and tagged with your Store. Audience/country selection uses account role and default saved country, not individual browsing history. CPC bills a valid click. CPV counts at most one view per viewer, campaign, and day after at least 50% of the ad is visible in the active page; account balance, budgets, and daily/monthly limits are enforced server-side.</p>
      <button className="primary" disabled={busy || uploading || !productId || !creativeIds.length || (!allCountries && !countryCodes.length) || !estimate?.eligible || !estimate.withinMonthlyCap || !estimate.budgetFitsBalance || data.adBalance.status !== 'ACTIVE'}>{busy ? 'Submitting…' : 'Submit ad for review'}</button>
    </form>}
    <section className="sellerAdsCampaigns"><header><div><p className="eyebrow">Performance</p><h3>Your ads</h3></div><span>{data.campaigns.filter(item => item.sponsored).length} total</span></header>
      {data.campaigns.filter(item => item.sponsored).length === 0 ? <div className="empty">No paid ads yet. Create a campaign above to get started.</div> : <div className="sellerAdsCampaignList">{data.campaigns.filter(item => item.sponsored).map(campaign => {
        const impressions = campaign.metrics.reduce((sum, item) => sum + item.impressions, 0);
        const clicks = campaign.metrics.reduce((sum, item) => sum + item.clicks, 0);
        const spend = campaign.metrics.reduce((sum, item) => sum + item.spendMinor, 0);
        return <article className="card cardBody sellerAdsCampaign" key={campaign.id}><header><div><span className="statusPill">{campaign.status}</span><h4>{campaign.headline ?? campaign.name}</h4><p className="muted">{campaign.audience ?? 'All audience'} · {campaign.targetCountryCodes.length ? campaign.targetCountryCodes.join(', ') : 'All countries'} · {campaign.durationDays ?? '—'} days</p></div><strong>{campaign.billingModel ?? 'CPC'}</strong></header><p>{campaign.adDescription}</p><div className="sellerAdsStats"><span><strong>{impressions.toLocaleString()}</strong> verified views</span><span><strong>{clicks.toLocaleString()}</strong> clicks</span><span><strong>{formatMinor(spend, data.currency)}</strong> spent</span><span><strong>{campaign.budgetCurrency && campaign.budgetTotalMinor != null ? formatMinor(campaign.budgetTotalMinor, campaign.budgetCurrency) : formatMinor(campaign.monthlyBudgetMinor, data.currency)}</strong> budget</span></div><small>{campaign.startsAt ? 'Starts ' + new Date(campaign.startsAt).toLocaleString() : 'Starts after admin approval'}{campaign.endsAt ? ' · Ends ' + new Date(campaign.endsAt).toLocaleString() : ''}</small><small>Promoted product: {campaign.products.map(item => item.product.name).join(', ') || 'Store'}</small></article>;
      })}</div>}
    </section>
    <p><a href="/dashboard?mode=seller&amp;tab=overview">Back to seller dashboard</a></p>
  </section>;
}
