import { useEffect, useState } from 'react';
import './JimaWidget.css';
import './JimaWidgetHistory.css';
import { JimaRecommendations } from './JimaRecommendations.js';

type JimaSource = { id: string; reference: string; type: 'product' | 'store' | 'help'; title: string; href: string };
type ChatLine = { role: 'user' | 'assistant'; content: string; sources?: JimaSource[] };
type SavedConversation = { id: string; title: string; updatedAt: string; messages: ChatLine[] };
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error ?? 'Jima is temporarily unavailable.') as Error & { details?: typeof body }; error.details = body; throw error; }
  return body as T;
}

export function JimaWidget({ userName }: { userName?: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [shareContext, setShareContext] = useState(false);
  const [ticketNumber, setTicketNumber] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { void request<{ enabled: boolean }>('/api/ai/status').then(value => setAvailable(value.enabled)).catch(() => setAvailable(false)); }, []);
  const loadHistory = async () => { if (!userName) return; try { setConversations(await request<SavedConversation[]>('/api/ai/conversations')); } catch (error) { setNotice((error as Error).message); } };
  useEffect(() => { if (available && userName) void loadHistory(); }, [available, userName]);
  if (!available || /\/admin\//.test(location.pathname) || location.pathname === '/checkout') return null;
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!input.trim() || busy) return;
    const message = input.trim(); setInput(''); setLines(current => [...current, { role: 'user', content: message }]); setNotice(''); setBusy(true);
    const pagePath = /^\/(?:products\/[A-Za-z0-9_-]{1,100}|store\/[a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.test(location.pathname) ? location.pathname : undefined;
    try { const result = await request<{ answer: string; conversationId: string; sources?: JimaSource[] }>('/api/ai/chat', { method: 'POST', body: JSON.stringify({ message, conversationId, pagePath }) }); setConversationId(result.conversationId); setLines(current => [...current, { role: 'assistant', content: result.answer, sources: result.sources }]); }
    catch (error) { const details = (error as Error & { details?: { conversationId?: string } }).details; if (details?.conversationId) setConversationId(details.conversationId); setNotice((error as Error).message); void loadHistory(); }
    finally { setBusy(false); }
  };
  const handoff = async () => { if (!conversationId || !shareContext) return; setBusy(true); try { const result = await request<{ ticketNumber: string; message: string }>(`/api/ai/conversations/${conversationId}/handoff`, { method: 'POST', body: JSON.stringify({ includeConversation: true }) }); setTicketNumber(result.ticketNumber); setNotice(`${result.message} Reference: ${result.ticketNumber}`); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const startNew = () => { setConversationId(undefined); setLines([]); setShareContext(false); setTicketNumber(''); setNotice('Started a new conversation.'); };
  const selectConversation = (conversation: SavedConversation) => { setConversationId(conversation.id); setLines(conversation.messages); setNotice(''); };
  const deleteConversation = async (id: string) => { if (!window.confirm('Delete this Jima conversation and its messages?')) return; setBusy(true); try { await request(`/api/ai/conversations/${id}`, { method: 'DELETE' }); if (conversationId === id) startNew(); await loadHistory(); setNotice('Conversation deleted.'); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const deleteAll = async () => { if (!window.confirm('Delete all your Jima conversations and messages? This cannot be undone.')) return; setBusy(true); try { await request('/api/ai/conversations', { method: 'DELETE' }); startNew(); setConversations([]); setNotice('All Jima conversations deleted.'); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  return <div className="jimaWidget">
    {open && <section className="jimaPanel" aria-label="Jima AI assistant" aria-live="polite">
      <header><div><strong>Jima AI</strong><small>Marketplace assistant · AI, not a human</small></div><button type="button" aria-label="Close Jima" onClick={() => setOpen(false)}>×</button></header>
      {userName && <div className="jimaHistoryBar"><button type="button" onClick={startNew}>New chat</button><details><summary>History ({conversations.length})</summary><div className="jimaHistoryList">{conversations.map(item => <div key={item.id}><button type="button" onClick={() => selectConversation(item)}>{item.title}</button><button type="button" aria-label={`Delete conversation: ${item.title}`} disabled={busy} onClick={() => void deleteConversation(item.id)}>Delete</button></div>)}{conversations.length > 0 && <button type="button" disabled={busy} onClick={() => void deleteAll()}>Delete all conversations</button>}</div></details></div>}
      <JimaRecommendations placement="widget" />
      <div className="jimaTranscript" role="log">{!lines.length && <p className="jimaWelcome">Hi{userName ? `, ${userName}` : ''}. I can help find approved products and answer from published marketplace help. I can’t verify private order details yet.</p>}{lines.map((line, i) => <div className={`jimaMessage jima-${line.role}`} key={i}><p className="jimaLine"><span>{line.role === 'user' ? 'You' : 'Jima'}</span>{line.content}</p>{Boolean(line.sources?.length) && <div className="jimaSourceList"><span>Sources</span>{line.sources!.map(source => <a key={source.href} href={source.href}><small>[{source.reference}]</small> {source.title}<small> · {source.type}</small></a>)}</div>}</div>)}{busy && <p className="jimaPending" role="status">Jima is checking…</p>}</div>
      {notice && <p className="jimaNotice" role="status">{notice}</p>}
      {userName && conversationId && <label className="jimaConsent" id="jima-handoff-consent"><input type="checkbox" checked={shareContext} onChange={event => setShareContext(event.target.checked)} />Share this conversation with a human support agent. Recent messages will be copied into your private support ticket. Never include passwords or payment details.</label>}
      <button className="jimaHandoff" type="button" disabled={busy || !userName || !conversationId || !shareContext} onClick={() => void handoff()}>Request human support</button>
      {ticketNumber && <a className="jimaSupportLink" href="/dashboard?tab=messages">View support ticket {ticketNumber}</a>}
      {!userName && <small className="jimaSignIn">Sign in to chat privately and request support.</small>}
      <form onSubmit={send}><label className="srOnly" htmlFor="jima-input">Message Jima</label><input id="jima-input" value={input} onChange={event => setInput(event.target.value)} maxLength={1000} placeholder="Ask about the marketplace…" disabled={busy} /><button type="submit" disabled={busy || !input.trim()}>Send</button></form>
    </section>}
    <button className="jimaFab" type="button" aria-expanded={open} aria-label={open ? 'Close Jima AI assistant' : 'Open Jima AI assistant'} onClick={() => setOpen(value => !value)}>✦ Jima AI</button>
  </div>;
}
