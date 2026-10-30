import { MediaKind, MediaScanStatus, MediaUploadStatus } from '@prisma/client';

export type CampaignMediaSnapshot = {
  kind: MediaKind;
  scanStatus: MediaScanStatus;
  uploadStatus: MediaUploadStatus;
  destinationUrl: string | null;
  buttonLabel: string | null;
};

export function safeCampaignDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\') && !trimmed.includes('..') && !/[\u0000-\u001f\u007f]/.test(trimmed)) return trimmed;
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use a safe internal path or an HTTP(S) URL without embedded credentials.');
  return parsed.toString();
}

export function campaignMediaFailure(media: CampaignMediaSnapshot[]): string | null {
  const images = media.filter(item => item.kind === MediaKind.IMAGE);
  const videos = media.filter(item => item.kind === MediaKind.VIDEO);
  if (images.length > 6) return 'A promotion can include up to six images.';
  if (videos.length > 1) return 'A promotion can include one video maximum.';
  if (media.some(item => item.uploadStatus !== MediaUploadStatus.COMPLETE || item.scanStatus !== MediaScanStatus.APPROVED)) return 'All promotion media must finish upload and pass the safety scan before publishing.';
  if (videos.some(item => !item.buttonLabel?.trim() || !item.destinationUrl?.trim())) return 'Add a button label and destination URL for the promotion video.';
  return null;
}
