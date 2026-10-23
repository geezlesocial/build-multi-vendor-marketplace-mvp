import crypto from 'node:crypto';
import net from 'node:net';
import { MediaPurpose, MediaScanStatus, MediaUploadStatus } from '@prisma/client';
import { env } from './config.js';
import { prisma } from './security.js';

export type MalwareVerdict = 'CLEAN' | 'INFECTED';
export interface MalwareScanner {
  readonly provider: string;
  scan(bytes: Buffer): Promise<MalwareVerdict>;
}

export class MediaScannerError extends Error {
  constructor(readonly safeCode: 'SCANNER_UNAVAILABLE' | 'SCANNER_TIMEOUT' | 'SCANNER_ERROR', message: string) {
    super(message);
    this.name = 'MediaScannerError';
  }
}

/** ClamAV's clamd INSTREAM protocol. Keep this socket on a trusted private network:
 * clamd's TCP protocol is not encrypted or authenticated. */
export class ClamAvScanner implements MalwareScanner {
  readonly provider = 'clamav';

  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs: number) {}

  scan(bytes: Buffer): Promise<MalwareVerdict> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, verdict?: MalwareVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(verdict!);
      };
      socket.setTimeout(this.timeoutMs, () => finish(new MediaScannerError('SCANNER_TIMEOUT', 'The malware scanner timed out.')));
      socket.once('error', () => finish(new MediaScannerError('SCANNER_UNAVAILABLE', 'The malware scanner could not be reached.')));
      socket.once('end', () => finish(new MediaScannerError('SCANNER_ERROR', 'The malware scanner closed before returning a complete result.')));
      socket.on('data', chunk => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 4096) return finish(new MediaScannerError('SCANNER_ERROR', 'The malware scanner returned an invalid response.'));
        const terminator = response.indexOf(0);
        if (terminator < 0) return;
        const reply = response.subarray(0, terminator).toString('utf8');
        if (/:\s+OK$/.test(reply)) return finish(undefined, 'CLEAN');
        if (/\sFOUND$/.test(reply)) return finish(undefined, 'INFECTED');
        finish(new MediaScannerError('SCANNER_ERROR', 'The malware scanner returned an unusable result.'));
      });
      socket.once('connect', () => {
        socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const part = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(part.length);
          socket.write(length);
          socket.write(part);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

export const malwareScanner: MalwareScanner | null = env.CONTENT_SCANNER_AVAILABLE && env.CONTENT_SCANNER_HOST
  ? new ClamAvScanner(env.CONTENT_SCANNER_HOST, env.CONTENT_SCANNER_PORT, env.CONTENT_SCANNER_TIMEOUT_MS)
  : null;

export type MediaScanSnapshot = {
  id: string;
  scanStatus: MediaScanStatus;
  scanErrorCode: string | null;
  scanAttemptCount: number;
  scanCompletedAt: Date | null;
};

type ScanDb = typeof prisma;
const staleScanAfterMs = Math.max(60_000, env.CONTENT_SCANNER_TIMEOUT_MS * 2);

/** A compare-and-set scan attempt makes late and duplicate scanner responses harmless.
 * Scanner errors only update safe status metadata; they never approve the media. */
export async function scanQuarantinedMedia(input: {
  assetId: string;
  bytes: Buffer;
  scanner: MalwareScanner | null;
  actorId?: string;
  db?: ScanDb;
}): Promise<MediaScanSnapshot> {
  const db = input.db ?? prisma;
  const current = await db.mediaAsset.findUnique({ where: { id: input.assetId }, select: { id: true, uploaderId: true, purpose: true, uploadStatus: true, scanStatus: true, scanAttemptId: true, scanStartedAt: true, scanAttemptCount: true, scanErrorCode: true, scanCompletedAt: true } });
  if (!current) throw new Error('Media asset not found');
  if (current.uploadStatus !== MediaUploadStatus.COMPLETE || current.scanStatus !== MediaScanStatus.QUARANTINED) return snapshot(current);
  if (!input.scanner) {
    await db.mediaAsset.updateMany({ where: { id: current.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED }, data: { scanErrorCode: 'SCANNER_UNAVAILABLE', scanStartedAt: null } });
    return snapshot(await db.mediaAsset.findUniqueOrThrow({ where: { id: current.id }, select: snapshotSelect }));
  }

  const attemptId = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - staleScanAfterMs);
  const claimed = await db.mediaAsset.updateMany({
    where: {
      id: current.id,
      uploadStatus: MediaUploadStatus.COMPLETE,
      scanStatus: MediaScanStatus.QUARANTINED,
      OR: [{ scanStartedAt: null }, { scanStartedAt: { lt: staleBefore } }]
    },
    data: { scanAttemptId: attemptId, scanAttemptCount: { increment: 1 }, scanStartedAt: new Date(), scanErrorCode: null, scannerProvider: input.scanner.provider }
  });
  if (claimed.count !== 1) return snapshot(await db.mediaAsset.findUniqueOrThrow({ where: { id: current.id }, select: snapshotSelect }));

  try {
    const verdict = await input.scanner.scan(input.bytes);
    const status = verdict === 'CLEAN' ? MediaScanStatus.APPROVED : MediaScanStatus.REJECTED;
    return await db.$transaction(async tx => {
      const applied = await tx.mediaAsset.updateMany({
        where: { id: current.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, scanAttemptId: attemptId },
        data: { scanStatus: status, scanCompletedAt: new Date(), scanStartedAt: null, scanErrorCode: verdict === 'INFECTED' ? 'MALWARE_DETECTED' : null }
      });
      if (applied.count === 1) {
        if (status === MediaScanStatus.APPROVED && current.purpose === MediaPurpose.AVATAR) {
          await tx.user.updateMany({ where: { id: current.uploaderId }, data: { avatarMediaId: current.id } });
        }
        await tx.auditLog.create({ data: { actorId: input.actorId ?? current.uploaderId, action: status === MediaScanStatus.APPROVED ? 'MEDIA_SCAN_APPROVED' : 'MEDIA_SCAN_REJECTED', entity: 'MediaAsset', entityId: current.id, metadata: { scanAttemptId: attemptId, scanner: input.scanner!.provider, result: verdict === 'CLEAN' ? 'CLEAN' : 'INFECTED' } } });
      }
      return snapshot(await tx.mediaAsset.findUniqueOrThrow({ where: { id: current.id }, select: snapshotSelect }));
    });
  } catch (error) {
    const safeCode = error instanceof MediaScannerError ? error.safeCode : 'SCANNER_ERROR';
    await db.mediaAsset.updateMany({ where: { id: current.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, scanAttemptId: attemptId }, data: { scanStartedAt: null, scanErrorCode: safeCode } });
    return snapshot(await db.mediaAsset.findUniqueOrThrow({ where: { id: current.id }, select: snapshotSelect }));
  }
}

const snapshotSelect = { id: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true } as const;
function snapshot(value: { id: string; scanStatus: MediaScanStatus; scanErrorCode: string | null; scanAttemptCount: number; scanCompletedAt: Date | null }): MediaScanSnapshot {
  return { id: value.id, scanStatus: value.scanStatus, scanErrorCode: value.scanErrorCode, scanAttemptCount: value.scanAttemptCount, scanCompletedAt: value.scanCompletedAt };
}
