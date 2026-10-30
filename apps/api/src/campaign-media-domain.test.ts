import { describe, expect, it } from 'vitest';
import { MediaKind, MediaScanStatus, MediaUploadStatus } from '@prisma/client';
import { campaignMediaFailure, safeCampaignDestination } from './campaign-media-domain.js';

const image = { kind: MediaKind.IMAGE, scanStatus: MediaScanStatus.APPROVED, uploadStatus: MediaUploadStatus.COMPLETE, destinationUrl: null, buttonLabel: null } as const;
const video = { ...image, kind: MediaKind.VIDEO, destinationUrl: 'https://example.com/watch', buttonLabel: 'Watch now' } as const;

describe('promotion media rules', () => {
  it('accepts safe internal and external destinations', () => {
    expect(safeCampaignDestination('/shop?from=promotion')).toBe('/shop?from=promotion');
    expect(safeCampaignDestination('https://example.com/campaign')).toBe('https://example.com/campaign');
  });

  it.each(['javascript:alert(1)', '//evil.example', '/\\evil.example', 'https://user:pass@example.com'])('rejects unsafe destination %s', value => {
    expect(() => safeCampaignDestination(value)).toThrow();
  });

  it('allows up to six scanned images and one scanned video', () => {
    expect(campaignMediaFailure([...Array.from({ length: 6 }, () => image), video])).toBeNull();
    expect(campaignMediaFailure(Array.from({ length: 7 }, () => image))).toMatch(/six images/i);
    expect(campaignMediaFailure([video, video])).toMatch(/one video/i);
  });

  it('blocks publishing until scanning succeeds and a video CTA is complete', () => {
    expect(campaignMediaFailure([{ ...image, scanStatus: MediaScanStatus.QUARANTINED }])).toMatch(/safety scan/i);
    expect(campaignMediaFailure([{ ...video, buttonLabel: null }])).toMatch(/button label/i);
  });
});
