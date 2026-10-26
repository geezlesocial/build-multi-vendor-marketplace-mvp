import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';
import { env } from './config.js';

export type LiveProviderReadiness = { provider: string | null; configured: boolean; healthy: boolean; attendanceVerificationAvailable: boolean; reason: string };
export type LiveProviderSession = { providerSessionRef: string; playbackRef?: string; providerStatus?: string };
export type LiveProviderToken = { serverUrl: string; token: string };

export interface LiveProviderAdapter {
  getReadiness(): Promise<LiveProviderReadiness>;
  createSession(input: { title: string; scheduledAt?: Date }): Promise<LiveProviderSession>;
  endSession(providerSessionRef: string): Promise<void>;
  issueViewerToken(roomName: string, identity: string, name?: string): Promise<LiveProviderToken>;
  issueHostToken(roomName: string, identity: string, name?: string): Promise<LiveProviderToken>;
  verifyHostPublishing(roomName: string, identity: string): Promise<boolean>;
  verifyViewerPlayback(roomName: string, identity: string): Promise<boolean>;
  getViewerCount(roomName: string): Promise<number>;
  clientServerUrl(): string | null;
}

function serverUrl(value: string) { return value.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, ''); }
function browserUrl(value: string) { return value.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/$/, ''); }

export class UnavailableLiveProvider implements LiveProviderAdapter {
  async getReadiness(): Promise<LiveProviderReadiness> { return { provider: null, configured: false, healthy: false, attendanceVerificationAvailable: false, reason: 'No managed streaming provider is selected. Configure LiveKit server credentials before enabling live shopping.' }; }
  async createSession(_input?: { title: string; scheduledAt?: Date }): Promise<LiveProviderSession> { throw new Error('Live provider is unavailable; configure a real managed streaming provider before starting a broadcast.'); }
  async endSession(): Promise<void> {}
  async issueViewerToken(): Promise<LiveProviderToken> { throw new Error('Live provider is unavailable.'); }
  async issueHostToken(): Promise<LiveProviderToken> { throw new Error('Live provider is unavailable.'); }
  async verifyHostPublishing(): Promise<boolean> { return false; }
  async verifyViewerPlayback(): Promise<boolean> { return false; }
  async getViewerCount(): Promise<number> { return 0; }
  clientServerUrl(): string | null { return null; }
}

export class LiveKitProvider implements LiveProviderAdapter {
  private readonly rooms: RoomServiceClient;
  private readonly httpUrl: string;
  private readonly wsUrl: string;

  constructor(private readonly url: string, private readonly apiKey: string, private readonly apiSecret: string) {
    this.httpUrl = serverUrl(url);
    this.wsUrl = browserUrl(url);
    this.rooms = new RoomServiceClient(this.httpUrl, apiKey, apiSecret);
  }

  async getReadiness(): Promise<LiveProviderReadiness> {
    try { await this.rooms.listRooms(); return { provider: 'LIVEKIT', configured: true, healthy: true, attendanceVerificationAvailable: true, reason: 'LiveKit is configured and reachable.' }; }
    catch (error) { return { provider: 'LIVEKIT', configured: true, healthy: false, attendanceVerificationAvailable: false, reason: `LiveKit health check failed: ${error instanceof Error ? error.message : 'provider request failed'}` }; }
  }

  async createSession(input: { title: string; scheduledAt?: Date }): Promise<LiveProviderSession> {
    const roomName = `marketplace-live-${randomUUID()}`;
    await this.rooms.createRoom({ name: roomName, emptyTimeout: 15 * 60, departureTimeout: 60, maxParticipants: 5000, metadata: JSON.stringify({ title: input.title, scheduledAt: input.scheduledAt?.toISOString() ?? null }) });
    return { providerSessionRef: roomName, playbackRef: roomName, providerStatus: 'ROOM_CREATED' };
  }

  async endSession(providerSessionRef: string) { await this.rooms.deleteRoom(providerSessionRef).catch(() => undefined); }

  async issueViewerToken(roomName: string, identity: string, name?: string) {
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity, name, ttl: '2h' });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true, canPublishData: false });
    return { serverUrl: this.wsUrl, token: await token.toJwt() };
  }

  async issueHostToken(roomName: string, identity: string, name?: string) {
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity, name, ttl: '2h' });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return { serverUrl: this.wsUrl, token: await token.toJwt() };
  }

  async verifyHostPublishing(roomName: string, identity: string) { const participant = await this.rooms.getParticipant(roomName, identity).catch(() => null); return Boolean(participant?.tracks.some(track => track.type === TrackType.VIDEO)); }

  async verifyViewerPlayback(roomName: string, identity: string) {
    const participants = await this.rooms.listParticipants(roomName).catch(() => []);
    const viewer = participants.find(participant => participant.identity === identity);
    const hostPublishing = participants.some(participant => participant.identity !== identity && participant.tracks.some(track => track.type === TrackType.VIDEO));
    return Boolean(viewer && hostPublishing);
  }

  async getViewerCount(roomName: string) {
    const participants = await this.rooms.listParticipants(roomName);
    return participants.filter(participant => participant.identity.startsWith('viewer:') || participant.identity.startsWith('guest:')).length;
  }

  clientServerUrl() { return this.wsUrl; }
}

export type LiveKitCredentials = { url: string; apiKey: string; apiSecret: string };

class ReloadableLiveProvider implements LiveProviderAdapter {
  private delegate: LiveProviderAdapter;

  constructor() {
    this.delegate = credentialsFromEnvironment() ? new LiveKitProvider(credentialsFromEnvironment()!.url, credentialsFromEnvironment()!.apiKey, credentialsFromEnvironment()!.apiSecret) : new UnavailableLiveProvider();
  }

  setDelegate(provider: LiveProviderAdapter) { this.delegate = provider; }
  getReadiness() { return this.delegate.getReadiness(); }
  createSession(input: { title: string; scheduledAt?: Date }) { return this.delegate.createSession(input); }
  endSession(providerSessionRef: string) { return this.delegate.endSession(providerSessionRef); }
  issueViewerToken(roomName: string, identity: string, name?: string) { return this.delegate.issueViewerToken(roomName, identity, name); }
  issueHostToken(roomName: string, identity: string, name?: string) { return this.delegate.issueHostToken(roomName, identity, name); }
  verifyHostPublishing(roomName: string, identity: string) { return this.delegate.verifyHostPublishing(roomName, identity); }
  verifyViewerPlayback(roomName: string, identity: string) { return this.delegate.verifyViewerPlayback(roomName, identity); }
  getViewerCount(roomName: string) { return this.delegate.getViewerCount(roomName); }
  clientServerUrl() { return this.delegate.clientServerUrl(); }
}

export function credentialsFromEnvironment(): LiveKitCredentials | null {
  return env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
    ? { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET }
    : null;
}

export const liveProvider = new ReloadableLiveProvider();

export function configureLiveProvider(credentials: LiveKitCredentials | null) {
  liveProvider.setDelegate(credentials ? new LiveKitProvider(credentials.url, credentials.apiKey, credentials.apiSecret) : new UnavailableLiveProvider());
}
