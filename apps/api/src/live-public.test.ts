import { describe, expect, it } from 'vitest';
import { publicLiveSession } from './live-public.js';

describe('public live-session serialization', () => {
  it('omits provider internals and private seller/product fields', () => {
    const result = publicLiveSession({
      id: 'session-1', title: 'Show', status: 'LIVE',
      providerSessionRef: 'private-session-ref', playbackRef: 'private-playback-ref',
      providerStatus: 'internal', errorMessage: 'provider secret detail',
      seller: { user: { email: 'seller@example.test' }, store: { name: 'Demo Store', slug: 'demo', contactJson: { phone: 'private' } } },
      products: [{ id: 'link-1', sessionId: 'session-1', productId: 'product-1', sortOrder: 0, featured: true, product: { id: 'product-1', name: 'Tote', description: 'Canvas', priceMinor: 2400, salePriceMinor: null, currency: 'USD', sellerId: 'internal-seller-id', wholesaleEnabled: true, inventory: { quantity: 4, privateStockNote: 'internal' } } }]
    });

    expect(result).not.toHaveProperty('providerSessionRef');
    expect(result).not.toHaveProperty('playbackRef');
    expect(result).not.toHaveProperty('providerStatus');
    expect(result).not.toHaveProperty('errorMessage');
    expect(result.seller).toEqual({ store: { name: 'Demo Store', slug: 'demo' } });
    expect(result.products).toEqual([{ id: 'link-1', productId: 'product-1', sortOrder: 0, featured: true, product: { id: 'product-1', name: 'Tote', description: 'Canvas', priceMinor: 2400, salePriceMinor: null, currency: 'USD', availableStock: 4 } }]);
  });

  it('only exposes a secure, public HTTPS playback URL', () => {
    expect(publicLiveSession({ id: 'a', playbackRef: 'https://video.example/live.m3u8' })).toMatchObject({ playbackAvailable: true, playbackUrl: 'https://video.example/live.m3u8' });
    expect(publicLiveSession({ id: 'b', playbackRef: 'http://video.example/live.m3u8' })).toMatchObject({ playbackAvailable: false });
    expect(publicLiveSession({ id: 'c', playbackRef: 'https://user:password@video.example/live.m3u8' })).toMatchObject({ playbackAvailable: false });
  });

  it('only exposes replay URLs after a ready recording is explicitly published', () => {
    const privateReplay = publicLiveSession({ id: 'private', recordingStatus: 'READY', recordingStorageKey: 'private/key.mp4', recordingEgressId: 'internal-egress', replayPublishedAt: null });
    expect(privateReplay).toMatchObject({ playbackAvailable: false, replayAvailable: false });
    expect(privateReplay).not.toHaveProperty('recordingStorageKey');
    expect(privateReplay).not.toHaveProperty('recordingEgressId');
    const publishedReplay = publicLiveSession({ id: 'published', status: 'ENDED', recordingStatus: 'READY', recordingStorageKey: 'private/key.mp4', replayPublishedAt: new Date() });
    expect(publishedReplay).toMatchObject({ playbackAvailable: true, replayAvailable: true, replayUrl: '/api/live-sessions/published/replay' });
    expect(publishedReplay).not.toHaveProperty('recordingStorageKey');
  });
});
