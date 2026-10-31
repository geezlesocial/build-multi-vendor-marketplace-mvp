import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrandingImageControl } from './BrandingImageControl.js';
import { SiteChromeFooter, SiteChromeHeader } from './SiteChrome.js';
import { siteChromeContrastWarnings } from './site-chrome-contrast.js';
import { useSession } from './session.js';
import { defaultSiteChrome, type SiteChromeConfiguration, type SiteChromeLink, type SiteChromeSocial } from './site-chrome-types.js';
import './SiteChrome.css';

type Scope = 'platform' | 'store';
type SiteChromeState = { draft: SiteChromeConfiguration; published: SiteChromeConfiguration | null; draftVersion: number; publishedVersion: number | null; pages: { key: string; label: string }[]; revisions: { version: number; changeNote: string | null; createdAt: string; editor: { name: string | null; email: string } }[]; eligible?: boolean; store?: { name: string; slug: string } };
type Tab = 'templates' | 'header' | 'footer' | 'social' | 'visibility' | 'preview' | 'history';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Site appearance request failed.');
  return body as T;
}

const endpoint = (scope: Scope) => scope === 'platform' ? '/api/admin/site-chrome' : '/api/seller/site-chrome';
const tabs: { id: Tab; label: string }[] = [{ id: 'templates', label: 'Templates' }, { id: 'header', label: 'Header' }, { id: 'footer', label: 'Footer' }, { id: 'social', label: 'Social media' }, { id: 'visibility', label: 'Page visibility' }, { id: 'preview', label: 'Preview' }, { id: 'history', label: 'Version history' }];
const headerTemplates = [{ id: 'CLASSIC', title: 'Classic Marketplace', text: 'The familiar, compact Market Lane header.' }, { id: 'EDITORIAL', title: 'Editorial Premium', text: 'A spacious, editorial brand-first layout.' }, { id: 'COMMERCE', title: 'Commerce Pro', text: 'Search-led navigation for product discovery.' }] as const;
const footerTemplates = [{ id: 'MINIMAL', title: 'Minimal Classic', text: 'Simple brand signature and footer links.' }, { id: 'BUSINESS', title: 'Business Columns', text: 'Structured links, contact and social channels.' }, { id: 'SIGNATURE', title: 'Signature Brand', text: 'A more expressive brand composition.' }] as const;
const socialPlatforms: SiteChromeSocial['platform'][] = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'PINTEREST', 'WEBSITE', 'OTHER'];
const newId = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `item${Date.now()}`;
function moveItem<T>(items: T[], index: number, direction: -1 | 1) { const target = index + direction; if (target < 0 || target >= items.length) return items; const next = [...items]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }

export function SiteChromeBuilder({ scope }: { scope: Scope }) {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('templates');
  const [state, setState] = useState<SiteChromeState | null>(null);
  const [config, setConfig] = useState<SiteChromeConfiguration>(defaultSiteChrome);
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const latestLoadRequest = useRef(0);
  const route = endpoint(scope);
  const eligible = scope === 'platform' || Boolean(state?.eligible);
  const brand = useMemo(() => scope === 'platform'
    ? { title: config.header.title || 'Market Lane', tagline: config.header.tagline || 'independent marketplace', logoMediaId: config.header.logoMediaId, path: '/' }
    : { title: state?.store?.name || 'Your Store', tagline: config.header.tagline || 'Independent store', logoMediaId: config.header.logoMediaId, path: state?.store?.slug ? `/store/${state.store.slug}` : '/' }, [scope, config.header.title, config.header.tagline, config.header.logoMediaId, state?.store]);

  const load = useCallback(async () => {
    const requestId = ++latestLoadRequest.current;
    setBusy(true);
    try {
      const loaded = await api<SiteChromeState>(route);
      if (requestId !== latestLoadRequest.current) return;
      setState(loaded);
      setConfig({ ...defaultSiteChrome, ...loaded.draft, header: { ...defaultSiteChrome.header, ...loaded.draft.header }, footer: { ...defaultSiteChrome.footer, ...loaded.draft.footer } });
      setVersion(loaded.draftVersion);
      setDirty(false);
      setMessage('');
    } catch (error) { if (requestId === latestLoadRequest.current) setMessage((error as Error).message); }
    finally { if (requestId === latestLoadRequest.current) setBusy(false); }
  }, [route]);
  useEffect(() => { void load(); }, [load]);

  const change = (next: SiteChromeConfiguration) => { setConfig(next); setDirty(true); };
  const changeHeader = <K extends keyof SiteChromeConfiguration['header']>(key: K, value: SiteChromeConfiguration['header'][K]) => change({ ...config, header: { ...config.header, [key]: value } });
  const changeFooter = <K extends keyof SiteChromeConfiguration['footer']>(key: K, value: SiteChromeConfiguration['footer'][K]) => change({ ...config, footer: { ...config.footer, [key]: value } });

  const saveDraft = async () => {
    if (!eligible) return false;
    setBusy(true); setMessage('Saving draft…');
    try {
      const saved = await api<{ draftVersion: number }>(route, { method: 'PUT', body: JSON.stringify({ expectedVersion: version, configuration: config, reason: 'Header and footer builder changes' }) });
      setVersion(saved.draftVersion); setDirty(false); await load(); setMessage(`Draft saved as version ${saved.draftVersion}.`); return true;
    } catch (error) { setMessage((error as Error).message); return false; }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!eligible) return;
    if (!window.confirm('Publish this site header and footer? The published appearance will update for visitors shortly.')) return;
    setBusy(true); setMessage('Publishing…');
    try {
      let activeVersion = version;
      if (dirty) {
        const saved = await api<{ draftVersion: number }>(route, { method: 'PUT', body: JSON.stringify({ expectedVersion: version, configuration: config, reason: 'Header and footer published' }) });
        activeVersion = saved.draftVersion; setVersion(activeVersion); setDirty(false);
      }
      await api(`${route}/publish`, { method: 'POST', body: JSON.stringify({ expectedVersion: activeVersion }) });
      try { localStorage.setItem('marketplace:site-chrome-published', `${Date.now()}-${Math.random()}`); } catch { /* Same-tab publication still refreshes below. */ }
      window.dispatchEvent(new Event('marketplace:site-chrome-published'));
      await load();
      setMessage('Published. Open marketplace pages refresh the appearance automatically.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const restore = async (revision: number) => {
    if (!window.confirm(`Restore revision ${revision} as a new draft?`)) return;
    setBusy(true);
    try {
      await api(`${route}/revisions/${revision}/restore`, { method: 'POST', body: JSON.stringify({ expectedVersion: version, reason: `Restore revision ${revision}` }) });
      await load(); setMessage(`Revision ${revision} restored as a new draft.`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const addNavigation = () => changeHeader('navigation', [...config.header.navigation, { id: newId(), label: 'New link', href: '/', enabled: true }]);
  const updateNavigation = (index: number, value: Partial<SiteChromeLink>) => { const current = config.header.navigation[index]; const navigation = config.header.navigation.map((link, position) => position === index ? { ...link, ...value } : link); change({ ...config, header: { ...config.header, navigation, ...(current && value.enabled === false && config.header.ctaLinkId === current.id ? { ctaLinkId: null } : {}) } }); };
  const removeNavigation = (index: number) => { const removed = config.header.navigation[index]; change({ ...config, header: { ...config.header, navigation: config.header.navigation.filter((_, position) => position !== index), ...(removed?.id === config.header.ctaLinkId ? { ctaLinkId: null } : {}) } }); };
  const moveNavigation = (index: number, direction: -1 | 1) => changeHeader('navigation', moveItem(config.header.navigation, index, direction));
  const addSection = () => changeFooter('sections', [...config.footer.sections, { id: newId(), title: 'Explore', links: [] }]);
  const updateSection = (index: number, value: Partial<SiteChromeConfiguration['footer']['sections'][number]>) => changeFooter('sections', config.footer.sections.map((section, position) => position === index ? { ...section, ...value } : section));
  const addSocial = () => { if (config.footer.socials.length >= 6) return; changeFooter('socials', [...config.footer.socials, { id: newId(), platform: 'INSTAGRAM', url: 'https://instagram.com/', label: 'Instagram', enabled: true, display: 'ICON_AND_LABEL' }]); };
  const resetDraft = () => { if (!window.confirm('Reset the editable header, footer and page visibility draft to the inherited default? This does not change the currently published version.')) return; change(defaultSiteChrome); };

  if (!state && busy) return <section className="page siteChromeBuilder"><p className="eyebrow">Site appearance</p><h1>Header & footer</h1><p className="empty" role="status">Loading your saved appearance…</p></section>;
  return <section className="page siteChromeBuilder">
    <p className="eyebrow">{scope === 'platform' ? 'Platform settings' : 'Store appearance'}</p>
    <h1>Header & footer builder</h1>
    <p className="muted">Choose a responsive template, customize your brand and review it before publishing. Your current public appearance remains active until publication.</p>
    {state?.store && <p className="siteChromeScope">Editing <strong>{state.store.name}</strong> · <a href={`/store/${state.store.slug}`} target="_blank" rel="noreferrer">View storefront</a></p>}
    {scope === 'store' && !eligible && <div className="notice" role="status"><strong>A paid Store Plan is required to publish custom site chrome.</strong> Saved drafts are preserved; your visitors continue to see the standard Marketplace presentation. <a href="/seller/plan">Review Store plans</a>.</div>}
    {message && <p className="notice" role="status" aria-live="polite">{message}</p>}
    <div className="siteChromeEditorTabs" role="tablist" aria-label="Header and footer editor">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>

    {tab === 'templates' && <section className="card cardBody siteChromePanel"><h2>Choose a template</h2><p className="muted">The original Marketplace header remains the default until you publish a selection.</p><h3>Header templates</h3><div className="siteChromeTemplateGrid">{headerTemplates.map(template => <button type="button" className={`siteChromeTemplate${config.header.template === template.id ? ' selected' : ''}`} key={template.id} onClick={() => change({ ...config, header: { ...config.header, template: template.id, ...(template.id === 'COMMERCE' ? { showSearch: true } : {}) } })}><span className="siteChromeTemplatePreview siteChromeTemplatePreview--header">{template.id === 'COMMERCE' ? 'Brand  ·  Search products' : template.id === 'EDITORIAL' ? 'Brand  ·  Discover' : 'Market Lane  ·  Shop'}</span><strong>{template.title}</strong><small>{template.text}</small></button>)}</div><h3>Footer templates</h3><div className="siteChromeTemplateGrid">{footerTemplates.map(template => <button type="button" className={`siteChromeTemplate${config.footer.template === template.id ? ' selected' : ''}`} key={template.id} onClick={() => changeFooter('template', template.id)}><span className={`siteChromeTemplatePreview siteChromeTemplatePreview--footer siteChromeTemplatePreview--${template.id.toLowerCase()}`}>{template.id === 'MINIMAL' ? 'Brand · Legal' : template.id === 'BUSINESS' ? 'Brand  |  Links  |  Contact' : 'Signature brand · Social'}</span><strong>{template.title}</strong><small>{template.text}</small></button>)}</div></section>}

    {tab === 'header' && <section className="card cardBody siteChromePanel"><h2>Header content and design</h2><div className="siteChromeFormGrid">
      <label>Brand title<input value={config.header.title} maxLength={80} onChange={event => changeHeader('title', event.target.value)} placeholder={brand.title} /></label>
      <label>Short tagline<input value={config.header.tagline} maxLength={140} onChange={event => changeHeader('tagline', event.target.value)} /></label>
      <label>Template<select value={config.header.template} onChange={event => changeHeader('template', event.target.value as SiteChromeConfiguration['header']['template'])}>{headerTemplates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>Logo alignment<select value={config.header.alignment} onChange={event => changeHeader('alignment', event.target.value as 'LEFT' | 'CENTER')}><option value="LEFT">Left</option><option value="CENTER">Centered</option></select></label>
      <label>Background color<input type="color" value={config.header.backgroundColor} onChange={event => changeHeader('backgroundColor', event.target.value)} /></label>
      <label>Text color<input type="color" value={config.header.textColor} onChange={event => changeHeader('textColor', event.target.value)} /></label>
      <label>Accent color<input type="color" value={config.header.accentColor} onChange={event => changeHeader('accentColor', event.target.value)} /></label>
      {siteChromeContrastWarnings(config, 'header').map(warning => <p className="siteChromeContrastWarning siteChromeWide" role="status" key={warning}>Contrast check: {warning}</p>)}
      <label>Navigation spacing<select value={config.header.density} onChange={event => changeHeader('density', event.target.value as SiteChromeConfiguration['header']['density'])}><option value="COMPACT">Compact</option><option value="STANDARD">Standard</option><option value="SPACIOUS">Spacious</option></select></label>
      <label>Call-to-action link<select value={config.header.ctaLinkId ?? ''} onChange={event => changeHeader('ctaLinkId', event.target.value || null)}><option value="">No highlighted link</option>{config.header.navigation.filter(link => link.enabled).map(link => <option key={link.id} value={link.id}>{link.label}</option>)}</select></label>
      <label className="siteChromeCheck"><input type="checkbox" checked={config.header.sticky} onChange={event => changeHeader('sticky', event.target.checked)} />Sticky header</label>
      <label className="siteChromeCheck"><input type="checkbox" checked={config.header.showSearch} onChange={event => changeHeader('showSearch', event.target.checked)} />Show working product/store search</label>
      <label className="siteChromeCheck"><input type="checkbox" checked={config.header.showCategoryLinks} onChange={event => changeHeader('showCategoryLinks', event.target.checked)} />Show live marketplace category menu</label>
      <label className="siteChromeCheck"><input type="checkbox" checked={config.header.announcementEnabled} onChange={event => changeHeader('announcementEnabled', event.target.checked)} />Show announcement bar</label>
      {config.header.announcementEnabled && <><label>Announcement text<input value={config.header.announcementText} maxLength={180} onChange={event => changeHeader('announcementText', event.target.value)} /></label><label>Announcement link (optional)<input value={config.header.announcementHref ?? ''} maxLength={1000} onChange={event => changeHeader('announcementHref', event.target.value || null)} placeholder="/shop or https://example.com" /></label></>}
    </div>
    <BrandingImageControl label="Header logo" ratio={3} value={config.header.logoMediaId} publishedValue={state?.published?.header.logoMediaId ?? null} onChange={logoMediaId => changeHeader('logoMediaId', logoMediaId)} listUrl={scope === 'platform' ? '/api/admin/platform/branding-media' : '/api/seller/store-media'} uploadUrl={scope === 'platform' ? '/api/admin/platform/branding-media/uploads' : '/api/seller/store-media/uploads'} previewUrl={id => scope === 'platform' ? `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview` : `/api/seller/store-media/${encodeURIComponent(id)}/preview`} />
    <div className="siteChromeLinkEditor"><div className="sectionHeading"><div><h3>Additional navigation links</h3><p className="muted">Core account, sign-in, cart, and message controls remain protected and available.</p></div><button type="button" onClick={addNavigation} disabled={config.header.navigation.length >= 8}>Add link</button></div>{config.header.navigation.map((link, index) => <div className="siteChromeLinkRow" key={link.id}><label>Label<input value={link.label} maxLength={48} onChange={event => updateNavigation(index, { label: event.target.value })} /></label><label>Safe path or HTTPS URL<input value={link.href} maxLength={1000} onChange={event => updateNavigation(index, { href: event.target.value })} /></label><label className="siteChromeCheck"><input type="checkbox" checked={link.enabled} onChange={event => updateNavigation(index, { enabled: event.target.checked })} />Enabled</label><div className="siteChromeOrderControls"><button type="button" aria-label={`Move ${link.label} up`} onClick={() => moveNavigation(index, -1)} disabled={index === 0}>Move up</button><button type="button" aria-label={`Move ${link.label} down`} onClick={() => moveNavigation(index, 1)} disabled={index === config.header.navigation.length - 1}>Move down</button><button type="button" className="dangerButton" onClick={() => removeNavigation(index)}>Remove</button></div></div>)}</div></section>}

    {tab === 'footer' && <section className="card cardBody siteChromePanel"><h2>Footer content and design</h2><div className="siteChromeFormGrid">
      <label>Short title<input value={config.footer.title} maxLength={80} onChange={event => changeFooter('title', event.target.value)} placeholder={brand.title} /></label>
      <label>Footer template<select value={config.footer.template} onChange={event => changeFooter('template', event.target.value as SiteChromeConfiguration['footer']['template'])}>{footerTemplates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="siteChromeWide">Short description<textarea value={config.footer.description} maxLength={500} onChange={event => changeFooter('description', event.target.value)} rows={3} /></label>
      <label>Logo max width (px)<input type="number" min={24} max={240} value={config.footer.logoWidth} onChange={event => changeFooter('logoWidth', Number(event.target.value))} /></label>
      <label>Logo max height (px)<input type="number" min={16} max={96} value={config.footer.logoHeight} onChange={event => changeFooter('logoHeight', Number(event.target.value))} /></label>
      <label>Background color<input type="color" value={config.footer.backgroundColor} onChange={event => changeFooter('backgroundColor', event.target.value)} /></label>
      <label>Text color<input type="color" value={config.footer.textColor} onChange={event => changeFooter('textColor', event.target.value)} /></label>
      <label>Accent color<input type="color" value={config.footer.accentColor} onChange={event => changeFooter('accentColor', event.target.value)} /></label>
      {siteChromeContrastWarnings(config, 'footer').map(warning => <p className="siteChromeContrastWarning siteChromeWide" role="status" key={warning}>{warning}</p>)}
      <label>Alignment<select value={config.footer.alignment} onChange={event => changeFooter('alignment', event.target.value as 'LEFT' | 'CENTER')}><option value="LEFT">Left aligned</option><option value="CENTER">Centered</option></select></label>
      <label>Contact email<input type="email" value={config.footer.contactEmail ?? ''} maxLength={320} onChange={event => changeFooter('contactEmail', event.target.value || null)} /></label>
      <label>Contact phone<input type="tel" value={config.footer.contactPhone ?? ''} maxLength={40} onChange={event => changeFooter('contactPhone', event.target.value || null)} /></label>
      <label className="siteChromeWide">Copyright line<input value={config.footer.copyright} maxLength={180} onChange={event => changeFooter('copyright', event.target.value)} placeholder={`© ${new Date().getFullYear()} ${brand.title}`} /></label>
      <label className="siteChromeCheck"><input type="checkbox" checked={config.footer.backToTop} onChange={event => changeFooter('backToTop', event.target.checked)} />Show back-to-top button</label>
    </div>
    <BrandingImageControl label="Footer logo" ratio={2} value={config.footer.logoMediaId} publishedValue={state?.published?.footer.logoMediaId ?? null} onChange={logoMediaId => changeFooter('logoMediaId', logoMediaId)} listUrl={scope === 'platform' ? '/api/admin/platform/branding-media' : '/api/seller/store-media'} uploadUrl={scope === 'platform' ? '/api/admin/platform/branding-media/uploads' : '/api/seller/store-media/uploads'} previewUrl={id => scope === 'platform' ? `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview` : `/api/seller/store-media/${encodeURIComponent(id)}/preview`} />
    <div className="siteChromeLinkEditor"><div className="sectionHeading"><div><h3>Footer link groups</h3><p className="muted">Up to four groups, with links to safe internal paths or HTTPS destinations. Reorder them to control the published layout.</p></div><button type="button" onClick={addSection} disabled={config.footer.sections.length >= 4}>Add link group</button></div>{config.footer.sections.map((section, index) => <fieldset className="siteChromeSectionEditor" key={section.id}><legend>Link group {index + 1}</legend><div className="sectionHeading"><label>Section title<input value={section.title} maxLength={60} onChange={event => updateSection(index, { title: event.target.value })} /></label><div className="siteChromeOrderControls"><button type="button" aria-label={`Move link group ${index + 1} up`} onClick={() => changeFooter('sections', moveItem(config.footer.sections, index, -1))} disabled={index === 0}>Move up</button><button type="button" aria-label={`Move link group ${index + 1} down`} onClick={() => changeFooter('sections', moveItem(config.footer.sections, index, 1))} disabled={index === config.footer.sections.length - 1}>Move down</button><button type="button" className="dangerButton" onClick={() => changeFooter('sections', config.footer.sections.filter((_, itemIndex) => index !== itemIndex))}>Remove group</button></div></div>{section.links.map((link, linkIndex) => <div className="siteChromeLinkRow" key={link.id}><label>Label<input value={link.label} maxLength={48} onChange={event => updateSection(index, { links: section.links.map((item, position) => position === linkIndex ? { ...item, label: event.target.value } : item) })} /></label><label>URL<input value={link.href} maxLength={1000} onChange={event => updateSection(index, { links: section.links.map((item, position) => position === linkIndex ? { ...item, href: event.target.value } : item) })} /></label><button type="button" className="dangerButton" onClick={() => updateSection(index, { links: section.links.filter((_, position) => position !== linkIndex) })}>Remove link</button></div>)}<button type="button" onClick={() => updateSection(index, { links: [...section.links, { id: newId(), label: 'New link', href: '/', enabled: true }] })} disabled={section.links.length >= 10}>Add link</button></fieldset>)}</div></section>}

    {tab === 'social' && <section className="card cardBody siteChromePanel"><div className="sectionHeading"><div><h2>Social media accounts</h2><p className="muted">Add up to six safe HTTPS profiles. Platform icons are curated local SVGs; uploaded SVG and HTML are never rendered.</p></div><button type="button" onClick={addSocial} disabled={config.footer.socials.length >= 6}>Add social account</button></div><p className="siteChromeCounter" aria-live="polite">{config.footer.socials.length} / 6 accounts{config.footer.socials.length >= 6 ? ' - Maximum reached' : ''}</p>{config.footer.socials.map((social, index) => <fieldset className="siteChromeSocialRow" key={social.id}><legend>Account {index + 1}</legend><div className="siteChromeFormGrid"><label>Platform<select value={social.platform} onChange={event => changeFooter('socials', config.footer.socials.map((item, position) => position === index ? { ...item, platform: event.target.value as SiteChromeSocial['platform'] } : item))}>{socialPlatforms.map(platform => <option key={platform} value={platform}>{platform.replaceAll('_', ' ')}</option>)}</select></label><label>Profile URL<input type="url" value={social.url} maxLength={1000} onChange={event => changeFooter('socials', config.footer.socials.map((item, position) => position === index ? { ...item, url: event.target.value } : item))} /></label><label>Visible label<input value={social.label} maxLength={48} onChange={event => changeFooter('socials', config.footer.socials.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} /></label><label>Display<select value={social.display} onChange={event => changeFooter('socials', config.footer.socials.map((item, position) => position === index ? { ...item, display: event.target.value as SiteChromeSocial['display'] } : item))}><option value="ICON_AND_LABEL">Icon and label</option><option value="ICON_ONLY">Icon only</option></select></label><label className="siteChromeCheck"><input type="checkbox" checked={social.enabled} onChange={event => changeFooter('socials', config.footer.socials.map((item, position) => position === index ? { ...item, enabled: event.target.checked } : item))} />Enabled</label><div className="siteChromeOrderControls"><button type="button" aria-label={`Move ${social.label || 'social account'} up`} onClick={() => changeFooter('socials', moveItem(config.footer.socials, index, -1))} disabled={index === 0}>Move up</button><button type="button" aria-label={`Move ${social.label || 'social account'} down`} onClick={() => changeFooter('socials', moveItem(config.footer.socials, index, 1))} disabled={index === config.footer.socials.length - 1}>Move down</button><button type="button" className="dangerButton" onClick={() => changeFooter('socials', config.footer.socials.filter((_, position) => position !== index))}>Remove account</button></div></div></fieldset>)}</section>}

    {tab === 'visibility' && <section className="card cardBody siteChromePanel"><h2>Footer visibility by page</h2><p className="muted">Suppression applies to the optional presentation footer only. Legal and transaction notices remain visible. CMS pages and posts are stored by content ID, so slug changes do not break the rule.</p>{state?.pages.map(page => <label className="siteChromeVisibilityRow" key={page.key}><span><strong>{page.label}</strong><small>{config.suppressedPageKeys.includes(page.key) ? 'Footer hidden on this page' : 'Footer shown on this page'}</small></span><input type="checkbox" checked={config.suppressedPageKeys.includes(page.key)} onChange={event => change({ ...config, suppressedPageKeys: event.target.checked ? [...config.suppressedPageKeys, page.key] : config.suppressedPageKeys.filter(key => key !== page.key) })} aria-label={`Suppress footer on ${page.label}`} /></label>)}{!state?.pages.length && <p className="empty">No pages are available to configure.</p>}<button type="button" onClick={() => change({ ...config, suppressedPageKeys: [] })} disabled={!config.suppressedPageKeys.length}>Show footer on all pages</button><button type="button" className="dangerButton" onClick={resetDraft} disabled={busy || !dirty}>Reset all unsaved appearance settings to defaults</button></section>}

    {tab === 'preview' && <section className="card cardBody siteChromePanel"><div className="sectionHeading"><div><h2>Live preview</h2><p className="muted">Preview updates as you edit; it does not publish your changes.</p></div><label>Preview width<select value={viewport} onChange={event => setViewport(event.target.value as typeof viewport)}><option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="mobile">Mobile</option></select></label></div><div className={`siteChromePreview siteChromePreview--${viewport}`}><SiteChromeHeader configuration={config} brand={brand} user={user ?? null} cartCount={2} onSignOut={() => undefined} /><div className="siteChromePreviewBody"><p className="eyebrow">Preview content</p><h2>{brand.title}</h2><p>Your header and footer preview appears around this sample page.</p></div><SiteChromeFooter configuration={config} brand={brand} /></div></section>}

    {tab === 'history' && <section className="card cardBody siteChromePanel"><div className="sectionHeading"><div><h2>Version history</h2><p className="muted">Published version: {state?.publishedVersion ?? 'Using default'} · Draft version: {state?.draftVersion ?? 0}</p></div><button type="button" onClick={() => void load()} disabled={busy}>Refresh history</button></div>{state?.revisions.length ? <div className="siteChromeRevisionList">{state.revisions.map(revision => <article className="siteChromeRevision" key={revision.version}><div><strong>Version {revision.version}</strong><span>{new Date(revision.createdAt).toLocaleString()}</span><small>{revision.changeNote || 'Saved site chrome update'} · {revision.editor.name || revision.editor.email}</small></div>{revision.version !== state.draftVersion && <button type="button" disabled={busy || !eligible} onClick={() => void restore(revision.version)}>Restore as draft</button>}</article>)}</div> : <p className="empty">No saved revisions yet. Save a draft to begin version history.</p>}</section>}

    <div className="siteChromeSaveBar"><span>{dirty ? 'Unsaved changes' : `Draft version ${version}${state?.publishedVersion ? ` · Published version ${state.publishedVersion}` : ''}`}</span><button type="button" onClick={() => void load()} disabled={busy}>Discard / reload</button><button type="button" onClick={() => void saveDraft()} disabled={busy || !dirty || !eligible}>{busy ? 'Saving…' : 'Save draft'}</button><button className="primary" type="button" onClick={() => void publish()} disabled={busy || !eligible}>{busy ? 'Working…' : 'Publish changes'}</button></div>
    {scope === 'platform' && <p className="muted siteChromeLegalNote">The built-in Marketplace header, cart, message activity, notifications, account controls and required platform disclosures are not removable.</p>}
  </section>;
}
