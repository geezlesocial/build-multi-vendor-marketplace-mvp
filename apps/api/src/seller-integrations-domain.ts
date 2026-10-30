import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export function normalizeDnsHostname(input: string) {
  const host = domainToASCII(input.trim().replace(/\.$/, '')).toLowerCase();
  if (!host || host.length > 253 || isIP(host) || !host.includes('.')) throw new Error('Enter a public DNS hostname, not an IP address.');
  const labels = host.split('.');
  if (labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error('The hostname is not valid DNS syntax.');
  if (/\.(?:localhost|local|internal|lan|test|example|invalid)$/.test(host)) throw new Error('Local and reserved test hostnames cannot be used.');
  return host;
}

export function normalizeCustomDomain(input: string, reservedHosts: string[] = []) {
  const host = normalizeDnsHostname(input);
  if (host.split('.').length < 2 || /^\d+$/.test(host.split('.').at(-1) ?? '')) throw new Error('Enter a fully qualified domain name.');
  if (reservedHosts.some(value => {
    if (!value) return false;
    try { const reserved = normalizeDnsHostname(value); return host === reserved || host.endsWith(`.${reserved}`); }
    catch { return false; }
  })) throw new Error('That hostname belongs to the marketplace and cannot be assigned to a seller Store.');
  return host;
}

export function isPublicSmtpAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [a, b, c] = octets as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0)
      || a >= 224);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:') || normalized === '::' || normalized === '::1') return false;
    const pieces = normalized.split(':');
    const first = Number.parseInt(pieces[0] || '0', 16);
    const second = Number.parseInt(pieces[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff
      && !(first === 0x2001 && [0x0000, 0x0002, 0x0010, 0x0db8].includes(second))
      && first !== 0x2002;
  }
  return false;
}

export function tokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function customDomainDnsReady(check: { ownershipTokenMatches: boolean; cnameMatches: boolean }) {
  return check.ownershipTokenMatches && check.cnameMatches;
}

/** The official platform Store bypasses seller plan billing; seller Stores still need both plan and feature entitlement. */
export function storeIntegrationEligible(input: { isOfficialAdminStore: boolean; paidPlan: boolean; entitlementEnabled: boolean }) {
  return input.isOfficialAdminStore || (input.paidPlan && input.entitlementEnabled);
}
