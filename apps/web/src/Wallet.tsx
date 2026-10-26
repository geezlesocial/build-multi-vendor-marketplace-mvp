import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

type GateState = { walletEnabled: boolean; walletFundingEnabled: boolean; walletTransfersEnabled: boolean; walletCheckoutEnabled: boolean; walletWithdrawalsEnabled: boolean; walletEmergencyPause: boolean; moneyMovementHardDisabled: boolean; walletFundingProviderReady: boolean; clubCoinsEnabled: boolean; clubCoinsEarnEnabled: boolean; clubCoinsRedeemEnabled: boolean; clubCoinsHardDisabled: boolean; clubCoinName: string };
type WalletResponse = { account: { status: string; balances: Array<{ currency: string; availableMinor: number; pendingMinor: number; heldMinor: number; frozenMinor: number }> }; transactions: Array<{ id: string; amountMinor: number; direction: string; currency: string; status: string; type: string; createdAt: string }>; gates: GateState };
type CoinResponse = { account: { status: string; balance: number }; entries: Array<{ id: string; amount: number; entryType: string; reason?: string | null; createdAt: string }>; gates: GateState };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

const money = (minor: number, currency: string) => formatMinor(minor, currency);

export function Wallet() {
  const [data, setData] = useState<WalletResponse | null>(null);
  const [message, setMessage] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [amount, setAmount] = useState('');
  const load = async () => { try { setData(await request<WalletResponse>('/api/wallet')); } catch (error) { setMessage((error as Error).message); } };
  useEffect(() => { void load(); }, []);
  if (!data) return <section className="page"><h1>Wallet</h1>{message ? <p className="notice">{message}</p> : <p>Loading wallet…</p>}</section>;
  const transfersAvailable = data.gates.walletTransfersEnabled;
  const submitTransfer = async (event: React.FormEvent) => { event.preventDefault(); setMessage(''); try { await request('/api/wallet/transfers', { method: 'POST', body: JSON.stringify({ recipientEmail, amountMinor: Math.round(Number(amount) * 100), currency: data.account.balances[0]?.currency ?? 'USD', idempotencyKey: `web-${crypto.randomUUID()}` }) }); setRecipientEmail(''); setAmount(''); setMessage('Transfer submitted.'); await load(); } catch (error) { setMessage((error as Error).message); } };
  return <section className="page"><p className="eyebrow">Account funds</p><h1>Wallet</h1>{message && <p className="notice" role="status">{message}</p>}<div className="notice">{data.gates.moneyMovementHardDisabled ? 'Real-money wallet movement is disabled by server policy.' : data.gates.walletEmergencyPause ? 'Wallet money movement is paused by platform policy.' : 'Wallet policy is active.'} Balances are shown as integer minor units by currency.</div><div className="grid">{data.account.balances.length === 0 ? <div className="empty">No wallet account or balances yet.</div> : data.account.balances.map(balance => <article className="card cardBody" key={balance.currency}><h2>{balance.currency}</h2><p>Available <strong>{money(balance.availableMinor, balance.currency)}</strong></p><p>Pending {money(balance.pendingMinor, balance.currency)}</p><p>Held {money(balance.heldMinor, balance.currency)}</p><p>Frozen {money(balance.frozenMinor, balance.currency)}</p></article>)}</div>{transfersAvailable && <form className="setting narrow" onSubmit={submitTransfer}><h2>Send funds</h2><label>Recipient email<input type="email" required value={recipientEmail} onChange={event => setRecipientEmail(event.target.value)} /></label><label>Amount<input type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} /></label><button className="primary">Send transfer</button></form>}<section><h2>Wallet activity</h2>{data.transactions.length === 0 ? <div className="empty">No wallet transactions.</div> : <div className="table">{data.transactions.map(transaction => <div className="row" key={transaction.id}><span>{transaction.type} · {transaction.direction}</span><span>{money(transaction.amountMinor, transaction.currency)}</span><span>{transaction.status}</span></div>)}</div>}</section><p className="muted">Funding, withdrawal, wallet checkout, and external payout providers remain unavailable until separately approved and configured.</p></section>;
}

export function ClubCoins() {
  const [data, setData] = useState<CoinResponse | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { void request<CoinResponse>('/api/club-coins').then(setData).catch(error => setMessage((error as Error).message)); }, []);
  if (!data) return <section className="page"><h1>Club Coins</h1>{message ? <p className="notice">{message}</p> : <p>Loading Club Coins…</p>}</section>;
  return <section className="page"><p className="eyebrow">Loyalty program</p><h1>{data.gates.clubCoinName}</h1><div className="notice">{data.gates.clubCoinsHardDisabled || !data.gates.clubCoinsEnabled ? 'Club Coins are currently disabled.' : 'Club Coins are non-cash loyalty units. They cannot be withdrawn or treated as a bank balance.'}</div><article className="card cardBody"><h2>Balance</h2><strong>{data.account.balance.toLocaleString()} coins</strong><p className="muted">Earning requires a paid order and buyer receipt confirmation for every item. Refunds and disputes reverse purchase awards; if an award was already used, future earnings offset the negative balance. Redemption, conversion, and transfers are controlled separately by the platform.</p></article><section><h2>Activity</h2>{data.entries.length === 0 ? <div className="empty">No Club Coins activity.</div> : <div className="table">{data.entries.map(entry => <div className="row" key={entry.id}><span>{entry.entryType}</span><span>{entry.amount > 0 ? '+' : ''}{entry.amount}</span><span>{new Date(entry.createdAt).toLocaleDateString()}</span></div>)}</div>}</section></section>;
}
