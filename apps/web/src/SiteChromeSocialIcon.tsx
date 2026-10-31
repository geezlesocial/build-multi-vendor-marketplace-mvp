import type { ReactNode } from 'react';
import type { SiteChromeSocial } from './site-chrome-types.js';

const paths: Record<SiteChromeSocial['platform'], ReactNode> = {
  FACEBOOK: <path d="M13.4 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.5 1.5-1.5h1.7V4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 4V10H8v3h2.5v8z" />,
  INSTAGRAM: <><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="6.5" r="1.2" /></>,
  LINKEDIN: <><path d="M4 8h3v12H4zM5.5 3.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6ZM10 8h3v1.7c.8-1.2 1.9-2 3.6-2 3 0 3.9 1.9 3.9 4.9V20h-3v-6.5c0-1.6-.3-3-2.1-3s-2.4 1.4-2.4 3V20h-3z" /></>,
  X: <path d="M18.6 3h2.8l-6.2 7.1 7.3 10.9h-5.7l-4.5-6.6-5.7 6.6H3.8l6.7-7.8L3.5 3h5.8l4.1 6.1zm-1 16h1.5L8.3 4.9H6.7z" />,
  YOUTUBE: <><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2a31 31 0 0 0-.5 4.8 31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8Z" /><path fill="var(--chrome-footer-bg,#fff)" d="m10 15.5 5.2-3.5L10 8.5z" /></>,
  TIKTOK: <path d="M19.6 7.1a5.2 5.2 0 0 1-3.2-1.1 5.2 5.2 0 0 1-1.8-3.1h-3.3v13.7a2.9 2.9 0 1 1-2-2.8V10.4a6.4 6.4 0 1 0 5.3 6.3V9.8a8.4 8.4 0 0 0 5 1.7V8.2a5 5 0 0 1-0-.1Z" />,
  WHATSAPP: <><path d="M20.5 3.5A11.9 11.9 0 0 0 1.8 17.8L.5 23.5l5.8-1.5a12 12 0 0 0 14.2-18.5ZM12 21a9 9 0 0 1-4.6-1.3l-.3-.2-3.4.9.9-3.3-.2-.3A9 9 0 1 1 12 21Z" /><path d="M17 14.4c-.3-.2-1.7-.9-2-.9s-.5-.2-.7.2-.8.9-.9 1.1-.3.2-.6.1a7.3 7.3 0 0 1-2.2-1.4 8 8 0 0 1-1.5-1.9c-.2-.3 0-.5.2-.6l.4-.5.2-.4c.1-.2 0-.4 0-.6s-.7-1.8-.9-2.4c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4s-1.2 1.2-1.2 2.8 1.2 3.2 1.4 3.4a11 11 0 0 0 4.2 3.7c.6.3 1.1.5 1.5.6.6.2 1.2.2 1.7.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.3.2-1.4s-.2-.3-.5-.4Z" /></>,
  PINTEREST: <path d="M12 2a10 10 0 0 0-3.7 19.3c0-.8 0-1.8.2-2.7l1.4-5.8s-.4-.7-.4-1.7c0-1.6.9-2.8 2.1-2.8 1 0 1.5.8 1.5 1.7 0 1-.6 2.5-1 3.9-.3 1.2.6 2.1 1.8 2.1 2.2 0 3.8-2.8 3.8-6.1 0-2.5-1.7-4.4-4.8-4.4-3.5 0-5.7 2.6-5.7 5.4 0 1 .3 2 .9 2.6.2.3.3.4.2.7l-.2.9c-.1.3-.3.4-.6.3-1.7-.7-2.4-2.5-2.4-4.5 0-3.4 2.9-7.4 8.6-7.4 4.6 0 7.6 3.3 7.6 6.9 0 4.8-2.7 8.4-6.7 8.4-1.3 0-2.5-.7-2.9-1.5l-.9 3.5c-.3 1-.8 2-1.3 2.8A10 10 0 1 0 12 2Z" />,
  WEBSITE: <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" fill="none" stroke="currentColor" strokeWidth="1.7" /></>,
  OTHER: <><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14z" /><path d="M19 13v6H5V5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6z" /></>
};

export function SiteChromeSocialIcon({ platform }: { platform: SiteChromeSocial['platform'] }) {
  return <svg className="siteChromeSocialIcon" data-platform={platform} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[platform]}</svg>;
}
