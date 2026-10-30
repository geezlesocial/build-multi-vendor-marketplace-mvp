import React, { useEffect, useMemo, useState } from 'react';
import './PlatformCollaborators.css';

const permissions = [
  ['OVERVIEW', 'Overview'],
  ['MARKETPLACE', 'Marketplace operations'],
  ['PLANS_BILLING', 'Store plans and billing'],
  ['PAYMENTS', 'Payments, commissions, payouts and refunds'],
  ['WALLET_MANAGEMENT', 'Platform eWallet and Club Coins'],
  ['GROWTH', 'Growth, promotions and advertising'],
  ['MEMBERS_SECURITY', 'Members and security'],
  ['SUPPORT_MESSAGING', 'Support and messaging'],
  ['AI_OPERATIONS', 'Jima AI operations'],
  ['INTEGRATIONS', 'Integrations and providers'],
  ['PLATFORM_SETTINGS', 'Platform settings and currency'],
  ['GOVERNANCE', 'Audit log and governance'],
  ['CONTENT_MANAGEMENT', 'Blog and page content']
] as const;

type Permission = typeof permissions[number][0];
type PositionOption = { key: string; name: string; permissions: Permission[]; enabled: boolean; builtIn: boolean };
const builtinPositions: PositionOption[] = [
  { key: 'ADMINISTRATOR', name: 'Administrator', permissions: permissions.map(([key]) => key), enabled: true, builtIn: true },
  { key: 'SUPERVISOR', name: 'Supervisor', permissions: ['OVERVIEW', 'MARKETPLACE', 'GROWTH', 'SUPPORT_MESSAGING'], enabled: true, builtIn: true },
  { key: 'ACCOUNTANT', name: 'Accountant', permissions: ['OVERVIEW', 'PLANS_BILLING', 'PAYMENTS'], enabled: true, builtIn: true },
  { key: 'WRITER', name: 'Writer', permissions: ['CONTENT_MANAGEMENT'], enabled: true, builtIn: true },
  { key: 'EDITOR', name: 'Editor', permissions: ['CONTENT_MANAGEMENT'], enabled: true, builtIn: true }
];
type Collaborator = {
  id: string;
  position: string;
  permissions: Permission[];
  enabled: boolean;
  createdAt: string;
  user: { id: string; name: string; email: string; accountStatus: string; emailVerifiedAt: string | null; createdAt: string };
  createdBy: { id: string; name: string | null; email: string };
};
type Draft = { name: string; position: string; permissions: Permission[]; enabled: boolean; reason: string };
type PositionDraft = { name: string; permissions: Permission[]; enabled: boolean; reason: string };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'The request could not be completed.');
  return body as T;
}

const display = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());

function PermissionPicker({ value, onChange, name }: { value: Permission[]; onChange: (next: Permission[]) => void; name: string }) {
  return <fieldset className="collaboratorPermissions"><legend>Access permissions</legend><div className="collaboratorPermissionGrid">
    {permissions.map(([key, label]) => <label key={key}><input type="checkbox" checked={value.includes(key)} onChange={event => onChange(event.target.checked ? [...value, key] : value.filter(permission => permission !== key))} /><span>{label}</span></label>)}
  </div><small>Only selected modules are available. Changes to permissions end existing sessions so new grants take effect on the next sign-in.</small><span className="srOnly">Permissions for {name}</span></fieldset>;
}

export function PlatformCollaborators() {
  const [items, setItems] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [positionOptions, setPositionOptions] = useState<PositionOption[]>(builtinPositions);
  const [newPositionName, setNewPositionName] = useState('');
  const [newPositionPermissions, setNewPositionPermissions] = useState<Permission[]>(['OVERVIEW']);
  const [newPositionReason, setNewPositionReason] = useState('');
  const [editingPositionKey, setEditingPositionKey] = useState('');
  const [positionDraft, setPositionDraft] = useState<PositionDraft | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [position, setPosition] = useState<string>('SUPERVISOR');
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>(builtinPositions[1].permissions);
  const [reason, setReason] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [result, positionResult] = await Promise.all([
        request<{ items: Collaborator[] }>('/api/admin/collaborators'),
        request<{ positions: PositionOption[] }>('/api/admin/collaborator-positions')
      ]);
      setItems(result.items);
      setPositionOptions(positionResult.positions);
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const enabledCount = useMemo(() => items.filter(item => item.enabled).length, [items]);
  const customPositions = useMemo(() => positionOptions.filter(item => !item.builtIn), [positionOptions]);
  const positionName = (key: string) => positionOptions.find(item => item.key === key)?.name ?? display(key);
  const positionPermissions = (key: string) => positionOptions.find(item => item.key === key)?.permissions ?? [];
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await request<{ verificationEmailSent: boolean }>('/api/admin/collaborators', { method: 'POST', body: JSON.stringify({ name, email, password, position, permissions: selectedPermissions, reason }) });
      setName(''); setEmail(''); setPassword(''); setReason('');
      await load();
      setNotice(result.verificationEmailSent ? 'Team account created. A verification email was sent to the collaborator.' : 'Team account created, but verification email delivery is not configured or failed. Ask the collaborator to use account settings to request another email.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };
  const startEdit = (item: Collaborator) => {
    setEditingId(item.id); setError(''); setNotice('');
    setDrafts(current => ({ ...current, [item.id]: { name: item.user.name, position: item.position, permissions: [...item.permissions], enabled: item.enabled, reason: '' } }));
  };
  const updateDraft = (id: string, update: Partial<Draft>) => setDrafts(current => ({ ...current, [id]: { ...current[id]!, ...update } }));
  const save = async (item: Collaborator) => {
    const draft = drafts[item.id];
    if (!draft) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await request<{ sessionsRevoked: number }>('/api/admin/collaborators/' + encodeURIComponent(item.id), { method: 'PATCH', body: JSON.stringify({ name: draft.name, position: draft.position, permissions: draft.permissions, enabled: draft.enabled, reason: draft.reason }) });
      setEditingId('');
      await load();
      setNotice(`Team member updated. ${result.sessionsRevoked ? `${result.sessionsRevoked} existing session(s) were revoked.` : ''}`.trim());
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const createPosition = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(''); setNotice('');
    try {
      await request('/api/admin/collaborator-positions', { method: 'POST', body: JSON.stringify({ name: newPositionName, permissions: newPositionPermissions, reason: newPositionReason }) });
      setNewPositionName(''); setNewPositionReason(''); setNewPositionPermissions(['OVERVIEW']);
      await load();
      setNotice('Custom team position created. Its permission template will apply when selected for a collaborator.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const startPositionEdit = (item: PositionOption) => {
    setEditingPositionKey(item.key); setError(''); setNotice('');
    setPositionDraft({ name: item.name, permissions: [...item.permissions], enabled: item.enabled, reason: '' });
  };

  const savePosition = async () => {
    if (!positionDraft || !editingPositionKey) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await request('/api/admin/collaborator-positions/' + encodeURIComponent(editingPositionKey), { method: 'PATCH', body: JSON.stringify(positionDraft) });
      setEditingPositionKey(''); setPositionDraft(null);
      await load();
      setNotice('Team position updated. Existing collaborator permissions were not changed.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  return <section className="platformCollaborators">
    <header className="collaboratorHeading"><div><p className="eyebrow">People and access</p><h2>Platform team</h2><p className="muted">Create named collaborator accounts, assign a position, and grant only the platform modules each person needs.</p></div><div className="collaboratorStat"><strong>{enabledCount}</strong><span>enabled team members</span></div></header>
    <div className="notice collaboratorBoundary"><strong>Security boundary:</strong> a team position is not a platform administrator account. Collaborators cannot manage other collaborators or change their own access. Email verification is required before privileged modules work.</div>
    {error && <div className="notice collaboratorError" role="alert">{error}</div>}
    {notice && <div className="notice collaboratorSuccess" role="status">{notice}</div>}

    <section className="card cardBody collaboratorPositionManager">
      <div><p className="eyebrow">Reusable access templates</p><h3>Manage team positions</h3><p className="muted">Create custom positions and choose their default module permissions. Editing a template does not silently change existing team members’ access. Reassign members before archiving a position.</p></div>
      <form className="collaboratorPositionCreate" onSubmit={event => void createPosition(event)}>
        <label>New position name<input required minLength={2} maxLength={48} value={newPositionName} onChange={event => setNewPositionName(event.target.value)} placeholder="For example, Customer Success Lead" /></label>
        <PermissionPicker value={newPositionPermissions} onChange={setNewPositionPermissions} name={newPositionName || 'new position'} />
        <label>Audit reason<input required minLength={8} maxLength={500} value={newPositionReason} onChange={event => setNewPositionReason(event.target.value)} placeholder="Why is this position being added?" /></label>
        <button className="primary" disabled={saving || newPositionPermissions.length === 0}>{saving ? 'Saving…' : 'Add position'}</button>
      </form>
      <div className="collaboratorBuiltins"><strong>Built-in positions</strong>{builtinPositions.map(item => <span key={item.key}>{item.name}</span>)}</div>
      <div className="collaboratorCustomPositions"><h4>Custom positions</h4>{customPositions.length === 0 ? <div className="empty">No custom positions yet. Add one above to create a reusable permission template.</div> : customPositions.map(item => {
        const editing = editingPositionKey === item.key && positionDraft;
        return <article className="collaboratorCustomPosition" key={item.key}>
          {!editing ? <><div><strong>{item.name}</strong><span className={`collaboratorStatus ${item.enabled ? 'enabled' : 'disabled'}`}>{item.enabled ? 'Available' : 'Archived'}</span><small>{item.permissions.length} default module permission{item.permissions.length === 1 ? '' : 's'}</small></div><button type="button" onClick={() => startPositionEdit(item)}>Manage position</button></> : <div className="collaboratorPositionEdit">
            <label>Position name<input required minLength={2} maxLength={48} value={positionDraft.name} onChange={event => setPositionDraft({ ...positionDraft, name: event.target.value })} /></label>
            <PermissionPicker value={positionDraft.permissions} onChange={value => setPositionDraft({ ...positionDraft, permissions: value })} name={positionDraft.name} />
            <label className="collaboratorEnabled"><input type="checkbox" checked={positionDraft.enabled} onChange={event => setPositionDraft({ ...positionDraft, enabled: event.target.checked })} /> Position available for assignment</label>
            <label>Audit reason<input required minLength={8} maxLength={500} value={positionDraft.reason} onChange={event => setPositionDraft({ ...positionDraft, reason: event.target.value })} placeholder="Reason for this position change" /></label>
            <div className="collaboratorActions"><button type="button" disabled={saving} onClick={() => { setEditingPositionKey(''); setPositionDraft(null); }}>Cancel</button><button type="button" className="primary" disabled={saving || positionDraft.permissions.length === 0 || positionDraft.reason.trim().length < 8} onClick={() => void savePosition()}>{saving ? 'Saving…' : 'Save position'}</button></div>
          </div>}
        </article>;
      })}</div>
    </section>

    <form className="card cardBody collaboratorCreate" onSubmit={event => void create(event)}>
      <div><p className="eyebrow">New collaborator</p><h3>Create a team account</h3><p className="muted">The password is used only to create the account and is never shown again. The collaborator must verify their email before using the assigned workspace.</p></div>
      <div className="collaboratorFormGrid">
        <label>Full name<input required minLength={2} maxLength={100} autoComplete="name" value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Work email<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Initial password<input required type="password" minLength={12} maxLength={72} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /><small>Use at least 12 characters. Share it through a secure channel.</small></label>
        <label>Position<select value={position} onChange={event => { const next = event.target.value; setPosition(next); setSelectedPermissions(positionPermissions(next)); }}>{positionOptions.filter(item => item.enabled).map(item => <option key={item.key} value={item.key}>{item.name}{item.builtIn ? '' : ' (Custom)'}</option>)}</select><small>Changing this applies the recommended permissions for that position; adjust them below if needed.</small></label>
        <label className="collaboratorWide">Audit reason<input required minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why is this collaborator being added?" /></label>
        <div className="collaboratorWide"><PermissionPicker value={selectedPermissions} onChange={setSelectedPermissions} name={name || 'new collaborator'} /></div>
      </div>
      <button className="primary" disabled={saving}>{saving ? 'Creating account…' : 'Create collaborator'}</button>
    </form>

    <div className="collaboratorListHeading"><div><h3>Team accounts</h3><p className="muted">Access updates are audited and revoke active sessions when permissions change.</p></div><button type="button" onClick={() => void load()} disabled={loading || saving}>{loading ? 'Refreshing…' : 'Refresh team'}</button></div>
    {loading ? <div className="empty" role="status" aria-busy="true">Loading team accounts…</div> : items.length === 0 ? <div className="empty">No platform collaborators yet. Create the first team account above.</div> : <div className="collaboratorCards">{items.map(item => {
      const draft = drafts[item.id];
      const isEditing = editingId === item.id && Boolean(draft);
      return <article className={`card collaboratorCard${item.enabled ? '' : ' isDisabled'}`} key={item.id}>
        <header><div><span className={`collaboratorStatus ${item.enabled ? 'enabled' : 'disabled'}`}>{item.enabled ? 'Enabled' : 'Disabled'}</span><h4>{item.user.name}</h4><p>{item.user.email}</p></div><span className="collaboratorPosition">{positionName(item.position)}</span></header>
        {!isEditing ? <><div className="collaboratorMeta"><span>{item.user.emailVerifiedAt ? 'Email verified' : 'Verification pending'}</span><span>Account: {display(item.user.accountStatus)}</span><span>{item.permissions.length} module permission{item.permissions.length === 1 ? '' : 's'}</span></div><div className="collaboratorGranted">{item.permissions.length ? item.permissions.map(permission => <span key={permission}>{permissions.find(([key]) => key === permission)?.[1] ?? permission}</span>) : <span>No modules assigned</span>}</div><button type="button" onClick={() => startEdit(item)}>Edit access</button></> : <div className="collaboratorEdit">
          <label>Full name<input value={draft.name} minLength={2} maxLength={100} onChange={event => updateDraft(item.id, { name: event.target.value })} /></label>
          <label>Position<select value={draft.position} onChange={event => { const next = event.target.value; updateDraft(item.id, { position: next, permissions: positionPermissions(next) }); }}>{positionOptions.filter(option => option.enabled || option.key === draft.position).map(option => <option key={option.key} value={option.key}>{option.name}{option.builtIn ? '' : option.enabled ? ' (Custom)' : ' (Archived)'}</option>)}</select></label>
          <PermissionPicker value={draft.permissions} onChange={value => updateDraft(item.id, { permissions: value })} name={item.user.name} />
          <label className="collaboratorEnabled"><input type="checkbox" checked={draft.enabled} onChange={event => updateDraft(item.id, { enabled: event.target.checked })} /> Account access enabled</label>
          <label>Audit reason<input required minLength={8} maxLength={500} value={draft.reason} onChange={event => updateDraft(item.id, { reason: event.target.value })} placeholder="Reason for this access change" /></label>
          <div className="collaboratorActions"><button type="button" disabled={saving} onClick={() => { setEditingId(''); setDrafts(current => { const next = { ...current }; delete next[item.id]; return next; }); }}>Cancel</button><button type="button" className="primary" disabled={saving || draft.reason.trim().length < 8} onClick={() => void save(item)}>{saving ? 'Saving…' : 'Save changes'}</button></div>
        </div>}
      </article>;
    })}</div>}
  </section>;
}
