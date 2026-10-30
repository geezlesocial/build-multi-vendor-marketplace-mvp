export const HEADER_ACTIVITY_STORAGE_KEY = 'marketplace:header-activity';

export function announceHeaderActivityChange() {
  window.dispatchEvent(new Event('marketplace:header-activity-changed'));
  try { localStorage.setItem(HEADER_ACTIVITY_STORAGE_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
  catch { /* Cross-tab updates are best-effort when browser storage is unavailable. */ }
}
