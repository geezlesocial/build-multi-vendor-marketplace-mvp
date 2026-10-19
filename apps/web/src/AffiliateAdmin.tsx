import React, { useEffect, useState } from 'react';

type AffiliateSettings = { affiliateEnabled: boolean; affiliateFundingConfigured: boolean; affiliateAttributionRule: 'LAST_VALID_CLICK' | 'FIRST_VALID_CLICK'; affiliateAttributionWindowDays: number; affiliateMinimumPayoutMinor: number };
type Affiliate = { id: string; status: string; user: { email: string; name: string }; _count: { clicks: number; commissions: number; payouts: number } };
type Payout = { id: string; amountMinor: number; currency: string; status: string; affiliate: { user: { email: string } }; reference?: string | null };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function AffiliateAdmin() {
  const [settings, setSettings] = useState<AffiliateSettings | null>(null);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [message, setMessage] = useState('');
  const load = async () => { const [nextSettings, nextAffiliates, nextPayouts] = await Promise.all([request<AffiliateSettings>('/api/admin/affiliate-settings'), request<Affiliate[]>('/api/admin/affiliates'), request<Payout[]>('/api/admin/affiliate-payouts')]); setSettings(nextSettings); setAffiliates(nextAffiliates); setPayouts(nextPayouts); };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  const update = async (body: object) => { try { await request('/api/admin/affiliate-settings', { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (error) { setMessage((error as Error).message); } };
  const status = async (id: string, next: string) => { try { await request(`/api/admin/affiliates/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next, reason: 'Reviewed in admin console' }) }); await load(); } catch (error) { setMessage((error as Error).message); } };
  const payout = async (id: string, next: 'APPROVED' | 'REJECTED' | 'PAID') => { try { await request(`/api/admin/affiliate-payouts/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next, reference: next === 'PAID' ? `manual-confirmation-${id}` : undefined }) }); await load(); } catch (error) { setMessage((error as Error).message); } };
  return <section className="page"><p className="eyebrow">Platform-funded referrals</p><h2>Affiliate program</h2>{message && <p className="notice">{message}</p>}{settings && <div className="settings"><div className="setting"><div><strong>Program</strong><p>Applications, links, and attribution are rejected while disabled.</p></div><button onClick={() => update({ affiliateEnabled: !settings.affiliateEnabled })}>{settings.affiliateEnabled ? 'Enabled' : 'Disabled'}</button></div><div className="setting"><div><strong>Funding policy configured</strong><p>Required before payout requests or paid records.</p></div><button onClick={() => update({ affiliateFundingConfigured: !settings.affiliateFundingConfigured })}>{settings.affiliateFundingConfigured ? 'Configured' : 'Not configured'}</button></div><div className="setting"><div><strong>Attribution window</strong><p>{settings.affiliateAttributionWindowDays} days · {settings.affiliateAttributionRule}</p></div><button onClick={() => update({ affiliateAttributionWindowDays: settings.affiliateAttributionWindowDays === 30 ? 7 : 30 })}>Change window</button></div></div>}<h3>Applications</h3><div className="table">{affiliates.map(item => <div className="row" key={item.id}><span>{item.user.name} · {item.user.email}<small>{item._count.clicks} clicks · {item._count.commissions} ledger entries</small></span><span>{item.status}</span><select value={item.status} onChange={event => status(item.id, event.target.value)}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>PAUSED</option><option>TERMINATED</option></select></div>)}{affiliates.length === 0 && <p className="muted">No affiliate applications.</p>}</div><h3>Payout review</h3><div className="table">{payouts.map(item => <div className="row" key={item.id}><span>{item.affiliate.user.email} · {(item.amountMinor / 100).toFixed(2)} {item.currency}</span><span>{item.status}</span><span><button onClick={() => payout(item.id, 'APPROVED')}>Approve</button> <button onClick={() => payout(item.id, 'REJECTED')}>Reject</button> <button onClick={() => payout(item.id, 'PAID')}>Mark paid</button></span></div>)}{payouts.length === 0 && <p className="muted">No payout requests.</p>}</div><p className="muted">Payouts are manual, platform-funded liabilities. The system never initiates a transfer.</p></section>;
}
