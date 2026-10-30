import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EgressStatus } from 'livekit-server-sdk';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { env } from './config.js';
import { prisma } from './security.js';
import { liveProvider } from './live-provider.js';

const replayClient = env.LIVE_RECORDING_STORAGE_AVAILABLE
  ? new S3Client({
    region: env.LIVE_RECORDING_STORAGE_REGION!,
    credentials: { accessKeyId: env.LIVE_RECORDING_STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.LIVE_RECORDING_STORAGE_SECRET_ACCESS_KEY! },
    ...(env.LIVE_RECORDING_STORAGE_ENDPOINT ? { endpoint: env.LIVE_RECORDING_STORAGE_ENDPOINT, forcePathStyle: env.LIVE_RECORDING_STORAGE_FORCE_PATH_STYLE } : {})
  })
  : null;

export function liveReplayStorageReady() { return Boolean(replayClient && env.LIVE_RECORDING_STORAGE_BUCKET); }

export async function replayObjectExists(key: string) {
  if (!replayClient) return false;
  try {
    const result = await replayClient.send(new HeadObjectCommand({ Bucket: env.LIVE_RECORDING_STORAGE_BUCKET!, Key: key }));
    return Boolean(result.ContentLength && result.ContentLength > 0);
  } catch { return false; }
}

export async function removeReplayObject(key: string) {
  if (!replayClient) throw new Error('Live replay storage is not configured.');
  await replayClient.send(new DeleteObjectCommand({ Bucket: env.LIVE_RECORDING_STORAGE_BUCKET!, Key: key }));
}

export async function streamReplayObject(req: Request, res: Response, key: string) {
  if (!replayClient) return res.status(503).json({ error: 'Live replay storage is not configured.' });
  const range = req.get('range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) return res.status(416).set('Accept-Ranges', 'bytes').end();
  try {
    const result = await replayClient.send(new GetObjectCommand({ Bucket: env.LIVE_RECORDING_STORAGE_BUCKET!, Key: key, ...(range ? { Range: range } : {}) }));
    if (!result.Body) return res.status(404).end();
    res.status(result.ContentRange ? 206 : 200);
    res.set({
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(result.ContentLength !== undefined ? { 'Content-Length': String(result.ContentLength) } : {}),
      ...(result.ContentRange ? { 'Content-Range': result.ContentRange } : {}),
      'Content-Disposition': 'inline; filename="live-replay.mp4"'
    });
    const body = result.Body as Readable;
    body.on('error', () => { if (!res.headersSent) res.status(502); res.destroy(); });
    res.once('close', () => { if (!res.writableEnded) body.destroy?.(); });
    body.pipe(res);
  } catch (error) {
    const status = Number((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode);
    if (status === 416) return res.status(416).set('Accept-Ranges', 'bytes').end();
    return res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? 'Replay file not found.' : 'Replay could not be loaded.' });
  }
}

let reconciliationRunning = false;
export async function reconcileLiveRecordings() {
  if (reconciliationRunning || !replayClient) return;
  reconciliationRunning = true;
  try {
    const sessions = await prisma.liveSession.findMany({
      where: { recordingStatus: { in: ['STARTING', 'RECORDING', 'PROCESSING'] }, recordingEgressId: { not: null } },
      select: { id: true, status: true, providerSessionRef: true, recordingEgressId: true, recordingStorageKey: true, recordingStartedAt: true },
      take: 50
    });
    for (const session of sessions) {
      if (!session.recordingEgressId || !session.recordingStorageKey) continue;
      try {
        const providerStatus = await liveProvider.getRecordingStatus(session.recordingEgressId);
        if (providerStatus === EgressStatus.EGRESS_COMPLETE || providerStatus === null) {
          if (await replayObjectExists(session.recordingStorageKey)) {
            await prisma.liveSession.updateMany({ where: { id: session.id, recordingEgressId: session.recordingEgressId, recordingStatus: { in: ['STARTING', 'RECORDING', 'PROCESSING'] } }, data: { recordingStatus: 'READY', recordingCompletedAt: new Date(), recordingErrorCode: null } });
            if (session.status === 'ENDED' && session.providerSessionRef) await liveProvider.endSession(session.providerSessionRef);
          } else if (session.recordingStartedAt && Date.now() - session.recordingStartedAt.getTime() > 2 * 60 * 60 * 1000) {
            await prisma.liveSession.updateMany({ where: { id: session.id, recordingEgressId: session.recordingEgressId }, data: { recordingStatus: 'FAILED', recordingErrorCode: 'EGRESS_FILE_MISSING', recordingCompletedAt: new Date() } });
            if (session.status === 'ENDED' && session.providerSessionRef) await liveProvider.endSession(session.providerSessionRef);
          }
        } else if ([EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED].includes(providerStatus as EgressStatus)) {
          await prisma.liveSession.updateMany({ where: { id: session.id, recordingEgressId: session.recordingEgressId }, data: { recordingStatus: 'FAILED', recordingErrorCode: 'EGRESS_FAILED', recordingCompletedAt: new Date() } });
          if (session.status === 'ENDED' && session.providerSessionRef) await liveProvider.endSession(session.providerSessionRef);
        } else if (providerStatus === EgressStatus.EGRESS_ACTIVE && session.status !== 'ENDED') {
          await prisma.liveSession.updateMany({ where: { id: session.id, recordingEgressId: session.recordingEgressId, recordingStatus: 'STARTING' }, data: { recordingStatus: 'RECORDING' } });
        } else if (providerStatus === EgressStatus.EGRESS_ENDING) {
          await prisma.liveSession.updateMany({ where: { id: session.id, recordingEgressId: session.recordingEgressId, recordingStatus: { in: ['STARTING', 'RECORDING'] } }, data: { recordingStatus: 'PROCESSING' } });
        }
      } catch { /* Reconciliation retries on the next worker pass; never expose an unverified object. */ }
    }
  } finally { reconciliationRunning = false; }
}
