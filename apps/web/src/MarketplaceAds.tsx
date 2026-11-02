import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from './session.js';
import { formatMinor } from './money.js';
import './MarketplaceAds.css';

const marketplaceAdPlacements = ['MARKETPLACE_HOME', 'COLLECTIONS', 'CATEGORY_PAGES', 'STOREFRONTS', 'BLOG_POSTS'] as const;
type MarketplaceAdPlacement = typeof marketplaceAdPlacements[number];

type Settings = { enabled: boolean; moderationRequired: true; minimumBudgetMinor: number; maximumBudgetMinor: number; pricePerHundredViewsMinor: number; maxDurationDays: number };
type Product = { id: string; name: string; slug: string; priceMinor: number; currency: string; availableStock: number; category: string | null; store: { id: string; name: string; slug: string } | null; image: { url?: string; alt?: string } | null };
type Creative = { creativeId?: string; id: string; kind: 'IMAGE' | 'VIDEO'; originalName?: string; name?: string; scanStatus: string; uploadStatus?: string; url?: string | null; mediaAsset?: { id: string; kind: 'IMAGE' | 'VIDEO'; originalName: string; scanStatus: string; uploadStatus: string } };
type Ad = { id: string; status: string; headline: string; description: string; externalUrl: string | null; messageEnabled: boolean; placements?: MarketplaceAdPlacement[]; productId?: string; product: { id: string; name: string; slug?: string; currency?: string; priceMinor?: number; status?: string }; store?: { name: string; slug: string } | null; budgetMinor: number; budgetInputMinor?: number | null; budgetInputCurrency?: string | null; budgetFxRate?: string | null; spentMinor: number; reservedMinor: number; pricePerHundredViewsSnapshotMinor?: number; currency: string; durationDays: number; reviewNote: string | null; creatives: Creative[]; metrics?: { impressions: number; clicks: number; spendMinor: number }[]; owner?: { name: string; email: string; role: string } };
type BudgetCurrency = { code: string; name: string; symbol: string; minorUnitExponent: number; platformToCurrencyRate: string };
type Config = { settings: Settings; currency: string; minorUnitExponent: number; budgetCurrencies: BudgetCurrency[]; preferredCurrency: string; wallet: { status: string; walletId: string | null; availableMinor: number; heldMinor: number } | null; moneyMovementEnabled: boolean };
type Uploaded = { id: string; kind: 'IMAGE' | 'VIDEO'; name: string; scanStatus: string; url: string | null };

const csrfToken = () => document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...options, headers: { ...(options.body instanceof FormData || options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(csrfToken() ? { 'x-csrf-token': csrfToken()! } : {}), ...(options.headers ?? {}) } });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? 'The request could not be completed.');
  return body as T;
}
const money = (amount: number, currency: string) => formatMinor(amount, currency);
const initialDraft = { productId: '', headline: '', description: '', externalUrl: '', messageEnabled: true, placements: ['MARKETPLACE_HOME'] as MarketplaceAdPlacement[], budget: '', budgetCurrency: '', durationDays: 7 };
const placementLabels: Record<MarketplaceAdPlacement, string> = { MARKETPLACE_HOME: 'Marketplace home', COLLECTIONS: 'Collections', CATEGORY_PAGES: 'Category pages', STOREFRONTS: 'Storefronts', BLOG_POSTS: 'Blog posts' };
const placementText = (placements?: MarketplaceAdPlacement[]) => {
  const selected: MarketplaceAdPlacement[] = placements?.length ? placements : ['MARKETPLACE_HOME'];
  return selected.map(placement => placementLabels[placement]).join(' · ');
};

export function MarketplaceAds({ admin = false }: { admin?: boolean }) {
  const { user } = useSession();
  const [config, setConfig] = useState<Config | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [adminSettings, setAdminSettings] = useState<Settings | null>(null);
  const [adminCurrency, setAdminCurrency] = useState('');
  const [adminExponent, setAdminExponent] = useState(2);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (admin) {
        const result = await api<{ items: Ad[]; settings: Settings; currency: string; minorUnitExponent: number }>('/api/admin/marketplace-ads');
        setAds(result.items);
        setAdminSettings(result.settings);
        setAdminCurrency(result.currency);
        setAdminExponent(result.minorUnitExponent);
      } else {
        const [own, catalog, data] = await Promise.all([
          api<{ items: Ad[] }>('/api/marketplace-ads/mine'),
          api<{ items: Product[] }>('/api/marketplace-ads/products'),
          api<Config>('/api/marketplace-ads/config')
        ]);
        setAds(own.items);
        setProducts(catalog.items);
        setConfig(data);
        setDraft(current => ({ ...current, budgetCurrency: data.budgetCurrencies.some(item => item.code === current.budgetCurrency) ? current.budgetCurrency : data.preferredCurrency }));
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }, [admin]);

  useEffect(() => { void load(); }, [load]);

  const budgetCurrency = config?.budgetCurrencies.find(item => item.code === draft.budgetCurrency) ?? config?.budgetCurrencies.find(item => item.code === config.currency);
  const minorBudget = useMemo(() => {
    const value = Number(draft.budget);
    return Number.isFinite(value) ? Math.round(value * 10 ** (budgetCurrency?.minorUnitExponent ?? config?.minorUnitExponent ?? 2)) : 0;
  }, [draft.budget, budgetCurrency?.minorUnitExponent, config?.minorUnitExponent]);
  const estimatedPlatformBudgetMinor = useMemo(() => {
    if (!config || !budgetCurrency || budgetCurrency.code === config.currency) return minorBudget;
    const rate = Number(budgetCurrency.platformToCurrencyRate);
    if (!Number.isFinite(rate) || rate <= 0) return 0;
    return Math.round(minorBudget * 10 ** config.minorUnitExponent / (rate * 10 ** budgetCurrency.minorUnitExponent));
  }, [budgetCurrency, config, minorBudget]);
  const estimatedViews = useMemo(() => {
    const rateMinor = config?.settings.pricePerHundredViewsMinor ?? 0;
    const pricePerViewMinor = rateMinor >= 100 && rateMinor % 100 === 0 ? rateMinor / 100 : 0;
    return pricePerViewMinor > 0 && estimatedPlatformBudgetMinor > 0 ? Math.floor(estimatedPlatformBudgetMinor / pricePerViewMinor) : 0;
  }, [config?.settings.pricePerHundredViewsMinor, estimatedPlatformBudgetMinor]);
  const currencyDisplayRate = Number(budgetCurrency?.platformToCurrencyRate ?? 1);
  const displayBudgetLimitMinor = (platformMinor: number) => Number.isFinite(currencyDisplayRate) && currencyDisplayRate > 0
    ? Math.round(platformMinor * currencyDisplayRate * 10 ** (budgetCurrency?.minorUnitExponent ?? config?.minorUnitExponent ?? 2) / 10 ** (config?.minorUnitExponent ?? 2))
    : 0;

  const updateDraft = (key: keyof typeof initialDraft, value: string | boolean | number) => setDraft(current => ({ ...current, [key]: value }));
  const editDraft = (ad: Ad) => {
    setEditingId(ad.id);
    const inputCurrency = ad.budgetInputCurrency ?? ad.currency;
    const inputMinor = ad.budgetInputMinor ?? ad.budgetMinor;
    const exponent = config?.budgetCurrencies.find(item => item.code === inputCurrency)?.minorUnitExponent ?? config?.minorUnitExponent ?? 2;
    setDraft({ productId: ad.productId ?? ad.product.id, headline: ad.headline, description: ad.description, externalUrl: ad.externalUrl ?? '', messageEnabled: ad.messageEnabled, placements: ad.placements?.length ? ad.placements : ['MARKETPLACE_HOME'], budget: (inputMinor / 10 ** exponent).toFixed(exponent), budgetCurrency: inputCurrency, durationDays: ad.durationDays });
    setFiles([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const saveDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!config) return;
    const oldCreatives = editingId ? ads.find(ad => ad.id === editingId)?.creatives ?? [] : [];
    const existingImages = oldCreatives.filter(item => (item.mediaAsset?.kind ?? item.kind) === 'IMAGE').length;
    const existingVideos = oldCreatives.filter(item => (item.mediaAsset?.kind ?? item.kind) === 'VIDEO').length;
    const addedImages = files.filter(file => file.type.startsWith('image/')).length;
    const addedVideos = files.filter(file => file.type.startsWith('video/')).length;
    if (existingImages + addedImages > 10 || existingVideos + addedVideos > 1 || files.some(file => !file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
      setError('An ad can include up to 10 images and one video. Remove extra selections and retry.');
      return;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const input = { productId: draft.productId, headline: draft.headline, description: draft.description, externalUrl: draft.externalUrl || null, messageEnabled: draft.messageEnabled, placements: draft.placements, budgetMinor: minorBudget, budgetCurrency: budgetCurrency?.code ?? config.currency, durationDays: Number(draft.durationDays) };
      const saved = editingId
        ? await api<Ad>(`/api/marketplace-ads/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify(input) })
        : await api<Ad>('/api/marketplace-ads', { method: 'POST', body: JSON.stringify(input) });
      for (const file of files) {
        const result = await api<Uploaded>(`/api/marketplace-ads/${encodeURIComponent(saved.id)}/creatives`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-type': file.type }, body: file });
        if (result.scanStatus !== 'APPROVED') setNotice('Saved. Uploaded media is private while it completes the safety check.');
      }
      setDraft(initialDraft); setEditingId(null); setFiles([]);
      setNotice('Draft saved. Review it, then submit it for moderation.');
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const submitAd = async (ad: Ad) => {
    setSaving(true); setError('');
    try {
      const result = await api<{ reservedMinor: number; currency: string; budgetInputMinor: number; budgetInputCurrency: string; budgetFxRate: string }>(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/submit`, { method: 'POST', body: '{}' });
      setNotice(`${money(result.budgetInputMinor, result.budgetInputCurrency)} budget converted at ${result.budgetFxRate} and ${money(result.reservedMinor, result.currency)} reserved in your eWallet. The campaign is now in review.`);
      await load();
    }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const ownerAction = async (ad: Ad, action: 'pause' | 'resume' | 'delete') => {
    if (action === 'delete' && !window.confirm('Delete this unsent draft and its uploaded media?')) return;
    setSaving(true); setError('');
    try { await api(`/api/marketplace-ads/${encodeURIComponent(ad.id)}${action === 'delete' ? '' : `/${action}`}`, { method: action === 'delete' ? 'DELETE' : 'POST', ...(action === 'pause' || action === 'resume' ? { body: '{}' } : {}) }); setNotice(action === 'pause' ? 'Campaign paused; its unused budget was released to your eWallet.' : action === 'resume' ? 'Campaign resumed.' : 'Draft deleted.'); await load(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const saveAdminSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminSettings) return;
    const form = new FormData(event.currentTarget);
    setSaving(true); setError(''); setNotice('');
    try {
      const updated = await api<Settings>('/api/marketplace-ads/settings', { method: 'PATCH', body: JSON.stringify({ enabled: form.get('enabled') === 'on', moderationRequired: true, minimumBudgetMinor: Number(form.get('minimumBudgetMinor')), maximumBudgetMinor: Number(form.get('maximumBudgetMinor')), pricePerHundredViewsMinor: Number(form.get('pricePerHundredViewsMinor')), maxDurationDays: Number(form.get('maxDurationDays')), reason: form.get('reason') }) });
      setAdminSettings(updated); setNotice('Marketplace ad policy saved. New submissions remain subject to moderation.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const review = async (ad: Ad, decision: 'APPROVE' | 'REJECT' | 'PAUSE') => {
    const reviewReason = reviewReasons[ad.id]?.trim();
    if (!reviewReason) { setError('Enter an audit reason for this decision.'); return; }
    setSaving(true); setError('');
    try { await api(`/api/admin/marketplace-ads/${encodeURIComponent(ad.id)}/review`, { method: 'PATCH', body: JSON.stringify({ decision, reason: reviewReason }) }); setNotice(`Ad ${decision.toLowerCase()}d.`); await load(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const activateWallet = async () => {
    setSaving(true); setError('');
    try { await api('/api/wallet/activate', { method: 'POST', body: '{}' }); await load(); setNotice('Your eWallet is ready. Add funds before submitting an ad.'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  if (!user) return <section className="page marketplaceAdsPage"><div className="adsEmpty"><h1>Sign in to advertise</h1><p>Create and manage product promotions from a verified account.</p><a className="primary" href="/?auth=login">Sign in</a></div></section>;

  return <section className="page marketplaceAdsPage">
    <header className="marketplaceAdsHero"><div><p className="eyebrow">{admin ? 'Platform governance' : 'Promote a marketplace listing'}</p><h1>{admin ? 'Marketplace ads' : 'Your ads'}</h1><p>{admin ? 'Set the wallet-funded ad policy and review campaigns before they appear on marketplace pages.' : 'Create a product promotion with images, a video, an optional external destination, or a message call-to-action.'}</p></div>{!admin && <a className="adsWalletLink" href="/wallet">eWallet <strong>{config?.wallet?.walletId ?? 'Set up'}</strong><small>{config?.wallet ? `${config.wallet.status} · ${money(config.wallet.availableMinor, config.currency)}` : 'Activate and fund your wallet'}</small></a>}</header>
    {notice && <div className="adsNotice" role="status">{notice}</div>}
    {error && <div className="adsError" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {loading ? <div className="adsLoading" role="status" aria-busy="true"><span className="adsSpinner" /> Loading advertising tools…</div> : admin ? <>
      {adminSettings && <form className="adsPanel adsPolicyForm" onSubmit={saveAdminSettings}>
        <div className="adsPanelHeading"><div><p className="eyebrow">Policy and billing</p><h2>Campaign rules</h2><p>Every ad is reviewed. A verified advertiser’s eWallet funds are held at submission and charged for each viewable impression (at least 50% visible for one second); clicks are analytics only.</p></div><label className="adsSwitch"><input name="enabled" type="checkbox" defaultChecked={adminSettings.enabled} /><span>Accept ad submissions</span></label></div>
        <div className="adsFormGrid">
          <label>Minimum budget ({adminCurrency} minor units)<input name="minimumBudgetMinor" type="number" min="1" defaultValue={adminSettings.minimumBudgetMinor} required /><small>Example: {money(100 * 10 ** adminExponent, adminCurrency || 'USD')} equals 100 major units.</small></label>
          <label>Maximum budget<input name="maximumBudgetMinor" type="number" min="1" defaultValue={adminSettings.maximumBudgetMinor} required /></label>
          <label>Charge per 100 viewable views ({adminCurrency} minor units)<input name="pricePerHundredViewsMinor" type="number" min="100" step="100" defaultValue={adminSettings.pricePerHundredViewsMinor} required /><small>{money(adminSettings.pricePerHundredViewsMinor, adminCurrency || 'USD')} per 100 views · {money(adminSettings.pricePerHundredViewsMinor / 100, adminCurrency || 'USD')} per view.</small></label>
          <label>Maximum campaign duration (days)<input name="maxDurationDays" type="number" min="1" max="365" defaultValue={adminSettings.maxDurationDays} required /></label>
          <label className="adsFieldWide">Audit reason<input name="reason" minLength={3} maxLength={500} placeholder="Why is this policy being changed?" required /></label>
        </div>
        <button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save ad policy'}</button>
      </form>}
      <div className="adsListHeading"><div><p className="eyebrow">Moderation queue</p><h2>Submitted campaigns</h2><p>Only safety-cleared creatives and eligible, in-stock products can be approved.</p></div><span className="adsCount">{ads.length} campaigns</span></div>
      <div className="adsCampaignGrid">{ads.map(ad => <AdminAdCard key={ad.id} ad={ad} saving={saving} reason={reviewReasons[ad.id] ?? ''} setReason={value => setReviewReasons(old => ({ ...old, [ad.id]: value }))} review={decision => void review(ad, decision)} />)}</div>
      {!ads.length && <div className="adsEmpty"><h3>No campaigns yet</h3><p>Submitted buyer and seller campaigns will appear here for review.</p></div>}
    </> : <>
      {!config?.settings.enabled && <div className="adsCallout">Marketplace ad submissions are paused. Your drafts and existing campaign history remain available.</div>}
      {(!config?.wallet || config.wallet.status !== 'ACTIVE') && <div className="adsCallout"><div><strong>Activate your eWallet to submit campaigns</strong><p>Wallet activation is separate from adding funds. Submitted campaign budgets are held until spent or released.</p></div><button type="button" onClick={() => void activateWallet()} disabled={saving}>{saving ? 'Working…' : 'Activate eWallet'}</button></div>}
      {config && config.wallet?.status === 'ACTIVE' && <div className="adsBalanceStrip"><span>Available ad funds</span><strong>{money(config.wallet.availableMinor, config.currency)}</strong><span>· {config.currency} wallet balance</span><a href="/wallet">Add funds</a>{!config.moneyMovementEnabled && <small>Wallet spending is currently disabled by the server safety gate.</small>}</div>}
      <form className="adsPanel adsCreateForm" onSubmit={saveDraft}>
        <div className="adsPanelHeading"><div><p className="eyebrow">{editingId ? 'Edit campaign draft' : 'Campaign setup'}</p><h2>{editingId ? 'Update your ad' : 'Create an ad draft'}</h2><p>Promote any eligible in-stock marketplace product. The platform review team must approve the ad before it is shown.</p></div><span className="adsBadge">Draft</span></div>
        <div className="adsFormGrid">
          <label className="adsFieldWide">Tagged product<select required value={draft.productId} onChange={event => updateDraft('productId', event.target.value)}><option value="">Choose an approved product</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} · {product.store?.name ?? 'Store'} · {product.availableStock} in stock</option>)}</select><small>Buyers may promote eligible listings. Sellers can promote only their own store products.</small></label>
          <fieldset className="adsPlacementPicker adsFieldWide" aria-describedby="ad-placement-help"><legend>Placements</legend><p id="ad-placement-help">Choose where your approved ad can appear. It is billed only for viewable impressions on the placements you select.</p><div className="adsPlacementOptions">{marketplaceAdPlacements.map(placement => <label key={placement}><input type="checkbox" checked={draft.placements.includes(placement)} onChange={event => setDraft(current => ({ ...current, placements: event.target.checked ? [...current.placements, placement] : current.placements.filter(item => item !== placement) }))} /><span>{placementLabels[placement]}</span></label>)}</div><div className="adsPlacementActions"><button type="button" onClick={() => setDraft(current => ({ ...current, placements: [...marketplaceAdPlacements] }))}>Select all</button><span>{draft.placements.length} of {marketplaceAdPlacements.length} selected</span></div>{draft.placements.length === 0 && <small className="adsPlacementError" role="alert">Choose at least one placement before saving.</small>}</fieldset>
          <label>Headline<input value={draft.headline} onChange={event => updateDraft('headline', event.target.value)} minLength={2} maxLength={120} required placeholder="A short campaign headline" /></label>
          <label>Budget currency<select value={draft.budgetCurrency || config?.preferredCurrency || config?.currency || ''} onChange={event => updateDraft('budgetCurrency', event.target.value)} required>{config?.budgetCurrencies.map(item => <option key={item.code} value={item.code}>{item.code} · {item.name} ({item.symbol})</option>)}</select><small>Defaults to your preferred currency. Only active currencies with a current platform rate are available.</small></label>
          <label>Campaign budget ({budgetCurrency?.code ?? config?.currency ?? '…'})<input type="number" min={1 / 10 ** (budgetCurrency?.minorUnitExponent ?? config?.minorUnitExponent ?? 2)} step={1 / 10 ** (budgetCurrency?.minorUnitExponent ?? config?.minorUnitExponent ?? 2)} value={draft.budget} onChange={event => updateDraft('budget', event.target.value)} required placeholder="Set campaign budget" /><small>{config && `Allowed: ${money(displayBudgetLimitMinor(config.settings.minimumBudgetMinor), budgetCurrency?.code ?? config.currency)}–${money(displayBudgetLimitMinor(config.settings.maximumBudgetMinor), budgetCurrency?.code ?? config.currency)}. Final wallet hold is converted to ${config.currency} at submission.`}</small></label>
          <div className="adsViewEstimate" role="status" aria-live="polite"><strong>{estimatedViews.toLocaleString()} estimated views</strong><span>At {config ? `${money(config.settings.pricePerHundredViewsMinor, config.currency)} per 100 viewable views` : 'the current rate'}; billed proportionally per view. Clicks do not add charges. Estimate uses the current FX reference rate; the server snapshots a fresh rate when you submit.</span></div>
          <label className="adsFieldWide">Description<textarea value={draft.description} onChange={event => updateDraft('description', event.target.value)} minLength={2} maxLength={1000} rows={4} required placeholder="Tell people what makes this product worth a closer look." /></label>
          <label>Duration (days)<input type="number" min="1" max={config?.settings.maxDurationDays ?? 365} value={draft.durationDays} onChange={event => updateDraft('durationDays', Number(event.target.value))} required /></label>
          <label>Optional external link<input type="url" value={draft.externalUrl} onChange={event => updateDraft('externalUrl', event.target.value)} placeholder="https://your-site.example/product" /><small>HTTPS only. Product and store tags remain visible.</small></label>
          <label className="adsFieldWide">Images (up to 10) or video (1)<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/ogg" multiple onChange={event => setFiles(Array.from(event.currentTarget.files ?? []))} /><small>Selected media previews locally first. Uploaded files remain private until the safety scan approves them.</small></label>
          {!!files.length && <div className="adsLocalPreviews adsFieldWide">{files.map((file, index) => <LocalPreview file={file} key={`${file.name}-${index}`} />)}</div>}
          <label className="adsCheckbox adsFieldWide"><input type="checkbox" checked={draft.messageEnabled} onChange={event => updateDraft('messageEnabled', event.target.checked)} /> Show a “Message advertiser” action</label>
        </div>
        <div className="adsFormActions"><button className="primary" disabled={saving || !config?.settings.enabled || !products.length || !draft.placements.length}>{saving ? 'Saving…' : editingId ? 'Save draft changes' : 'Save draft'}</button>{editingId && <button type="button" onClick={() => { setEditingId(null); setDraft(initialDraft); setFiles([]); }}>Cancel editing</button>}<a href="/wallet">Manage eWallet funds</a></div>
        {!products.length && <p className="adsCallout">No eligible products are available to promote yet. Products must be approved, in stock, and belong to an approved store.</p>}
      </form>
      <div className="adsListHeading"><div><p className="eyebrow">Campaign management</p><h2>Your campaign history</h2></div><button type="button" onClick={() => void load()}>Refresh</button></div>
      <div className="adsCampaignGrid">{ads.map(ad => <OwnerAdCard key={ad.id} ad={ad} currency={ad.currency} saving={saving} edit={() => editDraft(ad)} action={action => void ownerAction(ad, action)} submit={() => void submitAd(ad)} />)}</div>
      {!ads.length && <div className="adsEmpty"><h3>Your ads start here</h3><p>Save a draft, upload optional media, and submit it for a policy and safety review.</p></div>}
    </>}
  </section>;
}

function LocalPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <div className="adsPreviewTile">{file.type.startsWith('video/') ? <video src={url} controls playsInline muted preload="metadata" aria-label={`Preview ${file.name}`} /> : <img src={url} alt={`Preview ${file.name}`} />}</div>;
}

function OwnerAdCard({ ad, currency, saving, edit, action, submit }: { ad: Ad; currency: string; saving: boolean; edit: () => void; action: (action: 'pause' | 'resume' | 'delete') => void; submit: () => void }) {
  const media = ad.creatives ?? [];
  const estimatedViews = ad.pricePerHundredViewsSnapshotMinor ? Math.floor(ad.budgetMinor / (ad.pricePerHundredViewsSnapshotMinor / 100)) : 0;
  const inputBudgetMinor = ad.budgetInputMinor ?? ad.budgetMinor;
  const inputBudgetCurrency = ad.budgetInputCurrency ?? ad.currency;
  return <article className="adsCampaignCard"><div className="adsCardTop"><span className={`adsBadge adsStatus-${ad.status.toLowerCase()}`}>{ad.status.replaceAll('_', ' ')}</span><small>{ad.product.name}</small></div><h3>{ad.headline}</h3><p>{ad.description}</p><p className="adsMeta"><strong>Placements:</strong> {placementText(ad.placements)}</p><div className="adsCampaignNumbers"><span><small>Budget entered</small><strong>{money(inputBudgetMinor, inputBudgetCurrency)}</strong><small>Held in {currency}: {money(ad.budgetMinor, currency)}</small></span><span><small>Spent ({currency})</small><strong>{money(ad.spentMinor, currency)}</strong></span><span><small>Reserved ({currency})</small><strong>{money(ad.reservedMinor, currency)}</strong></span></div><p className="adsMeta">{ad.metrics?.reduce((sum, item) => sum + item.impressions, 0) ?? 0} views · {ad.metrics?.reduce((sum, item) => sum + item.clicks, 0) ?? 0} clicks · {estimatedViews.toLocaleString()} estimated total views · {ad.durationDays} days</p>{ad.reviewNote && <p className="adsCallout">Review note: {ad.reviewNote}</p>}
    {media.length > 0 && <div className="adsSavedPreviews">{media.map(item => { const asset = item.mediaAsset; const approved = asset?.scanStatus === 'APPROVED'; const src = item.url ?? (approved ? `/api/marketplace-ads/${encodeURIComponent(ad.id)}/creatives/${encodeURIComponent(asset?.id ?? item.id)}/preview` : null); return <div className="adsPreviewTile" key={asset?.id ?? item.id}>{src && asset?.kind === 'VIDEO' ? <video src={src} controls playsInline preload="metadata" /> : src ? <img src={src} alt={asset?.originalName ?? item.originalName ?? 'Ad creative'} /> : <span>Private · safety check pending</span>}</div>; })}</div>}
    <div className="adsCardActions">{(ad.status === 'DRAFT' || ad.status === 'REJECTED') && <><button type="button" onClick={edit}>Edit draft</button><button type="button" className="primary" disabled={saving} onClick={submit}>Submit for review</button><button type="button" className="adsDanger" disabled={saving} onClick={() => action('delete')}>Delete draft</button></>}{ad.status === 'APPROVED' && <button type="button" disabled={saving} onClick={() => action('pause')}>Pause & release remaining funds</button>}{ad.status === 'PAUSED' && <button type="button" disabled={saving} onClick={() => action('resume')}>Resume campaign</button>}</div>
  </article>;
}

function AdminAdCard({ ad, saving, reason, setReason, review }: { ad: Ad; saving: boolean; reason: string; setReason: (value: string) => void; review: (decision: 'APPROVE' | 'REJECT' | 'PAUSE') => void }) {
  const media = ad.creatives ?? [];
  const budgetInputMinor = ad.budgetInputMinor ?? ad.budgetMinor;
  const budgetInputCurrency = ad.budgetInputCurrency ?? ad.currency;
  return <article className="adsCampaignCard"><div className="adsCardTop"><span className={`adsBadge adsStatus-${ad.status.toLowerCase()}`}>{ad.status.replaceAll('_', ' ')}</span><small>{ad.owner?.name} · {ad.owner?.email}</small></div><h3>{ad.headline}</h3><p>{ad.description}</p><p className="adsMeta"><strong>Placements:</strong> {placementText(ad.placements)}</p><p className="adsMeta">Product: {ad.product.name} · Store: {ad.store?.name ?? 'N/A'} · Budget entered: {money(budgetInputMinor, budgetInputCurrency)} · Budget held: {money(ad.reservedMinor, ad.currency)}{ad.budgetFxRate ? ` · FX snapshot: 1 ${ad.currency} = ${ad.budgetFxRate} ${budgetInputCurrency}` : ''}</p><div className="adsSavedPreviews">{media.map(item => { const asset = item.mediaAsset; const src = asset?.scanStatus === 'APPROVED' ? `/api/admin/marketplace-ads/${encodeURIComponent(ad.id)}/media/${encodeURIComponent(asset.id)}` : null; return <div className="adsPreviewTile" key={asset?.id}>{src && asset?.kind === 'VIDEO' ? <video src={src} controls playsInline preload="metadata" /> : src ? <img src={src} alt={asset?.originalName ?? 'Ad creative'} /> : <span>{asset?.originalName}: {asset?.scanStatus ?? 'pending scan'}</span>}</div>; })}</div>{ad.reviewNote && <p className="adsCallout">Previous review note: {ad.reviewNote}</p>}<label className="adsReviewReason">Review reason<textarea value={reason} minLength={3} maxLength={500} onChange={event => setReason(event.target.value)} placeholder="Required audit reason" /></label><div className="adsCardActions">{ad.status === 'PENDING_REVIEW' && <><button type="button" className="primary" disabled={saving} onClick={() => review('APPROVE')}>Approve & publish</button><button type="button" className="adsDanger" disabled={saving} onClick={() => review('REJECT')}>Reject & release budget</button></>}{ad.status === 'APPROVED' && <button type="button" disabled={saving} onClick={() => review('PAUSE')}>Pause & release unused funds</button>}</div></article>;
}

export type PublicMarketplaceAd = {
  id: string;
  headline: string;
  description: string;
  externalUrl: string | null;
  messageEnabled: boolean;
  impressionToken: string;
  product: { id: string; slug: string; name: string; description: string; priceMinor: number; salePriceMinor: number | null; currency: string; availableStock: number; category: string | null; image: { url?: string; alt?: string } | null };
  store: { id: string; name: string; slug: string } | null;
  creatives: { id: string; kind: 'IMAGE' | 'VIDEO'; name: string; url: string }[];
};

export function MarketplaceAdPlacementSection({ placement, title, description }: { placement: MarketplaceAdPlacement; title?: string; description?: string }) {
  const [items, setItems] = useState<PublicMarketplaceAd[]>([]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      api<{ items: PublicMarketplaceAd[] }>(`/api/marketplace-ads/featured?placement=${encodeURIComponent(placement)}`)
        .then(result => { if (active) setItems(result.items); })
        .catch(() => { if (active) setItems([]); })
        .finally(() => { inFlight = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [placement]);
  if (!items.length) return null;
  return <section className="marketplaceAdsPlacement" aria-label={title ?? 'Sponsored marketplace ads'}><div className="sectionHeading"><div><p className="eyebrow">Sponsored · clearly labeled</p><h2>{title ?? 'Marketplace promotions'}</h2>{description && <p className="muted">{description}</p>}</div><a href="/ads">Create an ad</a></div><div className="adsPublicGrid">{items.map(ad => <MarketplaceAdCard key={`${ad.id}-${ad.impressionToken}`} ad={ad} onSignIn={() => { window.location.assign('/?auth=login'); }} />)}</div></section>;
}

export function MarketplaceAdCard({ ad, onSignIn }: { ad: PublicMarketplaceAd; onSignIn: () => void }) {
  const { user } = useSession();
  const cardRef = React.useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return undefined;
    let sent = false;
    let viewTimer: number | undefined;
    const observe = () => {
      if (sent || document.visibilityState !== 'visible') return;
      sent = true;
      void api(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/impression`, { method: 'POST', body: JSON.stringify({ impressionToken: ad.impressionToken }) }).catch(() => undefined);
    };
    const cancelTimer = () => { if (viewTimer !== undefined) window.clearTimeout(viewTimer); viewTimer = undefined; };
    const onVisibility = () => { if (document.visibilityState !== 'visible') cancelTimer(); };
    document.addEventListener('visibilitychange', onVisibility);
    const Observer = (window as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    if (!Observer) {
      viewTimer = window.setTimeout(() => {
        const rect = node.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, document.documentElement.clientWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, document.documentElement.clientHeight) - Math.max(rect.top, 0));
        if (rect.width > 0 && rect.height > 0 && visibleWidth * visibleHeight >= rect.width * rect.height * 0.5) observe();
      }, 1000);
      return () => { cancelTimer(); document.removeEventListener('visibilitychange', onVisibility); };
    }
    const observer = new Observer(entries => {
      const viewable = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5);
      if (viewable && viewTimer === undefined && document.visibilityState === 'visible') viewTimer = window.setTimeout(() => { viewTimer = undefined; observe(); observer.disconnect(); }, 1000);
      else if (!viewable) cancelTimer();
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => { cancelTimer(); observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [ad.id, ad.impressionToken]);

  const trackClick = async (destination: 'PRODUCT' | 'STORE' | 'EXTERNAL') => {
    setBusy(true); setMessage('');
    try {
      // A fast interaction proves the card was visible to the user; record the billable
      // view first so the subsequent analytics-only click is not rejected by the dwell timer.
      await api(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/impression`, { method: 'POST', body: JSON.stringify({ impressionToken: ad.impressionToken }) });
      const result = await api<{ destination: string }>(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/click`, { method: 'POST', body: JSON.stringify({ impressionToken: ad.impressionToken, destination }) });
      window.location.assign(result.destination);
    } catch (cause) { setMessage((cause as Error).message); setBusy(false); }
  };
  const contact = async () => {
    if (!ad.messageEnabled) return;
    if (!user) { onSignIn(); return; }
    setBusy(true); setMessage('');
    try {
      await api(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/impression`, { method: 'POST', body: JSON.stringify({ impressionToken: ad.impressionToken }) });
      await api(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/click`, { method: 'POST', body: JSON.stringify({ impressionToken: ad.impressionToken, destination: 'PRODUCT' }) });
      const result = await api<{ conversationId: string }>(`/api/marketplace-ads/${encodeURIComponent(ad.id)}/contact`, { method: 'POST', body: '{}' });
      window.location.assign(`/dashboard?tab=messages&conversation=${encodeURIComponent(result.conversationId)}`);
    } catch (cause) { setMessage((cause as Error).message); setBusy(false); }
  };

  return <article className="adsPublicCard" ref={cardRef}>
    <div className="adsPublicMedia">{ad.creatives.length ? ad.creatives.map(creative => creative.kind === 'VIDEO' ? <video key={creative.id} src={creative.url} controls playsInline preload="metadata" aria-label={`${ad.headline} video`} /> : <img key={creative.id} src={creative.url} alt={ad.headline} loading="lazy" />) : ad.product.image ? <img src={ad.product.image.url} alt={ad.product.image.alt ?? ad.product.name} loading="lazy" /> : <div className="adsPublicFallback" aria-hidden="true">Market Lane</div>}</div>
    <div className="adsPublicContent"><p className="adsPaidLabel">Sponsored · marketplace ad</p><h3>{ad.headline}</h3><p>{ad.description}</p><p className="adsProductTag"><span>Product</span> <strong>{ad.product.name}</strong> · {money(ad.product.salePriceMinor ?? ad.product.priceMinor, ad.product.currency)}{ad.product.category && <> · {ad.product.category}</>}</p>{ad.store && <p className="adsStoreTag"><span>Store</span> <button type="button" disabled={busy} onClick={() => void trackClick('STORE')}>{ad.store.name}</button></p>}
      <div className="adsPublicActions"><button type="button" className="primary" disabled={busy} onClick={() => void trackClick('PRODUCT')}>{busy ? 'Opening…' : 'View product'}</button>{ad.externalUrl && <button type="button" disabled={busy} onClick={() => void trackClick('EXTERNAL')}>Visit advertiser</button>}{ad.messageEnabled && <button type="button" disabled={busy} onClick={() => void contact()}>Message advertiser</button>}</div>{message && <p className="adsPublicError" role="status">{message}</p>}
    </div>
  </article>;
}
