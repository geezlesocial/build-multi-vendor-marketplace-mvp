import React, { useEffect, useState } from 'react';
import './AdminMembers.css';

type Member = {
  id: string; email: string; name: string; role: string; accountStatus: 'ACTIVE' | 'SUSPENDED'; createdAt: string; emailVerifiedAt: string | null;
  sellerId: string | null; sellerStatus: string | null; storeName: string | null; activeSessions: number; buyerOrders: number;
  isCurrentAdmin: boolean;
};
type MemberPage = { members: Member[]; page: number; pageSize: number; total: number };

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? 'Member administration request failed.'); }
  return response.status === 204 ? undefined as T : response.json();
}

const label = (value: string) => value.replaceAll('_', ' ').toLocaleLowerCase().replace(/(^|\s)\S/g, char => char.toLocaleUpperCase());

export function AdminMembers() {
  const [data, setData] = useState<MemberPage>({ members: [], page: 1, pageSize: 50, total: 0 });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [role, setRole] = useState('ALL');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), status, role });
    if (search.length >= 2) params.set('q', search);
    void api<MemberPage>(`/api/admin/members?${params}`).then(result => {
      if (!active) return;
      setData(result);
      if (selectedId && !result.members.some(member => member.id === selectedId)) setSelectedId('');
    }).catch(cause => { if (active) setError((cause as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, role, search, selectedId, status]);

  const selected = data.members.find(member => member.id === selectedId) ?? null;
  const refresh = async () => {
    const params = new URLSearchParams({ page: String(page), status, role });
    if (search.length >= 2) params.set('q', search);
    const result = await api<MemberPage>(`/api/admin/members?${params}`);
    setData(result);
  };

  const updateStatus = async () => {
    if (!selected) return;
    const next = selected.accountStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    if (reason.trim().length < 8) { setError('Enter a reason of at least 8 characters for the audit record.'); return; }
    if (next === 'SUSPENDED' && !window.confirm(`Suspend ${selected.name} and revoke all of their active sessions?`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<{ sessionsRevoked: number }>(`/api/admin/members/${encodeURIComponent(selected.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: next, reason: reason.trim() }) });
      setNotice(`Account ${next.toLowerCase()}. ${result.sessionsRevoked} active session(s) revoked.`); setReason(''); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const revokeSessions = async () => {
    if (!selected) return;
    if (reason.trim().length < 8) { setError('Enter a reason of at least 8 characters for the audit record.'); return; }
    if (!window.confirm(`Sign ${selected.name} out of all active sessions?`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<{ sessionsRevoked: number }>(`/api/admin/members/${encodeURIComponent(selected.id)}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setNotice(`${result.sessionsRevoked} session(s) revoked. The member will need to sign in again.`); setReason(''); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const waiveEmailVerification = async () => {
    if (!selected) return;
    if (reason.trim().length < 8) { setError('Enter a reason of at least 8 characters for the audit record.'); return; }
    if (!window.confirm(`Waive mailbox verification and mark ${selected.email} verified? This does not confirm control of that mailbox.`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<{ alreadyVerified: boolean }>(`/api/admin/members/${encodeURIComponent(selected.id)}/verify-email`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setNotice(result.alreadyVerified ? 'This account email was already verified.' : 'Email verification waived and account marked verified. The action was recorded in the audit log.');
      setReason(''); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  return <section className="adminMembers">
    <header className="adminMembersHeader"><div><p className="eyebrow">Access governance</p><h2>Members &amp; security</h2><p className="muted">Review accounts, waive email verification, suspend access, and revoke sessions. Every privileged action requires a reason and is audited.</p></div><span className="adminMemberTotal">{data.total.toLocaleString()} members</span></header>
    {notice && <p className="adminMemberNotice" role="status">{notice}</p>}{error && <p className="adminMemberError" role="alert">{error}</p>}
    <div className="adminMemberFilters"><label>Search by name or email<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Enter at least 2 characters" /></label><label>Account status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></label><label>Role<select value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="ALL">All roles</option><option value="BUYER">Buyer</option><option value="SELLER">Seller</option><option value="CASHIER">Cashier</option><option value="CONTENT_EDITOR">Content editor</option><option value="ADMIN">Administrator</option></select></label></div>
    <div className="adminMemberLayout">
      <div className="adminMemberList" aria-label="Members">
        {loading && <div className="empty">Loading members…</div>}
        {!loading && !data.members.length && <div className="empty">No members match these filters.</div>}
        {data.members.map(member => <button key={member.id} type="button" className={`adminMemberRow ${member.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(member.id); setReason(''); setError(''); setNotice(''); }}>
          <span className="adminMemberRowHead"><strong>{member.name}</strong><span className={`memberStatus ${member.accountStatus.toLowerCase()}`}>{label(member.accountStatus)}</span></span><span>{member.email}</span><span className="adminMemberRowFoot">{label(member.role)}{member.storeName ? ` · ${member.storeName}` : ''} · {member.emailVerifiedAt ? 'Email verified' : 'Email unverified'}</span>
        </button>)}
        {data.total > data.pageSize && <div className="adminMemberPagination"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button type="button" disabled={page >= Math.ceil(data.total / data.pageSize) || loading} onClick={() => setPage(current => current + 1)}>Next</button></div>}
      </div>
      <article className="adminMemberDetails card cardBody">
        {!selected ? <div className="empty">Select a member to inspect access and apply a security action.</div> : <>
          <div className="adminMemberDetailsHeading"><div><p className="eyebrow">Member profile</p><h3>{selected.name}</h3><p>{selected.email}</p></div><span className={`memberStatus ${selected.accountStatus.toLowerCase()}`}>{label(selected.accountStatus)}</span></div>
          <dl className="adminMemberFacts"><div><dt>Account role</dt><dd>{label(selected.role)}</dd></div><div><dt>Email status</dt><dd>{selected.emailVerifiedAt ? `Verified ${new Date(selected.emailVerifiedAt).toLocaleDateString()}` : 'Unverified'}</dd></div><div><dt>Joined</dt><dd>{new Date(selected.createdAt).toLocaleDateString()}</dd></div><div><dt>Active sessions</dt><dd>{selected.activeSessions}</dd></div><div><dt>Buyer orders</dt><dd>{selected.buyerOrders}</dd></div>{selected.sellerId && <><div><dt>Seller status</dt><dd>{label(selected.sellerStatus ?? 'UNKNOWN')}</dd></div><div><dt>Store</dt><dd>{selected.storeName ?? 'No Store profile'}</dd></div></>}</dl>
          {selected.sellerStatus === 'APPROVED' && selected.accountStatus === 'ACTIVE' && <p className="adminMemberCaution">Suspending this seller account also pauses its approved seller status and public listings. Re-activation restores approval only if it has not since been changed by moderation.</p>}
          {!selected.emailVerifiedAt && <p className="adminMemberCaution">Waiving verification bypasses proof of mailbox ownership. Use only after an approved manual review; this action does not award email-verification rewards and is permanently audited.</p>}
          <label className="adminMemberReason">Reason for this action<textarea rows={3} minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Record the operational reason (8–500 characters)" /></label>
          <div className="adminMemberActions">{!selected.emailVerifiedAt && <button type="button" className="primary" disabled={saving} onClick={() => void waiveEmailVerification()}>Waive verification &amp; mark verified</button>}<button type="button" className={selected.accountStatus === 'ACTIVE' ? 'danger' : 'primary'} disabled={saving || (selected.isCurrentAdmin && selected.accountStatus === 'ACTIVE')} onClick={() => void updateStatus()}>{selected.accountStatus === 'ACTIVE' ? 'Suspend account & sign out' : 'Reactivate account'}</button><button type="button" disabled={saving || selected.activeSessions === 0 || selected.isCurrentAdmin} onClick={() => void revokeSessions()}>Revoke all sessions</button></div>
          <p className="adminMemberBoundary">Suspension is reversible, not deletion. Role grants, admin promotion, password resets, and MFA management are intentionally not available in this console.</p>
        </>}
      </article>
    </div>
  </section>;
}
