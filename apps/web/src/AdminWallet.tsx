import React, { useEffect, useState } from 'react';
import './AdminWallet.css';

type Summary = {
  gates: {
    walletEnabled: boolean;
    walletFundingEnabled: boolean;
    walletTransfersEnabled: boolean;
    walletCheckoutEnabled: boolean;
    walletWithdrawalsEnabled: boolean;
    walletEmergencyPause: boolean;
    moneyMovementHardDisabled: boolean;
    clubCoinsEnabled: boolean;
    clubCoinsEarnEnabled: boolean;
    clubCoinsRedeemEnabled: boolean;
    clubCoinTransfersEnabled: boolean;
    clubCoinConversionEnabled: boolean;
    clubCoinsHardDisabled: boolean;
    clubCoinName: string;
  };
  walletAccounts: number;
  balances: Array<{ currency: string; _sum: Record<string, number | null> }>;
  clubCoins: { _sum: { balance: number | null }; _count: { _all: number } };
};

type CoinAccountRow = {
  user: { id: string; name: string; email: string; role: string; createdAt: string };
  account: { id: string; status: string; balance: number; updatedAt: string; entryCount: number } | null;
};
type CoinEntry = { id: string; entryType: string; amount: number; referenceType: string | null; referenceId: string | null; policyVersion: string | null; expiresAt: string | null; reversalOfId: string | null; reason: string | null; createdAt: string };

type EventType = 'ACCOUNT_VERIFIED' | 'PURCHASE_COMPLETED' | 'REVIEW_SUBMITTED' | 'LIVE_ATTENDANCE' | 'CUSTOM';
type Rule = {
  id: string;
  code: string;
  eventType: EventType;
  enabled: boolean;
  awardAmount: number;
  perUserCap: number | null;
  perOrderCap: number | null;
  dailyCap: number | null;
  expiresAfterDays: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  eligibleGroupsJson: unknown;
};

type RuleDraft = {
  code: string;
  eventType: EventType;
  enabled: boolean;
  awardAmount: string;
  perUserCap: string;
  perOrderCap: string;
  dailyCap: string;
  expiresAfterDays: string;
  effectiveFrom: string;
  effectiveTo: string;
  eligibleGroups: string;
};

const blankRule: RuleDraft = {
  code: '', eventType: 'PURCHASE_COMPLETED', enabled: false, awardAmount: '10', perUserCap: '',
  perOrderCap: '', dailyCap: '', expiresAfterDays: '', effectiveFrom: '', effectiveTo: '', eligibleGroups: ''
};

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function nullablePositiveInteger(value: string) {
  return value.trim() === '' ? null : Number(value);
}

function rulePayload(draft: RuleDraft, reason: string) {
  const groups = draft.eligibleGroups.split(',').map(value => value.trim()).filter(Boolean);
  return {
    code: draft.code.trim().toLowerCase(),
    eventType: draft.eventType,
    enabled: draft.enabled,
    awardAmount: Number(draft.awardAmount),
    perUserCap: nullablePositiveInteger(draft.perUserCap),
    perOrderCap: nullablePositiveInteger(draft.perOrderCap),
    dailyCap: nullablePositiveInteger(draft.dailyCap),
    expiresAfterDays: nullablePositiveInteger(draft.expiresAfterDays),
    effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : null,
    effectiveTo: draft.effectiveTo ? new Date(draft.effectiveTo).toISOString() : null,
    eligibleGroups: groups,
    reason: reason.trim()
  };
}

function ruleDraft(rule: Rule): RuleDraft {
  const groups = Array.isArray(rule.eligibleGroupsJson) ? rule.eligibleGroupsJson : [];
  return {
    code: rule.code,
    eventType: rule.eventType,
    enabled: rule.enabled,
    awardAmount: String(rule.awardAmount),
    perUserCap: rule.perUserCap == null ? '' : String(rule.perUserCap),
    perOrderCap: rule.perOrderCap == null ? '' : String(rule.perOrderCap),
    dailyCap: rule.dailyCap == null ? '' : String(rule.dailyCap),
    expiresAfterDays: rule.expiresAfterDays == null ? '' : String(rule.expiresAfterDays),
    effectiveFrom: toLocalDateTime(rule.effectiveFrom),
    effectiveTo: toLocalDateTime(rule.effectiveTo),
    eligibleGroups: groups.filter((group): group is string => typeof group === 'string').join(', ')
  };
}

function ruleHasUnsupportedScope(rule: Rule) {
  return rule.expiresAfterDays != null || (Array.isArray(rule.eligibleGroupsJson) && rule.eligibleGroupsJson.length > 0);
}

function isConnectedEvent(eventType: EventType) {
  return ['ACCOUNT_VERIFIED', 'PURCHASE_COMPLETED', 'REVIEW_SUBMITTED', 'LIVE_ATTENDANCE'].includes(eventType);
}

export function AdminWallet() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [coinAccounts, setCoinAccounts] = useState<CoinAccountRow[]>([]);
  const [coinQuery, setCoinQuery] = useState('');
  const [coinAccountCursor, setCoinAccountCursor] = useState<string | null>(null);
  const [selectedCoinUser, setSelectedCoinUser] = useState<CoinAccountRow['user'] | null>(null);
  const [selectedCoinAccount, setSelectedCoinAccount] = useState<CoinAccountRow['account']>(null);
  const [coinEntries, setCoinEntries] = useState<CoinEntry[]>([]);
  const [coinEntryCursor, setCoinEntryCursor] = useState<string | null>(null);
  const [coinLoading, setCoinLoading] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReference, setAdjustmentReference] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentKey, setAdjustmentKey] = useState(() => window.crypto.randomUUID());
  const [adjusting, setAdjusting] = useState(false);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<RuleDraft>(blankRule);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadCoinAccounts = async (search: string, cursor?: string, append = false) => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (cursor) params.set('cursor', cursor);
    setCoinLoading(true);
    try {
      const result = await request<{ items: CoinAccountRow[]; nextCursor: string | null }>(`/api/admin/club-coins/accounts?${params.toString()}`);
      setCoinAccounts(current => append ? [...current, ...result.items] : result.items);
      setCoinAccountCursor(result.nextCursor);
    } finally { setCoinLoading(false); }
  };

  const loadCoinEntries = async (userId: string, cursor?: string, append = false) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    setCoinLoading(true);
    try {
      const result = await request<{ account: NonNullable<CoinAccountRow['account']> | null; entries: CoinEntry[]; nextCursor: string | null }>(`/api/admin/club-coins/accounts/${encodeURIComponent(userId)}/entries?${params.toString()}`);
      setSelectedCoinAccount(result.account);
      setCoinEntries(current => append ? [...current, ...result.entries] : result.entries);
      setCoinEntryCursor(result.nextCursor);
    } finally { setCoinLoading(false); }
  };

  const load = async () => {
    try {
      const [nextSummary, nextRules] = await Promise.all([
        request<Summary>('/api/admin/wallet/summary'),
        request<Rule[]>('/api/admin/club-coins/rules')
      ]);
      setSummary(nextSummary);
      setRules(nextRules);
      await loadCoinAccounts(coinQuery);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  useEffect(() => { void load(); }, []);

  if (!summary) return <section className="page"><h1>Wallet administration</h1>{message ? <p className="notice">{message}</p> : <p>Loading…</p>}</section>;

  const gates = summary.gates;
  const draftActivationBlocked = gates.clubCoinsHardDisabled || !gates.clubCoinsEnabled || !gates.clubCoinsEarnEnabled
    || !isConnectedEvent(draft.eventType) || Boolean(draft.expiresAfterDays) || Boolean(draft.eligibleGroups.trim());
  const updatePolicy = async (field: string, value: boolean) => {
    if (!reason.trim()) { setMessage('Enter a reason before changing policy.'); return; }
    try {
      await request('/api/admin/wallet/settings', { method: 'PATCH', body: JSON.stringify({ [field]: value, reason }) });
      setReason('');
      setMessage('Policy saved.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
  };

  const saveRule = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    if (!reason.trim()) { setMessage('Enter an audit reason before saving a reward rule.'); return; }
    if (draft.effectiveFrom && draft.effectiveTo && new Date(draft.effectiveTo) <= new Date(draft.effectiveFrom)) {
      setMessage('The end time must be after the start time.');
      return;
    }
    setSaving(true);
    try {
      const path = editingId ? `/api/admin/club-coins/rules/${editingId}` : '/api/admin/club-coins/rules';
      await request(path, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(rulePayload(draft, reason)) });
      setDraft(blankRule);
      setEditingId(null);
      setReason('');
      setMessage(editingId ? 'Reward rule updated.' : 'Reward rule created.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const beginEdit = (rule: Rule) => {
    setDraft(ruleDraft(rule));
    setEditingId(rule.id);
    setMessage('');
    document.getElementById('club-coins-rule-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleRule = async (rule: Rule) => {
    if (!reason.trim()) { setMessage('Enter an audit reason before changing a reward rule.'); return; }
    try {
      await request(`/api/admin/club-coins/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled, reason }) });
      setReason('');
      setMessage(rule.enabled ? 'Reward rule deactivated.' : 'Reward rule activated.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
  };

  const searchCoinAccounts = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    try { await loadCoinAccounts(coinQuery); }
    catch (error) { setMessage((error as Error).message); }
  };

  const selectCoinAccount = async (row: CoinAccountRow) => {
    setSelectedCoinUser(row.user);
    setSelectedCoinAccount(row.account);
    setCoinEntries([]);
    setCoinEntryCursor(null);
    setMessage('');
    try { await loadCoinEntries(row.user.id); }
    catch (error) { setMessage((error as Error).message); }
  };

  const submitCoinAdjustment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCoinUser) return;
    const amount = Number(adjustmentAmount);
    if (!Number.isSafeInteger(amount) || amount === 0) { setMessage('Enter a non-zero whole number of coins.'); return; }
    if (!adjustmentReason.trim() || !adjustmentReference.trim()) { setMessage('A reason and reference are required for every adjustment.'); return; }
    setAdjusting(true);
    setMessage('');
    try {
      await request('/api/admin/club-coins/adjustments', { method: 'POST', body: JSON.stringify({
        userId: selectedCoinUser.id,
        amount,
        reason: adjustmentReason.trim(),
        reference: adjustmentReference.trim(),
        idempotencyKey: adjustmentKey
      }) });
      await Promise.all([loadCoinAccounts(coinQuery), loadCoinEntries(selectedCoinUser.id)]);
      setAdjustmentAmount('');
      setAdjustmentReference('');
      setAdjustmentReason('');
      setAdjustmentKey(window.crypto.randomUUID());
      setMessage('Audited Club Coins adjustment recorded.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setAdjusting(false); }
  };

  return <section className="page adminWallet">
    <p className="eyebrow">Risk-controlled operations</p>
    <h1>Wallet & Club Coins</h1>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="notice">{gates.moneyMovementHardDisabled ? 'Real-money wallet movement is hard-disabled by server configuration.' : 'Review provider readiness and reconciliation evidence before enabling money movement.'}</div>
    <div className="grid adminWalletMetrics">
      <article className="card cardBody"><h2>Wallet accounts</h2><strong>{summary.walletAccounts}</strong></article>
      <article className="card cardBody"><h2>{gates.clubCoinName} outstanding</h2><strong>{summary.clubCoins._sum.balance ?? 0}</strong><p>{summary.clubCoins._count._all} accounts · non-cash balance</p></article>
    </div>

    <section className="adminCoinAccounts">
      <div className="sectionHeading"><div><p className="eyebrow">Account operations</p><h2>Club Coins accounts & ledger</h2></div><span className="adminWalletBadge">Audited · non-cash</span></div>
      <p className="muted">Search by member name or email, inspect immutable ledger entries, and record a reasoned adjustment. Available balance checks and idempotency are enforced by the API.</p>
      <form className="adminCoinSearch" onSubmit={event => void searchCoinAccounts(event)}>
        <label>Find a member<input type="search" maxLength={120} value={coinQuery} onChange={event => setCoinQuery(event.target.value)} placeholder="Name or email" /></label>
        <button type="submit" disabled={coinLoading}>{coinLoading ? 'Searching…' : 'Search accounts'}</button>
      </form>
      <div className="adminCoinAccountLayout">
        <div className="adminCoinAccountList" aria-label="Club Coins member accounts">
          {coinAccounts.length === 0 ? <div className="empty">No matching members.</div> : coinAccounts.map(row => <button type="button" className={`adminCoinAccountRow${selectedCoinUser?.id === row.user.id ? ' isSelected' : ''}`} key={row.user.id} onClick={() => void selectCoinAccount(row)}>
            <span><strong>{row.user.name}</strong><small>{row.user.email} · {row.user.role}</small></span>
            <span><strong>{row.account?.balance ?? 0}</strong><small>{row.account ? `${row.account.entryCount} entries · ${row.account.status.toLowerCase()}` : 'No account yet'}</small></span>
          </button>)}
          {coinAccountCursor && <button type="button" disabled={coinLoading} onClick={() => void loadCoinAccounts(coinQuery, coinAccountCursor, true)}>{coinLoading ? 'Loading…' : 'Load more members'}</button>}
        </div>
        <div className="adminCoinAccountDetail">
          {!selectedCoinUser ? <div className="empty">Select a member to inspect their Club Coins ledger.</div> : <>
            <div className="sectionHeading"><div><span className="adminWalletBadge">{selectedCoinAccount?.status ?? 'No account'}</span><h3>{selectedCoinUser.name}</h3><p className="muted">{selectedCoinUser.email}</p></div><div className="adminCoinBalance"><strong>{selectedCoinAccount?.balance ?? 0}</strong><span>{gates.clubCoinName}</span></div></div>
            <form className="adminCoinAdjustment" onSubmit={event => void submitCoinAdjustment(event)}>
              <h4>Manual adjustment</h4>
              <p className="muted">Use a positive amount to grant coins or a negative amount to remove them. Negative adjustments cannot exceed the current balance.</p>
              <div className="adminCoinRuleGrid">
                <label>Signed coin amount<input type="number" required min="-1000000" max="1000000" step="1" value={adjustmentAmount} onChange={event => setAdjustmentAmount(event.target.value)} placeholder="e.g. 25 or -10" /></label>
                <label>Reference<input required maxLength={160} value={adjustmentReference} onChange={event => setAdjustmentReference(event.target.value)} placeholder="Support case, order, or ticket ID" /></label>
                <label className="adminWalletWide">Reason<input required minLength={3} maxLength={500} value={adjustmentReason} onChange={event => setAdjustmentReason(event.target.value)} placeholder="Explain why this account is being adjusted" /></label>
              </div>
              <button className="primary" disabled={adjusting || gates.clubCoinsHardDisabled || !gates.clubCoinsEnabled}>{adjusting ? 'Recording…' : 'Record adjustment'}</button>
            </form>
            <div className="adminCoinLedgerHeading"><h4>Immutable ledger</h4><span>{coinEntries.length}{coinEntryCursor ? '+' : ''} entries loaded</span></div>
            {coinEntries.length === 0 ? <div className="empty">No Club Coins ledger entries yet.</div> : <div className="adminCoinLedger">{coinEntries.map(entry => <article className="adminCoinLedgerEntry" key={entry.id}>
              <div><strong>{entry.entryType.replaceAll('_', ' ')}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small></div>
              <strong className={entry.amount < 0 ? 'isNegative' : 'isPositive'}>{entry.amount > 0 ? '+' : ''}{entry.amount}</strong>
              <p>{entry.reason || 'No reason recorded'}{entry.referenceType ? ` · ${entry.referenceType}` : ''}{entry.referenceId ? ` · ${entry.referenceId}` : ''}</p>
              {entry.expiresAt && <small>Expires {new Date(entry.expiresAt).toLocaleString()}</small>}
            </article>)}</div>}
            {coinEntryCursor && <button type="button" disabled={coinLoading} onClick={() => void loadCoinEntries(selectedCoinUser.id, coinEntryCursor, true)}>{coinLoading ? 'Loading…' : 'Load older ledger entries'}</button>}
          </>}
        </div>
      </div>
    </section>

    <section className="setting adminWalletPolicy">
      <div><p className="eyebrow">Platform safeguards</p><h2>Policy controls</h2></div>
      <label className="settingRow">Emergency money pause<input type="checkbox" checked={gates.walletEmergencyPause} onChange={event => void updatePolicy('walletEmergencyPause', event.target.checked)} /></label>
      <label className="settingRow">Wallet enabled<input type="checkbox" checked={gates.walletEnabled} onChange={event => void updatePolicy('walletEnabled', event.target.checked)} /></label>
      <label className="settingRow">Club Coins enabled<input type="checkbox" checked={gates.clubCoinsEnabled} disabled={gates.clubCoinsHardDisabled} onChange={event => void updatePolicy('clubCoinsEnabled', event.target.checked)} /></label>
      <label className="settingRow">Club Coins earning<input type="checkbox" checked={gates.clubCoinsEarnEnabled} disabled={gates.clubCoinsHardDisabled} onChange={event => void updatePolicy('clubCoinsEarnEnabled', event.target.checked)} /></label>
      <label className="settingRow">Club Coins redemption<input type="checkbox" checked={gates.clubCoinsRedeemEnabled} disabled={gates.clubCoinsHardDisabled} onChange={event => void updatePolicy('clubCoinsRedeemEnabled', event.target.checked)} /></label>
      {gates.clubCoinsHardDisabled && <p className="muted adminWalletWide">Club Coins are hard-disabled on the server. Admin controls cannot override this environment safeguard.</p>}
      <label className="adminWalletWide">Audit reason<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Required for every policy or rule change" /></label>
    </section>

    <section className="adminCoinRules">
      <div className="sectionHeading"><div><p className="eyebrow">Loyalty configuration</p><h2>Reward rules</h2></div><span className="adminWalletBadge">{rules.length} rules</span></div>
      <p className="muted">Purchase rewards require paid, receipt-confirmed orders. Account rewards require one-time email verification. Review rewards are issued only after admin approval and are reversed if the review or purchase is later invalidated. Live rewards require five provider-backed viewing minutes. Club Coins remain non-cash and cannot be withdrawn.</p>
      <form id="club-coins-rule-form" className="setting adminCoinRuleForm" onSubmit={event => void saveRule(event)}>
        <div className="sectionHeading"><div><h3>{editingId ? 'Edit reward rule' : 'Create reward rule'}</h3><p className="muted">Use a stable, unique rule code. Deactivate rules instead of deleting them.</p></div>{editingId && <button type="button" onClick={() => { setEditingId(null); setDraft(blankRule); }}>Cancel edit</button>}</div>
        <div className="adminCoinRuleGrid">
          <label>Rule code<input required pattern="[a-z0-9._-]{2,80}" maxLength={80} value={draft.code} onChange={event => setDraft({ ...draft, code: event.target.value.toLowerCase() })} placeholder="purchase-thanks" /></label>
          <label>Trigger type<select value={draft.eventType} onChange={event => setDraft({ ...draft, eventType: event.target.value as EventType })}><option value="PURCHASE_COMPLETED">Completed purchase (paid + receipt-confirmed)</option><option value="ACCOUNT_VERIFIED">Account verified (one-time email confirmation)</option><option value="REVIEW_SUBMITTED">Approved verified-purchase review</option><option value="LIVE_ATTENDANCE">Live attendance (5 eligible minutes)</option><option value="CUSTOM" disabled>Custom event (not connected)</option></select></label>
          <label>Coins per event<input type="number" required min="1" max="1000000" step="1" value={draft.awardAmount} onChange={event => setDraft({ ...draft, awardAmount: event.target.value })} /></label>
          <label>Per-user cap<input type="number" min="1" step="1" value={draft.perUserCap} onChange={event => setDraft({ ...draft, perUserCap: event.target.value })} placeholder="No cap" /></label>
          <label>Per-order cap<input type="number" min="1" step="1" value={draft.perOrderCap} onChange={event => setDraft({ ...draft, perOrderCap: event.target.value })} placeholder="No cap" /></label>
          <label>Daily cap<input type="number" min="1" step="1" value={draft.dailyCap} onChange={event => setDraft({ ...draft, dailyCap: event.target.value })} placeholder="No cap" /></label>
          <label>Expires after (days)<input type="number" min="1" max="3650" step="1" value={draft.expiresAfterDays} onChange={event => setDraft({ ...draft, expiresAfterDays: event.target.value })} placeholder="Never" /></label>
          <label>Eligible groups<input value={draft.eligibleGroups} onChange={event => setDraft({ ...draft, eligibleGroups: event.target.value })} placeholder="Comma-separated group names" /></label>
          <label>Starts at<input type="datetime-local" value={draft.effectiveFrom} onChange={event => setDraft({ ...draft, effectiveFrom: event.target.value })} /></label>
          <label>Ends at<input type="datetime-local" value={draft.effectiveTo} onChange={event => setDraft({ ...draft, effectiveTo: event.target.value })} /></label>
        </div>
        <label className="settingRow adminCoinEnabled">Rule enabled<input type="checkbox" checked={draft.enabled} disabled={!draft.enabled && draftActivationBlocked} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /></label>
        <p className="muted adminWalletWide">Activation requires the server hard-disable to be removed and Club Coins earning policy to be enabled. Live attendance also requires an enabled, healthy live provider. Group-targeted and expiring rules remain fail-closed until their services are implemented.</p>
        <button className="primary" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save rule changes' : 'Create rule'}</button>
      </form>
      {rules.length === 0 ? <div className="empty">No reward rules configured yet.</div> : <div className="adminCoinRuleList">{rules.map(rule => <article className="card adminCoinRule" key={rule.id}>
        <div className="sectionHeading"><div><span className="adminWalletBadge">{rule.enabled ? 'Enabled' : 'Disabled'}</span><h3>{rule.code}</h3><p className="muted">{rule.eventType.replaceAll('_', ' ')} · {rule.awardAmount} {gates.clubCoinName}</p></div><div className="profileActions"><button type="button" onClick={() => beginEdit(rule)}>Edit</button><button type="button" disabled={!rule.enabled && (!isConnectedEvent(rule.eventType) || ruleHasUnsupportedScope(rule) || gates.clubCoinsHardDisabled || !gates.clubCoinsEnabled || !gates.clubCoinsEarnEnabled)} onClick={() => void toggleRule(rule)}>{rule.enabled ? 'Deactivate' : !isConnectedEvent(rule.eventType) || ruleHasUnsupportedScope(rule) ? 'Not eligible' : 'Activate'}</button></div></div>
        <p className="muted">Caps: user {rule.perUserCap ?? 'none'} · order {rule.perOrderCap ?? 'none'} · daily {rule.dailyCap ?? 'none'} · expiry {rule.expiresAfterDays ? `${rule.expiresAfterDays} days` : 'none'}</p>
      </article>)}</div>}
    </section>
    <p className="muted">Account freezes, adjustments, withdrawals, and reconciliation remain audited operations. Ledger history is never edited or deleted.</p>
  </section>;
}
