import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Catalog = {
  currencies: { code: string; name: string; region: string; active: boolean; displayEnabled: boolean; storePricingEnabled: boolean; checkoutEnabled: boolean; subscriptionEnabled: boolean; minorUnitExponent: number }[];
  referenceRefreshEnabled: boolean;
  baseCurrency: string;
  subscriptionBillingEnabled: false;
};
type Policy = {
  id: string;
  version: number;
  status: string;
  type: string;
  currency: string;
  fixedMinor: number | null;
  basisPoints: number | null;
  minimumMinor: number | null;
  capMinor: number | null;
  reason: string;
  storeId: string | null;
  planVersionId: string | null;
  freeStoreScopeKey: string | null;
  store?: { name: string };
  planVersion?: { plan: { name: string } };
};
type Review = {
  id: string;
  amountMinor: number;
  currency: string;
  provider: string;
  providerEventId: string;
  reason: string;
  parentOrder: {
    orderNumber: string;
    sellerOrders: {
      id: string;
      sellerId: string | null;
      seller: { store?: { name: string } } | null;
      items: { id: string; productName: string; quantity: number; unitPriceMinor: number; currencySnapshotEntry?: { code: string } }[];
    }[];
  };
};
type Ledger = {
  totals: { sellerId: string; store: { name: string; slug: string } | null; currency: string; netMinor: number; entries: number }[];
  unresolvedReviews: number;
  fundedOrReconciled: false;
  note: string;
};
type SectionProps = { section: 'currencies' | 'commissions' };
type LoadKey = 'catalog' | 'policies' | 'reviews' | 'ledger';
type DraftEdit = { id: string; type: 'ZERO' | 'PERCENTAGE'; basisPoints: string; reason: string; changeReason: string };

function LoadingPanel({ label }: { label: string }) {
  return <div className="commissionLoading" role="status" aria-label={`Loading ${label}`}>
    <span /><span /><span />
    <small>Loading {label}…</small>
  </div>;
}

export function AdminCurrencyCommission({ section }: SectionProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<LoadKey, string>>>({});
  const [message, setMessage] = useState('');
  const [rateRefreshSummary, setRateRefreshSummary] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [manual, setManual] = useState({ baseCurrency: 'USD', quoteCurrency: '', rate: '', effectiveFrom: new Date(Date.now() + 60_000).toISOString().slice(0, 16), reason: '' });
  const [policy, setPolicy] = useState({ type: 'ZERO', basisPoints: '', reason: '' });
  const [policyActionReasons, setPolicyActionReasons] = useState<Record<string, string>>({});
  const [draftRemovalReasons, setDraftRemovalReasons] = useState<Record<string, string>>({});
  const [draftEdit, setDraftEdit] = useState<DraftEdit | null>(null);
  const [refundReasons, setRefundReasons] = useState<Record<string, string>>({});
  const [previewBase, setPreviewBase] = useState('10000');
  const [preview, setPreview] = useState<number | null>(null);
  const [refundAllocations, setRefundAllocations] = useState<Record<string, Record<string, string>>>({});

  const load = async () => {
    const failures: LoadKey[] = [];
    const failed = (key: LoadKey, reason: unknown) => {
      failures.push(key);
      const detail = reason instanceof Error ? reason.message : 'Unable to load this section.';
      setLoadErrors(current => ({ ...current, [key]: detail }));
    };
    const loaded = (key: LoadKey) => setLoadErrors(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    await Promise.all([
      api<Catalog>('/api/admin/currencies').then(value => {
        setCatalog(value);
        setManual(current => ({
          ...current,
          baseCurrency: value.baseCurrency,
          quoteCurrency: current.quoteCurrency && value.currencies.some(currency => currency.code === current.quoteCurrency && currency.displayEnabled)
            ? current.quoteCurrency
            : value.currencies.find(currency => currency.displayEnabled && currency.code !== value.baseCurrency)?.code ?? ''
        }));
        loaded('catalog');
      }).catch(reason => failed('catalog', reason)),
      api<{ policies: Policy[] }>('/api/admin/seller-commission-policies').then(value => { setPolicies(value.policies); loaded('policies'); }).catch(reason => failed('policies', reason)),
      api<Review[]>('/api/admin/seller-commission-reviews').then(value => { setReviews(value); loaded('reviews'); }).catch(reason => failed('reviews', reason)),
      api<Ledger>('/api/admin/seller-commission-ledger').then(value => { setLedger(value); loaded('ledger'); }).catch(reason => failed('ledger', reason))
    ]);
    return failures;
  };

  useEffect(() => {
    void load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    const failures = await load();
    if (failures.length) setError('Some data could not be refreshed. The rest of the page is still available; retry when the service is ready.');
    else setError('');
    setRefreshing(false);
  };

  const action = async (work: () => Promise<unknown>, success: string) => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await work();
      const failures = await load();
      setMessage(success);
      if (failures.length) setError('Saved successfully, but some page data could not refresh. Use Refresh data to try again.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateCapability = (code: string, body: object) => action(
    () => api(`/api/admin/currencies/${code}`, { method: 'PATCH', body: JSON.stringify({ ...body, reason: 'Reviewed in platform currency controls' }) }),
    'Currency capability updated.'
  );
  const createManual = () => action(
    () => api('/api/admin/fx/manual-rates', { method: 'POST', body: JSON.stringify({ ...manual, effectiveFrom: new Date(manual.effectiveFrom).toISOString() }) }),
    'Manual reference rate version saved.'
  );

  const refreshRates = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    setRateRefreshSummary('');
    try {
      const result = await api<{ requested: number; returned: number; inserted: number; unavailableCurrencies: string[] }>('/api/admin/fx/refresh', { method: 'POST', body: '{}' });
      const failures = await load();
      setRateRefreshSummary(result.unavailableCurrencies.length
        ? `Received ${result.returned} of ${result.requested} automatic rates. No provider rate was returned for ${result.unavailableCurrencies.join(', ')}. Add audited manual rates for those currencies if they are needed.`
        : `Received ${result.returned} of ${result.requested} automatic rates.`);
      if (failures.length) setError('Rates refreshed, but some page data could not refresh.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createPolicy = () => action(async () => {
    const body: Record<string, unknown> = { type: policy.type, reason: policy.reason.trim() };
    if (policy.type === 'PERCENTAGE') body.basisPoints = Number(policy.basisPoints);
    await api('/api/admin/seller-commission-policies', { method: 'POST', body: JSON.stringify(body) });
    setPolicy(current => ({ ...current, reason: '' }));
    setPreview(null);
  }, 'Commission draft version created.');

  const beginDraftEdit = (item: Policy) => setDraftEdit({
    id: item.id,
    type: item.type === 'PERCENTAGE' ? 'PERCENTAGE' : 'ZERO',
    basisPoints: item.basisPoints == null ? '' : String(item.basisPoints),
    reason: item.reason,
    changeReason: ''
  });

  const saveDraftEdit = (edit: DraftEdit) => action(async () => {
    await api(`/api/admin/seller-commission-policies/${edit.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        type: edit.type,
        basisPoints: edit.type === 'PERCENTAGE' ? Number(edit.basisPoints) : null,
        reason: edit.reason.trim(),
        changeReason: edit.changeReason.trim()
      })
    });
    setDraftEdit(null);
  }, 'Draft updated. The change was recorded in the audit log.');

  const removeDraft = (item: Policy) => action(async () => {
    await api(`/api/admin/seller-commission-policies/${item.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: draftRemovalReasons[item.id]?.trim() ?? '' })
    });
    setDraftRemovalReasons(current => ({ ...current, [item.id]: '' }));
    if (draftEdit?.id === item.id) setDraftEdit(null);
  }, `Draft version ${item.version} removed from drafts and retained in version history.`);

  const runPreview = async () => {
    setPreviewing(true);
    setError('');
    try {
      const body = {
        policy: { type: policy.type, ...(policy.type === 'PERCENTAGE' ? { basisPoints: Number(policy.basisPoints) } : {}) },
        eligibleBaseMinor: Number(previewBase)
      };
      const result = await api<{ commissionMinor: number }>('/api/admin/seller-commission-preview', { method: 'POST', body: JSON.stringify(body) });
      setPreview(result.commissionMinor);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const resolveReview = (review: Review) => {
    const allocations = Object.entries(refundAllocations[review.id] ?? {})
      .filter(([, amount]) => amount.trim() !== '')
      .map(([orderItemId, amount]) => ({ orderItemId, refundMinor: Number(amount) }));
    void action(async () => {
      await api(`/api/admin/seller-commission-reviews/${review.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ allocations, reason: refundReasons[review.id]?.trim() ?? '' })
      });
      setRefundReasons(current => ({ ...current, [review.id]: '' }));
    }, 'Refund allocation posted as append-only commission reversals.');
  };

  const currency = catalog?.currencies.find(item => item.code === manual.quoteCurrency);
  const activePolicies = policies?.filter(item => item.status === 'ACTIVE').length;
  const draftPolicies = policies?.filter(item => item.status === 'DRAFT').length;
  const ledgerEntries = ledger?.totals.reduce((sum, total) => sum + total.entries, 0);
  const unresolvedReviews = ledger?.unresolvedReviews ?? reviews?.length;
  const commissionsSection = section === 'commissions';

  const sectionError = (key: LoadKey, label: string) => loadErrors[key] && <div className="commissionInlineError" role="alert">
    <span><strong>{label} did not load.</strong> {loadErrors[key]}</span>
    <button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button>
  </div>;

  return <section className={`adminCurrencyCommission${commissionsSection ? ' adminCommissionPage' : ''}`}>
    <a className="commissionBackLink" href="/admin/platform">Back to platform administration</a>
    <header className="commissionPageHeader">
      <div>
        <p className="eyebrow">Platform controls</p>
        <h1>{commissionsSection ? 'Seller commissions' : 'Currency catalog and FX'}</h1>
        <p className="commissionIntro">{commissionsSection
          ? 'Review accrued commission activity, manage the policy for free Stores, and resolve verified refund allocations.'
          : 'Manage display currency capabilities and audited reference exchange-rate estimates.'}</p>
      </div>
      <div className="commissionHeaderActions">
        <nav className="commissionPageNav" aria-label="Currency and commission pages">
          <a href="/admin/currencies" aria-current={section === 'currencies' ? 'page' : undefined}>Currency &amp; FX</a>
          <a href="/admin/commissions" aria-current={commissionsSection ? 'page' : undefined}>Seller commissions</a>
        </nav>
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </button>
      </div>
    </header>

    <p className="commissionFinancialNote">Checkout currency is <strong>{catalog?.baseCurrency ?? '…'}</strong>. Reference rates are estimates only. Commission settings do not change order currency, payment amounts, or historical order snapshots.</p>
    {message && <p className="commissionFeedback commissionFeedbackSuccess" role="status">{message}</p>}
    {error && <p className="commissionFeedback commissionFeedbackError" role="alert">{error}</p>}

    {section === 'currencies' && <>
      {sectionError('catalog', 'Currency catalog')}
      {!catalog && !loadErrors.catalog ? <LoadingPanel label="currency settings" /> : <>
        {!catalog && <div className="commissionInlineError" role="status">Currency settings are unavailable. Commission data, if loaded, remains unaffected.</div>}
        <div className="setting"><div><strong>Reference exchange rates</strong><p>Fetches current public reference rates for active display currencies. Unsupported provider pairs are skipped so they do not block other currencies. This is for estimates only; it never changes checkout amounts or settlement.</p></div><span>{catalog?.referenceRefreshEnabled ? 'Available' : 'Disabled by deployment'}</span>{catalog?.referenceRefreshEnabled && <button disabled={saving} onClick={() => void refreshRates()}>{saving ? 'Refreshing…' : 'Refresh reference rates'}</button>}</div>
        {rateRefreshSummary && <p className="muted" role="status">{rateRefreshSummary}</p>}
        <h2>Currency capabilities</h2><p className="muted">Display and Store pricing do not imply checkout or subscription support. Payment and subscription capability changes remain server-gated.</p>
        <div className="table">{catalog?.currencies.map(item => <div className="row currencyAdminRow" key={item.code}><strong>{item.code} · {item.name}</strong><span>{item.region} · {item.minorUnitExponent} minor digits</span><label className="checkRow"><input type="checkbox" checked={item.active} onChange={event => void updateCapability(item.code, { active: event.target.checked })} />Active</label><label className="checkRow"><input type="checkbox" checked={item.displayEnabled} onChange={event => void updateCapability(item.code, { displayEnabled: event.target.checked })} />Display</label><label className="checkRow"><input type="checkbox" checked={item.storePricingEnabled} onChange={event => void updateCapability(item.code, { storePricingEnabled: event.target.checked })} />Store pricing</label><span>Checkout: {item.checkoutEnabled ? 'platform base only' : 'not enabled'}</span><span>Subscription: disabled</span></div>)}</div>
        <section className="card cardBody"><h2>Audited manual reference rate</h2><p>Manual values override automatic rates for the selected base/quote pair while effective. Use a documented source and reason; this does not set a payment amount.</p><div className="two"><label>Base currency<select value={manual.baseCurrency} onChange={event => setManual({ ...manual, baseCurrency: event.target.value })}>{catalog?.currencies.filter(item => item.active).map(item => <option key={item.code}>{item.code}</option>)}</select></label><label>Quote currency<select value={manual.quoteCurrency} onChange={event => setManual({ ...manual, quoteCurrency: event.target.value })}><option value="">Choose display currency</option>{catalog?.currencies.filter(item => item.active && item.displayEnabled && item.code !== manual.baseCurrency).map(item => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label></div><label>Rate (1 {manual.baseCurrency} =)<input inputMode="decimal" value={manual.rate} onChange={event => setManual({ ...manual, rate: event.target.value })} /></label><label>Effective from<input type="datetime-local" value={manual.effectiveFrom} onChange={event => setManual({ ...manual, effectiveFrom: event.target.value })} /></label><label>Reason<input value={manual.reason} onChange={event => setManual({ ...manual, reason: event.target.value })} minLength={5} maxLength={500} /></label><button className="primary" disabled={saving || !manual.quoteCurrency || !manual.rate || manual.reason.trim().length < 5} onClick={() => void createManual()}>Add manual rate version</button>{currency && <small>Quote currency precision: {currency.minorUnitExponent} digits.</small>}</section>
      </>}
    </>}

    {commissionsSection && <>
      <section className="commissionMetrics" aria-label="Commission overview">
        <article><span>Active policies</span><strong>{activePolicies ?? (loadErrors.policies ? '—' : '…')}</strong><small>All-free-Store policy versions</small></article>
        <article><span>Draft versions</span><strong>{draftPolicies ?? (loadErrors.policies ? '—' : '…')}</strong><small>Awaiting administrator activation</small></article>
        <article><span>Open refund reviews</span><strong>{unresolvedReviews ?? (loadErrors.ledger && loadErrors.reviews ? '—' : '…')}</strong><small>Verified partial refunds to allocate</small></article>
        <article><span>Ledger entries</span><strong>{ledgerEntries ?? (loadErrors.ledger ? '—' : '…')}</strong><small>Accrued outcomes only</small></article>
      </section>

      <div className="commissionMainGrid">
        <section className="card commissionPanel commissionLedgerPanel">
          <header className="commissionPanelHeader"><div><p className="eyebrow">Reconciliation</p><h2>Accrued ledger</h2></div><span className="commissionStatus">No payouts configured</span></header>
          {sectionError('ledger', 'Ledger')}
          {ledger ? <>
            <p className="commissionPanelIntro">{ledger.note}</p>
            <div className="commissionSubhead"><strong>Ledger by Store and currency</strong><span>{ledgerEntries ?? 0} entries</span></div>
            {ledger.totals.length ? <div className="commissionLedgerList">{ledger.totals.map(total => <article className="commissionLedgerRow" key={`${total.sellerId}-${total.currency}`}>
              <div><strong>{total.store?.name ?? 'Store'}</strong><small>{total.currency} · {total.entries} append-only {total.entries === 1 ? 'entry' : 'entries'}</small></div>
              <div className="commissionLedgerAmount"><span>Net accrued</span><strong>{formatMinor(total.netMinor, total.currency)}</strong></div>
            </article>)}</div> : <div className="commissionEmpty"><strong>No ledger activity yet</strong><span>No commission funding or payout obligation is represented by an empty ledger.</span></div>}
            <div className="commissionLedgerFoot"><span>Unresolved partial-refund allocations</span><strong>{ledger.unresolvedReviews}</strong></div>
          </> : loadErrors.ledger ? <div className="commissionEmpty"><strong>Ledger data is unavailable.</strong><span>Retry the ledger request to view current entries.</span></div> : <LoadingPanel label="commission ledger" />}
        </section>

        <section className="card commissionPanel commissionPolicyFormPanel">
          <header className="commissionPanelHeader"><div><p className="eyebrow">Policy configuration</p><h2>Create a commission draft</h2></div><span className="commissionStatus commissionStatusDraft">Draft</span></header>
          <p className="commissionPanelIntro">Applies to all Stores on a free plan. Paid Store Plan subscribers and the official marketplace Store are exempt automatically. Existing orders keep their saved commission snapshot.</p>
          <form className="commissionPolicyForm" onSubmit={event => { event.preventDefault(); void createPolicy(); }}>
            <label>Commission type<select value={policy.type} onChange={event => { setPolicy({ ...policy, type: event.target.value, basisPoints: event.target.value === 'ZERO' ? '' : policy.basisPoints }); setPreview(null); }}><option value="ZERO">No commission</option><option value="PERCENTAGE">Percentage of eligible merchandise</option></select></label>
            {policy.type === 'PERCENTAGE' && <label>Commission percentage (basis points)<input type="number" min="0" max="10000" step="1" required value={policy.basisPoints} onChange={event => { setPolicy({ ...policy, basisPoints: event.target.value }); setPreview(null); }} /><small>For example, 250 basis points equals 2.5%.</small></label>}
            <label>Audit reason<textarea required minLength={5} maxLength={500} rows={3} value={policy.reason} onChange={event => setPolicy({ ...policy, reason: event.target.value })} placeholder="Explain why this policy is being created" /></label>
            <div className="commissionPreviewTool">
              <label>Example eligible order total ({catalog?.baseCurrency ?? 'base currency'} minor units)<input type="number" min="0" max="2000000000" step="1" required value={previewBase} onChange={event => { setPreviewBase(event.target.value); setPreview(null); }} /></label>
              <button type="button" disabled={previewing || saving || (policy.type === 'PERCENTAGE' && policy.basisPoints === '')} onClick={() => void runPreview()}>{previewing ? 'Calculating…' : 'Preview commission'}</button>
            </div>
            {preview !== null && <output className="commissionPreviewResult" aria-live="polite"><span>Estimated commission on example</span><strong>{formatMinor(preview, catalog?.baseCurrency ?? 'USD')}</strong></output>}
            <button className="primary commissionCreateButton" type="submit" disabled={saving || policy.reason.trim().length < 5 || (policy.type === 'PERCENTAGE' && policy.basisPoints === '')}>{saving ? 'Saving…' : 'Create draft for all free Stores'}</button>
          </form>
        </section>
      </div>

      <section className="commissionSection">
        <header className="commissionSectionHeader"><div><p className="eyebrow">Version history</p><h2>Commission policies</h2><p>Activate only after reviewing the scope and rate. Activating a draft supersedes the previous all-free-Store policy.</p></div><span>{policies?.length ?? (loadErrors.policies ? '—' : '…')} versions</span></header>
        {sectionError('policies', 'Policy versions')}
        {policies ? policies.length ? <div className="commissionPolicyList">{policies.map(item => {
          const appliesToFreeStores = item.freeStoreScopeKey === 'FREE_STORES';
          const reason = policyActionReasons[item.id] ?? '';
          const canChange = appliesToFreeStores && ['DRAFT', 'ACTIVE'].includes(item.status);
          return <article className="commissionPolicyCard" key={item.id}>
            <div className="commissionPolicySummary">
              <div><p className="eyebrow">{appliesToFreeStores ? 'All free Stores' : 'Legacy scoped policy'}</p><h3>{appliesToFreeStores ? `Version ${item.version}` : `${item.store?.name ?? item.planVersion?.plan.name ?? 'Scoped policy'} · v${item.version}`}</h3></div>
              <span className={`commissionStatus commissionStatus${item.status.toLowerCase()}`}>{item.status.replaceAll('_', ' ')}</span>
            </div>
            <div className="commissionPolicyFacts"><div><span>Policy</span><strong>{item.type.replaceAll('_', ' ')}</strong></div><div><span>Rate</span><strong>{item.basisPoints != null ? `${item.basisPoints / 100}%` : item.fixedMinor != null ? `Legacy fixed ${formatMinor(item.fixedMinor, item.currency)}` : 'No commission'}</strong></div></div>
            <p className="commissionPolicyReason">{item.reason}</p>
            {!appliesToFreeStores && <p className="commissionLegacyNote">Legacy policy; not used for new orders.</p>}
            {item.status === 'DRAFT' && appliesToFreeStores && <>
              <details className="commissionDraftTools" open={draftEdit?.id === item.id}>
                <summary>Edit or remove draft</summary>
                <p>Changes are audited. Removing a draft archives it in version history; it is not used for new orders.</p>
                {draftEdit?.id === item.id ? <form className="commissionDraftEditForm" onSubmit={event => { event.preventDefault(); void saveDraftEdit(draftEdit); }}>
                  <label>Commission type<select value={draftEdit.type} onChange={event => setDraftEdit({ ...draftEdit, type: event.target.value as DraftEdit['type'], basisPoints: event.target.value === 'ZERO' ? '' : draftEdit.basisPoints })}><option value="ZERO">No commission</option><option value="PERCENTAGE">Percentage of eligible merchandise</option></select></label>
                  {draftEdit.type === 'PERCENTAGE' && <label>Percentage (basis points)<input type="number" min="0" max="10000" step="1" required value={draftEdit.basisPoints} onChange={event => setDraftEdit({ ...draftEdit, basisPoints: event.target.value })} /><small>For example, 250 basis points equals 2.5%.</small></label>}
                  <label>Policy description / reason<textarea required minLength={5} maxLength={500} rows={2} value={draftEdit.reason} onChange={event => setDraftEdit({ ...draftEdit, reason: event.target.value })} /></label>
                  <label>Audit reason for this change<input required minLength={5} maxLength={500} value={draftEdit.changeReason} onChange={event => setDraftEdit({ ...draftEdit, changeReason: event.target.value })} placeholder="Explain why the draft is being changed" /></label>
                  <div className="commissionDraftEditButtons"><button className="primary" type="submit" disabled={saving || draftEdit.reason.trim().length < 5 || draftEdit.changeReason.trim().length < 5 || (draftEdit.type === 'PERCENTAGE' && draftEdit.basisPoints === '')}>{saving ? 'Saving…' : 'Save draft changes'}</button><button type="button" disabled={saving} onClick={() => setDraftEdit(null)}>Cancel</button></div>
                </form> : <button className="commissionEditDraftButton" type="button" disabled={saving} onClick={() => beginDraftEdit(item)}>Edit draft terms</button>}
                <form className="commissionRemoveDraftForm" onSubmit={event => { event.preventDefault(); void removeDraft(item); }}>
                  <label htmlFor={`remove-policy-reason-${item.id}`}>Reason for removing this draft<input id={`remove-policy-reason-${item.id}`} required minLength={5} maxLength={500} value={draftRemovalReasons[item.id] ?? ''} onChange={event => setDraftRemovalReasons(current => ({ ...current, [item.id]: event.target.value }))} placeholder="Add an audit reason" /></label>
                  <button className="commissionDangerButton" type="submit" disabled={saving || (draftRemovalReasons[item.id]?.trim().length ?? 0) < 5}>Remove draft</button>
                </form>
              </details>
              <form className="commissionPolicyAction" onSubmit={event => {
                event.preventDefault();
                void action(() => api(`/api/admin/seller-commission-policies/${item.id}/activate`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }), `Policy version ${item.version} activated.`);
              }}>
                <label htmlFor={`policy-reason-${item.id}`}>Reason for activation<input id={`policy-reason-${item.id}`} required minLength={5} maxLength={500} value={reason} onChange={event => setPolicyActionReasons(current => ({ ...current, [item.id]: event.target.value }))} placeholder="Add an audit reason" /></label>
                <button type="submit" disabled={saving || reason.trim().length < 5}>Activate version</button>
              </form>
            </>}
            {item.status === 'ACTIVE' && appliesToFreeStores && <form className="commissionPolicyAction" onSubmit={event => {
              event.preventDefault();
              void action(() => api(`/api/admin/seller-commission-policies/${item.id}/retire`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }), 'Policy retired; existing order snapshots remain unchanged.');
            }}>
              <label htmlFor={`policy-reason-${item.id}`}>Reason for retirement<input id={`policy-reason-${item.id}`} required minLength={5} maxLength={500} value={reason} onChange={event => setPolicyActionReasons(current => ({ ...current, [item.id]: event.target.value }))} placeholder="Add an audit reason" /></label>
              <button type="submit" disabled={saving || reason.trim().length < 5}>Retire policy</button>
            </form>}
          </article>;
        })}</div> : <div className="commissionEmpty"><strong>No commission policies have been created.</strong><span>New orders currently use the applicable zero-commission default.</span></div> : loadErrors.policies ? <div className="commissionEmpty"><strong>Policy versions are unavailable.</strong><span>Retry to check the current policy state.</span></div> : <LoadingPanel label="commission policy versions" />}
      </section>

      <section className="commissionSection commissionRefundSection">
        <header className="commissionSectionHeader"><div><p className="eyebrow">Refund operations</p><h2>Verified partial-refund reviews</h2><p>Allocate each verified provider refund to order items. Amounts must be positive integer minor units and total exactly the verified refund.</p></div><span>{reviews?.length ?? (loadErrors.reviews ? '—' : '…')} open</span></header>
        {sectionError('reviews', 'Refund reviews')}
        {reviews ? reviews.length ? <div className="commissionReviewList">{reviews.map(review => {
          const entries = Object.entries(refundAllocations[review.id] ?? {}).filter(([, amount]) => amount.trim() !== '');
          const amounts = entries.map(([, amount]) => Number(amount));
          const validAmounts = amounts.every(amount => Number.isSafeInteger(amount) && amount > 0);
          const allocatedMinor = validAmounts ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
          const difference = allocatedMinor === null ? null : review.amountMinor - allocatedMinor;
          const complete = allocatedMinor === review.amountMinor && entries.length > 0;
          return <article className="card commissionReviewCard" key={review.id}>
            <header className="commissionReviewHeader"><div><p className="eyebrow">Order {review.parentOrder.orderNumber}</p><h3>{formatMinor(review.amountMinor, review.currency)} refund</h3></div><span className="commissionStatus commissionStatusReview">Needs allocation</span></header>
            <p className="commissionPanelIntro">{review.reason}</p>
            <details className="commissionProviderDetails"><summary>Provider event details</summary><dl><div><dt>Provider</dt><dd>{review.provider}</dd></div><div><dt>Event ID</dt><dd><code>{review.providerEventId}</code></dd></div></dl></details>
            <div className="commissionRefundItems"><h4>Allocate by order item</h4>
              {review.parentOrder.sellerOrders.filter(order => order.sellerId).flatMap(order => order.items.map(item => <label className="commissionRefundItem" key={item.id}>
                <span><strong>{item.productName}</strong><small>{order.seller?.store?.name ?? 'Seller'} · {item.quantity} {item.quantity === 1 ? 'item' : 'items'} · up to {formatMinor(item.unitPriceMinor * item.quantity, item.currencySnapshotEntry?.code ?? review.currency)}</small></span>
                <input aria-label={`Refund amount for ${item.productName} in minor units`} type="number" min="1" step="1" value={refundAllocations[review.id]?.[item.id] ?? ''} onChange={event => setRefundAllocations(current => ({ ...current, [review.id]: { ...(current[review.id] ?? {}), [item.id]: event.target.value } }))} placeholder="Minor units" />
              </label>))}
            </div>
            <div className={`commissionAllocationTotal${complete ? ' isComplete' : ''}`} aria-live="polite">
              <span>{allocatedMinor === null || difference === null ? 'Enter positive whole-number amounts' : difference === 0 ? 'Allocation matches verified refund' : difference > 0 ? `${formatMinor(difference, review.currency)} remaining` : `${formatMinor(Math.abs(difference), review.currency)} over the verified refund`}</span>
              <strong>{allocatedMinor === null ? '—' : formatMinor(allocatedMinor, review.currency)} <small>/ {formatMinor(review.amountMinor, review.currency)}</small></strong>
            </div>
            <form className="commissionResolveForm" onSubmit={event => { event.preventDefault(); resolveReview(review); }}>
              <label>Audit reason<input required minLength={5} maxLength={500} value={refundReasons[review.id] ?? ''} onChange={event => setRefundReasons(current => ({ ...current, [review.id]: event.target.value }))} placeholder="Explain this allocation" /></label>
              <button className="primary" type="submit" disabled={saving || !complete || (refundReasons[review.id]?.trim().length ?? 0) < 5}>Post allocated reversals</button>
            </form>
          </article>;
        })}</div> : <div className="commissionEmpty"><strong>No refund reviews need allocation.</strong><span>Verified partial-refund items that require review will appear here.</span></div> : loadErrors.reviews ? <div className="commissionEmpty"><strong>Refund reviews are unavailable.</strong><span>Retry to check for open allocations.</span></div> : <LoadingPanel label="refund reviews" />}
      </section>

      <aside className="commissionSafetyNote"><strong>Money movement is not enabled here.</strong><span>This page records accrued commission outcomes only. It does not initiate seller payouts, deductions, settlement, or real-money commission collection.</span></aside>
    </>}
  </section>;
}
