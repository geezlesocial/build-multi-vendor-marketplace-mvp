import React, { useEffect, useRef, useState } from 'react';
import './PublicCampaigns.css';

export type PublicCampaignMedia = { id: string; kind: 'IMAGE' | 'VIDEO'; position: number; href: string | null; altText: string | null; buttonLabel: string | null; url: string };
export type PublicCampaign = { id: string; name: string; placements: string[]; contentJson: Record<string, unknown>; priority: number; startsAt: string | null; endsAt: string | null; media: PublicCampaignMedia[] };

function text(campaign: PublicCampaign, key: string) { const value = campaign.contentJson?.[key]; return typeof value === 'string' ? value : ''; }
function safeHref(value: string | null) {
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.includes('..')) return { href: value, external: false };
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return { href: url.toString(), external: true }; }
  catch { /* Invalid and unsafe campaign links are rendered as plain media. */ }
  return null;
}

function CampaignImageCarousel({ images }: { images: PublicCampaignMedia[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update(); query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (images.length < 2 || paused || reducedMotion) return undefined;
    const timer = window.setInterval(() => setIndex(current => (current + 1) % images.length), 5000);
    return () => window.clearInterval(timer);
  }, [images.length, paused, reducedMotion]);
  useEffect(() => { if (index >= images.length) setIndex(0); }, [images.length, index]);
  if (!images.length) return null;
  const current = images[index];
  const link = safeHref(current.href);
  const image = <img src={current.url} alt={current.altText || 'Marketplace promotion'} loading={index === 0 ? 'eager' : 'lazy'} />;
  return <div className="publicPromotionCarousel" role="region" aria-roledescription="carousel" aria-label="Promotion banners" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false); }}>
    {link ? <a className="publicPromotionBannerLink" href={link.href} target={link.external ? '_blank' : undefined} rel={link.external ? 'noopener noreferrer' : undefined} aria-label={current.altText || 'Open promotion'}>{image}</a> : image}
    {images.length > 1 && <><div className="publicPromotionCarouselControls"><button type="button" aria-label="Previous promotion image" onClick={() => setIndex(currentIndex => (currentIndex - 1 + images.length) % images.length)}>‹</button><span aria-live="polite">{index + 1} / {images.length}</span><button type="button" aria-label="Next promotion image" onClick={() => setIndex(currentIndex => (currentIndex + 1) % images.length)}>›</button></div><div className="publicPromotionDots" aria-label="Select promotion image">{images.map((item, itemIndex) => <button type="button" key={item.id} aria-label={`Show image ${itemIndex + 1}`} aria-current={itemIndex === index} onClick={() => setIndex(itemIndex)} />)}</div></>}
  </div>;
}

function CampaignVideo({ video }: { video: PublicCampaignMedia }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update(); query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion) { node?.pause(); return undefined; }
    if (!('IntersectionObserver' in window)) { void node.play().catch(() => undefined); return undefined; }
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      if (visible) void node.play().catch(() => undefined); else node.pause();
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion, video.id]);
  const link = safeHref(video.href);
  return <div className="publicPromotionVideoRow"><video ref={ref} src={video.url} autoPlay={!reducedMotion} muted loop playsInline controls preload="metadata" aria-label="Promotional video" />{link && video.buttonLabel && <a className="primary publicPromotionVideoButton" href={link.href} target={link.external ? '_blank' : undefined} rel={link.external ? 'noopener noreferrer' : undefined}>{video.buttonLabel}</a>}</div>;
}

export function PublicCampaignCard({ campaign }: { campaign: PublicCampaign }) {
  const media = campaign.media ?? [];
  const images = media.filter(item => item.kind === 'IMAGE').slice(0, 6);
  const video = media.find(item => item.kind === 'VIDEO');
  const destination = text(campaign, 'ctaPath');
  const label = text(campaign, 'ctaLabel');
  const safeInternal = destination.startsWith('/') && !destination.startsWith('//') && !destination.includes('\\') && !destination.includes('..');
  return <article className="publicCampaignCard">
    <p className="eyebrow">Marketplace promotion</p>
    {images.length > 0 && <CampaignImageCarousel images={images} />}
    <div className="publicCampaignCopy"><h3>{text(campaign, 'headline') || campaign.name}</h3>{text(campaign, 'body') && <p>{text(campaign, 'body')}</p>}{safeInternal && label && <a className="primary" href={destination}>{label}</a>}</div>
    {video && <CampaignVideo video={video} />}
  </article>;
}

export function PublicCampaigns({ campaigns }: { campaigns: PublicCampaign[] }) {
  if (!campaigns.length) return null;
  return <section className="publicCampaignRail" aria-labelledby="public-campaigns-title"><div className="sectionHeading"><div><p className="eyebrow">From the marketplace</p><h2 id="public-campaigns-title">Current promotions</h2></div></div><div className="publicCampaignGrid">{campaigns.slice(0, 3).map(campaign => <PublicCampaignCard key={campaign.id} campaign={campaign} />)}</div></section>;
}

export function PublicCampaignPlacement({ placement, title }: { placement: 'collection' | 'category' | 'storefront'; title: string }) {
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = () => {
      if (!active || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      fetch(`/api/campaigns/active?placement=${encodeURIComponent(placement)}`, { credentials: 'include' })
        .then(async response => {
          const body = await response.json().catch(() => []);
          if (!response.ok) throw new Error('Promotions are temporarily unavailable.');
          return body as PublicCampaign[];
        })
        .then(items => { if (active && Array.isArray(items)) setCampaigns(items); })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); };
  }, [placement]);
  if (!campaigns.length) return null;
  const headingId = `public-campaigns-${placement}-title`;
  return <section className="publicCampaignRail" aria-labelledby={headingId}><div className="sectionHeading"><div><p className="eyebrow">From the marketplace</p><h2 id={headingId}>{title}</h2></div></div><div className="publicCampaignGrid">{campaigns.slice(0, 3).map(campaign => <PublicCampaignCard key={campaign.id} campaign={campaign} />)}</div></section>;
}
