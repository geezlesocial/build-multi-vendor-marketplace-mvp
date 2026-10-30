import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import './Wallet.css';

type GateState = { walletEnabled: boolean; walletFundingEnabled: boolean; walletTransfersEnabled: boolean; walletCheckoutEnabled: boolean; walletWithdrawalsEnabled: boolean; walletEmergencyPause: boolean; moneyMovementHardDisabled: boolean; walletFundingProviderReady: boolean; clubCoinsEnabled: boolean; clubCoinsEarnEnabled: boolean; clubCoinsRedeemEnabled: boolean; clubCoinsHardDisabled: boolean; clubCoinName: string };
type WalletResponse = { account: { id: string | null; walletId: string | null; status: string; balances: Array<{ currency: string; availableMinor: number; pendingMinor: number; heldMinor: number; frozenMinor: number }> }; currencyOptions: Array<{ code: string; name: string; symbol: string | null }>; walletDisplayCurrency: string; transactions: Array<{ id: string; amountMinor: number; direction: string; currency: string; status: string; type: string; createdAt: string }>; gates: GateState };
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
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [working, setWorking] = useState(false);
  const [copiedWalletId, setCopiedWalletId] = useState(false);
  const load = async () => { try { setData(await request<WalletResponse>('/api/wallet')); } catch (error) { setMessage((error as Error).message); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (data?.currencyOptions.length && !data.currencyOptions.some(item => item.code === currency)) setCurrency(data.currencyOptions[0].code); }, [data, currency]);
  if (!data) return <section className="page"><h1>Wallet</h1>{message ? <p className="notice">{message}</p> : <p>Loading wallet…</p>}</section>;
  const transfersAvailable = data.gates.walletTransfersEnabled;
  const copyWalletId = async () => {
    if (!data.account.walletId) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.account.walletId);
      } else {
        const copyField = document.createElement('textarea');
        copyField.value = data.account.walletId;
        copyField.setAttribute('readonly', '');
        copyField.style.position = 'fixed';
        copyField.style.opacity = '0';
        document.body.appendChild(copyField);
        copyField.select();
        const copied = document.execCommand('copy');
        copyField.remove();
        if (!copied) throw new Error('Clipboard access is unavailable.');
      }
      setCopiedWalletId(true);
      setMessage('eWallet ID copied to clipboard.');
      window.setTimeout(() => setCopiedWalletId(false), 1800);
    } catch {
      setMessage('Could not copy automatically. You can select the eWallet ID and copy it.');
    }
  };
  const activate = async () => {
    setWorking(true); setMessage('');
    try { await request('/api/wallet/activate', { method: 'POST', body: '{}' }); setMessage('Your eWallet is active.'); await load(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const submitTransfer = async (event: React.FormEvent) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      await request('/api/wallet/transfers', { method: 'POST', body: JSON.stringify({ recipient, amountMinor: Math.round(Number(amount) * 100), currency, idempotencyKey: `web-${crypto.randomUUID()}` }) });
      setRecipient(''); setAmount(''); setMessage('Transfer completed.'); await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  return <section className="page">
    <p className="eyebrow">Account funds</p><h1>eWallet</h1>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="notice">{data.gates.moneyMovementHardDisabled ? 'Real-money movement is disabled by server policy.' : data.gates.walletEmergencyPause ? 'Wallet money movement is paused by platform policy.' : 'Wallet policy is active.'} Your wallet is separate from order and settlement currencies.</div>
    <article className="card cardBody">
      <h2>Your eWallet ID</h2>
      {data.account.walletId ? <><div className="walletIdentityRow"><strong className="walletIdentity">{data.account.walletId}</strong><button className="walletCopyButton" type="button" onClick={() => void copyWalletId()} aria-label={copiedWalletId ? 'eWallet ID copied' : 'Copy eWallet ID'} title={copiedWalletId ? 'Copied' : 'Copy eWallet ID'}><svg aria-hidden="true" viewBox="0 0 20 20" focusable="false"><rect x="6.5" y="6.5" width="9" height="10" rx="1.5"/><path d="M4.5 13.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/></svg><span>{copiedWalletId ? 'Copied' : 'Copy'}</span></button></div><p className="muted">Share this ID or your verified account email to receive a transfer.</p></> : <><p>Activate your personal eWallet to receive a permanent wallet ID.</p><button className="primary" type="button" disabled={working} onClick={() => void activate()}>{working ? 'Activating…' : 'Activate eWallet'}</button></>}
    </article>
    <div className="grid">{data.account.balances.length === 0 ? <article className="card cardBody walletZeroBalance"><p className="eyebrow">Wallet balance · {data.walletDisplayCurrency}</p><h2>Available <strong>{money(0, data.walletDisplayCurrency)}</strong></h2><p className="muted">No funds in this wallet yet. Provider funding is only available after the platform configures and enables a payment gateway.</p></article> : data.account.balances.map(balance => <article className="card cardBody" key={balance.currency}><h2>{balance.currency}</h2><p>Available <strong>{money(balance.availableMinor, balance.currency)}</strong></p><p>Pending {money(balance.pendingMinor, balance.currency)}</p><p>Held {money(balance.heldMinor, balance.currency)}</p><p>Frozen {money(balance.frozenMinor, balance.currency)}</p></article>)}</div>
    {transfersAvailable && data.account.walletId && <form className="setting narrow" onSubmit={event => void submitTransfer(event)}>
      <h2>Send funds</h2><p className="muted">Only active eWallets belonging to users with verified email can receive transfers.</p>
      <label>Recipient eWallet ID or verified email<input required maxLength={254} value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="UIB000123 or name@example.com" /></label>
      <label>Currency<select required value={currency} onChange={event => setCurrency(event.target.value)}>{data.currencyOptions.map(item => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
      <label>Amount<input type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} /></label>
      <button className="primary" disabled={working}>{working ? 'Sending…' : 'Send transfer'}</button>
    </form>}
    <section><h2>Wallet activity</h2>{data.transactions.length === 0 ? <div className="empty">No wallet transactions.</div> : <div className="table">{data.transactions.map(transaction => <div className="row" key={transaction.id}><span>{transaction.type} · {transaction.direction}</span><span>{money(transaction.amountMinor, transaction.currency)}</span><span>{transaction.status}</span></div>)}</div>}</section>
    <p className="muted">External top-ups and withdrawals remain unavailable until the relevant provider credentials, verified webhook endpoints, and server-side money-movement gate are configured. A return from a payment page alone never credits your wallet.</p>
  </section>;
}

export function ClubCoins() {
  const [data, setData] = useState<CoinResponse | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { void request<CoinResponse>('/api/club-coins').then(setData).catch(error => setMessage((error as Error).message)); }, []);
  if (!data) return <section className="page"><h1>Club Coins</h1>{message ? <p className="notice">{message}</p> : <p>Loading Club Coins…</p>}</section>;
  return <section className="page"><p className="eyebrow">Loyalty program</p><h1>{data.gates.clubCoinName}</h1><div className="notice">{data.gates.clubCoinsHardDisabled || !data.gates.clubCoinsEnabled ? 'Club Coins are currently disabled.' : 'Club Coins are non-cash loyalty units. They cannot be withdrawn or treated as a bank balance.'}</div><article className="card cardBody"><h2>Balance</h2><strong>{data.account.balance.toLocaleString()} coins</strong><p className="muted">Earning requires a paid order and buyer receipt confirmation for every item. Refunds and disputes reverse purchase awards; if an award was already used, future earnings offset the negative balance. Redemption, conversion, and transfers are controlled separately by the platform.</p></article><section><h2>Activity</h2>{data.entries.length === 0 ? <div className="empty">No Club Coins activity.</div> : <div className="table">{data.entries.map(entry => <div className="row" key={entry.id}><span>{entry.entryType}</span><span>{entry.amount > 0 ? '+' : ''}{entry.amount}</span><span>{new Date(entry.createdAt).toLocaleDateString()}</span></div>)}</div>}</section></section>;
}
