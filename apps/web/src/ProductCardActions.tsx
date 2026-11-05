import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from './session.js';
import { announceHeaderActivityChange } from './header-activity-events.js';
import './ProductCardActions.css';
import './ProductContact.css';

type ProductCardActionsProps = {
  productId: string;
  productName: string;
  availableStock: number;
  variantId?: string;
  requiresVariantSelection?: boolean;
  hasSeller: boolean;
  wholesaleMinQuantity?: number | null;
  beforeBuy?: () => void | Promise<void>;
  onSignIn?: () => void;
};

const favoriteIdsByUser = new Map<string, Set<string>>();
const favoriteLoadsByUser = new Map<string, Promise<Set<string>>>();

async function loadFavoriteIds(userId: string) {
  const cached = favoriteIdsByUser.get(userId);
  if (cached) return cached;
  const pending = favoriteLoadsByUser.get(userId);
  if (pending) return pending;
  const load = fetch('/api/favorites/ids', { credentials: 'include' }).then(async response => {
    const body = await response.json().catch(() => ({})) as { productIds?: string[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Could not load your saved products.');
    const ids = new Set(body.productIds ?? []);
    favoriteIdsByUser.set(userId, ids);
    return ids;
  }).finally(() => favoriteLoadsByUser.delete(userId));
  favoriteLoadsByUser.set(userId, load);
  return load;
}

async function mutate<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string } | undefined)?.error ?? 'The marketplace request failed.');
  return body as T;
}

function productUrl(productId: string) {
  return new URL(`/products/${encodeURIComponent(productId)}`, window.location.origin).toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Copy is not available in this browser. You can copy the product address from the address bar.');
}

export function ProductCardActions({ productId, productName, availableStock, variantId, requiresVariantSelection = false, hasSeller, wholesaleMinQuantity, beforeBuy, onSignIn }: ProductCardActionsProps) {
  const { user } = useSession();
  const [isFavorite, setIsFavorite] = useState(false);
  const [favoriteLoading, setFavoriteLoading] = useState(Boolean(user));
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [buyBusy, setBuyBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [sharePosition, setSharePosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactBody, setContactBody] = useState('');
  const [contactBusy, setContactBusy] = useState(false);
  const [contactMessage, setContactMessage] = useState('');
  const [conversationId, setConversationId] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const shareDetailsRef = useRef<HTMLDetailsElement>(null);
  const sharePopoverRef = useRef<HTMLDivElement>(null);
  const contactFieldRef = useRef<HTMLTextAreaElement>(null);
  const href = productUrl(productId);
  const shareText = `${productName} — ${href}`;
  const login = () => { if (onSignIn) onSignIn(); else window.location.assign('/?auth=login'); };

  useEffect(() => {
    let active = true;
    if (!user) {
      setIsFavorite(false);
      setFavoriteLoading(false);
      return () => { active = false; };
    }
    setFavoriteLoading(true);
    loadFavoriteIds(user.id)
      .then(ids => { if (active) setIsFavorite(ids.has(productId)); })
      .catch(() => { if (active) setIsFavorite(false); })
      .finally(() => { if (active) setFavoriteLoading(false); });
    return () => { active = false; };
  }, [productId, user?.id]);

  useEffect(() => {
    const onFavoriteChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; productId: string; favorited: boolean }>).detail;
      if (detail?.userId === user?.id && detail.productId === productId) setIsFavorite(detail.favorited);
    };
    window.addEventListener('marketplace:favorite-changed', onFavoriteChanged);
    return () => window.removeEventListener('marketplace:favorite-changed', onFavoriteChanged);
  }, [productId, user?.id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (contactOpen && !dialog.open) dialog.showModal();
    else if (!contactOpen && dialog.open) dialog.close();
    if (contactOpen) contactFieldRef.current?.focus();
  }, [contactOpen]);

  useEffect(() => {
    if (!shareOpen) return undefined;
    const positionPopover = () => {
      const summary = shareDetailsRef.current?.querySelector('summary');
      if (!summary) return;
      const bounds = summary.getBoundingClientRect();
      const width = Math.min(288, Math.max(220, window.innerWidth - 24));
      const spaceAbove = Math.max(0, bounds.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - bounds.bottom - 20);
      const placeAbove = spaceBelow < 320 && spaceAbove > spaceBelow;
      const availableSpace = placeAbove ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(80, Math.min(320, availableSpace - 8));
      const top = placeAbove ? bounds.top - maxHeight - 8 : bounds.bottom + 8;
      const left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12));
      setSharePosition({ top: Math.max(12, top), left, width, maxHeight });
    };
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (shareDetailsRef.current?.contains(target) || sharePopoverRef.current?.contains(target)) return;
      if (shareDetailsRef.current) shareDetailsRef.current.open = false;
      setShareOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (shareDetailsRef.current) shareDetailsRef.current.open = false;
      setShareOpen(false);
      shareDetailsRef.current?.querySelector('summary')?.focus();
    };
    positionPopover();
    const focusFrame = window.requestAnimationFrame(() => sharePopoverRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [shareOpen]);

  const closeShareMenu = () => {
    if (shareDetailsRef.current) shareDetailsRef.current.open = false;
    setShareOpen(false);
    shareDetailsRef.current?.querySelector('summary')?.focus();
  };

  const toggleFavorite = async () => {
    if (!user) { login(); return; }
    if (favoriteBusy || favoriteLoading) return;
    setFavoriteBusy(true);
    try {
      const next = !isFavorite;
      await mutate(next ? `/api/favorites/${encodeURIComponent(productId)}` : `/api/favorites/${encodeURIComponent(productId)}`, next
        ? { method: 'POST', body: '{}' }
        : { method: 'DELETE' });
      const ids = favoriteIdsByUser.get(user.id) ?? new Set<string>();
      favoriteIdsByUser.set(user.id, ids);
      if (next) ids.add(productId); else ids.delete(productId);
      setIsFavorite(next);
      window.dispatchEvent(new CustomEvent('marketplace:favorite-changed', { detail: { userId: user.id, productId, favorited: next } }));
      announceHeaderActivityChange();
    } catch (error) {
      setShareMessage((error as Error).message);
    } finally { setFavoriteBusy(false); }
  };

  const buyNow = async () => {
    if (requiresVariantSelection && !variantId) { setShareMessage('Choose a color or option before continuing to checkout.'); return; }
    if (!user) { login(); return; }
    if (buyBusy || availableStock < 1) return;
    setBuyBusy(true);
    setShareMessage('');
    try {
      await beforeBuy?.();
      const quantity = wholesaleMinQuantity ?? 1;
      if (quantity > availableStock) throw new Error(`This wholesale listing requires at least ${quantity} units, but only ${availableStock} are available.`);
      await mutate('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity, ...(variantId ? { variantId } : {}) }) });
      window.dispatchEvent(new Event('marketplace:cart-changed'));
      window.location.assign('/checkout');
    } catch (error) {
      setShareMessage((error as Error).message);
      setBuyBusy(false);
    }
  };

  const shareNative = async () => {
    setShareMessage('');
    try {
      if (!navigator.share) {
        await copyText(href);
        setShareMessage('Product link copied. You can paste it into Scrolith or another app.');
        closeShareMenu();
        return;
      }
      await navigator.share({ title: productName, text: productName, url: href });
      setShareMessage('Share menu opened. Choose Scrolith or another available app.');
      closeShareMenu();
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError') setShareMessage((error as Error).message || 'Could not open the share menu.');
    }
  };

  const copyLink = async () => {
    try { await copyText(href); setShareMessage('Product link copied.'); closeShareMenu(); }
    catch (error) { setShareMessage((error as Error).message); }
  };

  const sendContact = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) { login(); return; }
    setContactBusy(true);
    setContactMessage('');
    try {
      const result = await mutate<{ conversationId: string }>('/api/products/' + encodeURIComponent(productId) + '/contact-seller', { method: 'POST', body: JSON.stringify({ body: contactBody }) });
      setConversationId(result.conversationId);
      setContactMessage('Your message was sent to the seller. You can continue the conversation in Messages.');
      setContactBody('');
    } catch (error) { setContactMessage((error as Error).message); }
    finally { setContactBusy(false); }
  };

  const encodedUrl = encodeURIComponent(href);
  const encodedText = encodeURIComponent(productName);
  return <>
    <div className="productCardActions" aria-label={`Actions for ${productName}`}>
      <button type="button" className="productActionButton productLikeButton" aria-pressed={isFavorite} disabled={favoriteLoading || favoriteBusy} onClick={() => void toggleFavorite()}>
        <span aria-hidden="true">{isFavorite ? '♥' : '♡'}</span> {isFavorite ? 'Loved' : 'Like'}
      </button>
      <details ref={shareDetailsRef} className="productShareMenu" onToggle={event => setShareOpen(event.currentTarget.open)}>
        <summary aria-label={`Share ${productName}`} aria-haspopup="true">Share</summary>
      </details>
      {hasSeller && <button type="button" className="productActionButton" onClick={() => { if (!user) { login(); return; } setContactMessage(''); setConversationId(''); setContactOpen(true); }}>Contact seller</button>}
      <button type="button" className="productActionButton productBuyNow" disabled={availableStock < 1 || buyBusy || (requiresVariantSelection && !variantId)} onClick={() => void buyNow()}>
        {buyBusy ? 'Opening checkout…' : requiresVariantSelection && !variantId ? 'Choose an option' : availableStock > 0 ? 'Buy now' : 'Out of stock'}
      </button>
    </div>
    {shareOpen && sharePosition && createPortal(<div
      ref={sharePopoverRef}
      className="productSharePopover"
      role="group"
      aria-label={`Share ${productName}`}
      style={{ position: 'fixed', top: sharePosition.top, left: sharePosition.left, width: sharePosition.width, maxHeight: sharePosition.maxHeight }}
    >
      <button type="button" onClick={() => void shareNative()}>Share via device</button>
      <button type="button" onClick={() => void copyLink()}>Copy product link</button>
      <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`} target="_blank" rel="noopener noreferrer" onClick={closeShareMenu}>Facebook</a>
      <a href={`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`} target="_blank" rel="noopener noreferrer" onClick={closeShareMenu}>X / Twitter</a>
      <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer" onClick={closeShareMenu}>WhatsApp</a>
      <small>Use the device share menu or copy the link to share on Scrolith. Available apps depend on your device.</small>
    </div>, document.body)}
    {shareMessage && <p className="productActionStatus" role="status">{shareMessage}</p>}
    {hasSeller && <dialog ref={dialogRef} className="productContactDialog" aria-labelledby={`contact-seller-title-${productId}`} onClose={() => setContactOpen(false)} onCancel={() => setContactOpen(false)}>
      <form onSubmit={event => void sendContact(event)}>
        <p className="eyebrow">Product inquiry</p>
        <h2 id={`contact-seller-title-${productId}`}>Contact seller</h2>
        <p className="muted">Your message will be sent through Marketplace Messages. Keep payment and personal details secure.</p>
        <div className="productContactListing"><span>Regarding this listing</span><a href={href}>{productName}</a></div>
        {!contactMessage.startsWith('Your message was sent') && <>
          <label htmlFor={`contact-message-${productId}`}>Message<textarea ref={contactFieldRef} id={`contact-message-${productId}`} required minLength={5} maxLength={2000} rows={5} value={contactBody} onChange={event => setContactBody(event.target.value)} placeholder={`Ask the seller about ${productName}`} /></label>
          <div className="productContactActions"><button type="button" onClick={() => setContactOpen(false)}>Cancel</button><button className="primary" type="submit" disabled={contactBusy || contactBody.trim().length < 5}>{contactBusy ? 'Sending…' : 'Send message'}</button></div>
        </>}
        {contactMessage && <p className="notice" role={contactMessage.startsWith('Your message was sent') ? 'status' : 'alert'}>{contactMessage}</p>}
        {conversationId && <p><a href="/dashboard?tab=messages">Open Messages</a> <button type="button" onClick={() => setContactOpen(false)}>Done</button></p>}
      </form>
    </dialog>}
  </>;
}
