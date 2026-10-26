import React, { useEffect, useState } from 'react';
import './AdminOperations.css';

type Endpoint = { key: string; label: string; path: string; status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'DISABLED'; note: string };
type OperationsData = {
  checkedAt: string;
  api: { status: 'UP'; uptimeSeconds: number };
  database: { status: 'UP'; latencyMs: number };
  providerConfigurations: { id: string; provider: string; context: string; environment: string; name: string; enabled: boolean; ready: boolean; readinessCode: string; message: string; lastCheckedAt: string | null }[];
  webhooks: Endpoint[];
  eventMetrics: { receivedLast24Hours: number; reviewRequired: number; unverified: number };
  events: { id: string; provider: string; eventId: string; eventType: string | null; receivedAt: string; providerOccurredAt: string | null; orderNumber: string | null; identityVerified: boolean; reviewReason: string | null; state: 'PROCESSED' | 'REVIEW_REQUIRED' | 'UNVERIFIED'; retryAvailable: boolean }[];
  page: number;
  pageSize: number;
  total: number;
};

type ProviderFilter = 'ALL' | 'STRIPE' | 'PAYPAL';
type StateFilter = 'ALL' | 'REVIEW_REQUIRED' | 'PROCESSED' | 'UNVERIFIED';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

const dateTime = (value: string) => new Date(value).toLocaleString();
const elapsed = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
};

export function AdminOperations() {
  const [data, setData] = useState<OperationsData | null>(null);
  const [provider, setProvider] = useState<ProviderFilter>('ALL');
  const [state, setState] = useState<StateFilter>('ALL');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async (showLoading: boolean) => {
      if (showLoading && !data) setLoading(true);
      try {
        const query = new URLSearchParams({ provider, state, page: String(page) });
        const result = await api<OperationsData>(`/api/admin/integrations/operations?${query}`);
        if (active) { setData(result); setError(''); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load integration status.');
      } finally {
        if (active && showLoading) setLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => { void load(false); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [provider, state, page, reloadKey]);

  const retryReconciliation = async (event: OperationsData['events'][number]) => {
    if (!event.retryAvailable || busyId) return;
    if (!window.confirm(`Retry internal reconciliation for ${event.eventId}? This does not resend the webhook or contact ${event.provider}.`)) return;
    const reason = window.prompt('Audit reason for retry (at least 5 characters):', 'Retry verified payment event reconciliation');
    if (!reason || reason.trim().length < 5) { setMessage('Retry cancelled: an audit reason of at least 5 characters is required.'); return; }
    setBusyId(event.id); setMessage(''); setError('');
    try {
      const result = await api<{ reconciliation: string; reviewReason: string | null }>('/api/admin/seller-commission-webhook-events/' + encodeURIComponent(event.id) + '/retry', { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setMessage(result.reconciliation === 'COMPLETE' ? 'Event reconciliation completed.' : `Event remains in review${result.reviewReason ? ` (${result.reviewReason})` : ''}.`);
      setReloadKey(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The event could not be retried.');
    } finally { setBusyId(''); }
  };

  if (loading && !data) return <section className="adminOperations"><div className="empty" role="status">Loading integration and webhook status…</div></section>;
  if (!data) return <section className="adminOperations"><div className="notice" role="alert">{error || 'Integration status could not be loaded.'}<button type="button" onClick={() => setReloadKey(value => value + 1)}>Retry</button></div></section>;

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <section className="adminOperations">
    <header className="adminOperationsHeader">
      <div><p className="eyebrow">Integrations &amp; APIs</p><h2>Webhooks &amp; API status</h2><p className="muted">Internal service checks and verified inbound payment-event review. Provider-side delivery is not probed.</p></div>
      <button type="button" disabled={loading} onClick={() => setReloadKey(value => value + 1)}>Refresh now</button>
    </header>
    {error && <div className="notice" role="alert">Status refresh failed: {error} Existing results are shown when available.</div>}
    {message && <div className="notice" role="status">{message}</div>}

    <div className="adminOpsMetrics">
      <article className="card cardBody"><span>Marketplace API</span><strong className="opsOk">Responding</strong><small>Process uptime {elapsed(data.api.uptimeSeconds)}</small></article>
      <article className="card cardBody"><span>Database</span><strong className="opsOk">Reachable</strong><small>Read probe {data.database.latencyMs} ms</small></article>
      <article className="card cardBody"><span>Inbound events · 24 hours</span><strong>{data.eventMetrics.receivedLast24Hours}</strong><small>Processed webhook event records</small></article>
      <article className="card cardBody"><span>Needs attention</span><strong className={data.eventMetrics.reviewRequired || data.eventMetrics.unverified ? 'opsWarn' : 'opsOk'}>{data.eventMetrics.reviewRequired + data.eventMetrics.unverified}</strong><small>{data.eventMetrics.reviewRequired} review · {data.eventMetrics.unverified} unverified</small></article>
    </div>
    <p className="adminOpsRefreshNote">Updated {dateTime(data.checkedAt)} · refreshes every 15 seconds while this page is open.</p>

    <section className="card cardBody" aria-labelledby="webhook-endpoints-heading">
      <h3 id="webhook-endpoints-heading">Inbound webhook endpoints</h3>
      <p className="muted">“Configured” means the application has the required local verification configuration. It does not confirm the endpoint is registered, reachable, or delivering events at Stripe or PayPal.</p>
      <div className="adminOpsEndpointGrid">{data.webhooks.map(endpoint => <article className="adminOpsEndpoint" key={endpoint.key}>
        <div><strong>{endpoint.label}</strong><span className={`opsStatus opsStatus-${endpoint.status.toLowerCase()}`}>{endpoint.status.replaceAll('_', ' ')}</span></div>
        <code>{endpoint.path}</code><p>{endpoint.note}</p>
      </article>)}</div>
    </section>

    <section className="card cardBody" aria-labelledby="provider-status-heading">
      <h3 id="provider-status-heading">Provider configuration readiness</h3>
      <p className="muted">Readiness is based on saved references and runtime configuration only; no outbound provider API request is made.</p>
      {data.providerConfigurations.length ? <div className="adminOpsProviderList">{data.providerConfigurations.map(config => <article className="adminOpsProvider" key={config.id}>
        <div><strong>{config.name}</strong><span>{config.provider} · {config.context.replaceAll('_', ' ')} · {config.environment}</span></div>
        <span className={`opsStatus ${config.ready ? 'opsStatus-configured' : 'opsStatus-not_configured'}`}>{config.enabled ? 'Enabled' : 'Disabled'} · {config.readinessCode.replaceAll('_', ' ')}</span>
        <p>{config.message}</p>
      </article>)}</div> : <div className="empty">No active provider configuration records.</div>}
      <p><a href="/admin/platform?section=providers">Manage provider configurations</a></p>
    </section>

    <section className="adminOpsEvents" aria-labelledby="webhook-events-heading">
      <header><div><p className="eyebrow">Inbound event ledger</p><h3 id="webhook-events-heading">Payment webhook events</h3><p className="muted">This ledger records events accepted by the marketplace handlers; it is not a provider delivery-attempt log.</p></div><span className="adminOpsTotal">{data.total} events</span></header>
      <div className="adminOpsFilters">
        <label>Provider<select value={provider} onChange={event => { setProvider(event.target.value as ProviderFilter); setPage(1); }}><option value="ALL">All providers</option><option value="STRIPE">Stripe</option><option value="PAYPAL">PayPal</option></select></label>
        <label>Event state<select value={state} onChange={event => { setState(event.target.value as StateFilter); setPage(1); }}><option value="ALL">All states</option><option value="REVIEW_REQUIRED">Needs review</option><option value="UNVERIFIED">Identity unverified</option><option value="PROCESSED">Processed</option></select></label>
      </div>
      {data.events.length ? <div className="adminOpsEventList">{data.events.map(event => <article className="card adminOpsEvent" key={event.id}>
        <div className="adminOpsEventMain">
          <div className="adminOpsEventTitle"><strong>{event.provider}</strong><span className={`opsStatus opsStatus-${event.state.toLowerCase()}`}>{event.state.replaceAll('_', ' ')}</span></div>
          <code title={event.eventId}>{event.eventId}</code>
          <span>{event.eventType ?? 'Unknown event type'}</span>
          <small>Received {dateTime(event.receivedAt)}{event.orderNumber ? ` · Order ${event.orderNumber}` : ''}</small>
          {event.reviewReason && <p className="opsReviewReason">Review reason: {event.reviewReason.replaceAll('_', ' ').toLowerCase()}</p>}
        </div>
        {event.retryAvailable && <button type="button" disabled={Boolean(busyId)} onClick={() => void retryReconciliation(event)}>{busyId === event.id ? 'Retrying…' : 'Retry reconciliation'}</button>}
      </article>)}</div> : <div className="empty">No webhook events match these filters.</div>}
      <div className="adminOpsPagination"><span>Page {data.page} of {pageCount}</span><div><button type="button" disabled={data.page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button><button type="button" disabled={data.page >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>Next</button></div></div>
    </section>
  </section>;
}
