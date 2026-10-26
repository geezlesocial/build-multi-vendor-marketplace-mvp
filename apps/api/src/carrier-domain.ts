const TRACKING_TOKEN = '{trackingNumber}';

export function isSafeTrackingUrlTemplate(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate.length > 500) return false;
  const withoutToken = candidate.replaceAll(TRACKING_TOKEN, 'ML_TRACKING_NUMBER');
  if (/[{}]/.test(withoutToken)) return false;
  try {
    const url = new URL(withoutToken);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function carrierTrackingUrl(template: string | null | undefined, trackingNumber: string | null | undefined) {
  if (!template || !isSafeTrackingUrlTemplate(template)) return null;
  const url = template.replaceAll(TRACKING_TOKEN, encodeURIComponent(trackingNumber?.trim() ?? ''));
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}
