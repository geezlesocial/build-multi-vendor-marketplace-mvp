import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AvatarImageError, normalizeAvatarImage } from './avatar-image.js';

describe('avatar image normalization', () => {
  it('decodes raster content and normalizes it to metadata-stripped WebP', async () => {
    const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#48775a' } }).png().toBuffer();
    const result = await normalizeAvatarImage(png, 1024 * 1024);
    expect(result.bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(result.bytes.subarray(8, 12).toString()).toBe('WEBP');
    expect(result.width).toBe(24);
    expect(result.height).toBe(16);
  });

  it('rejects SVG, malformed bytes, and files over the configured limit', async () => {
    await expect(normalizeAvatarImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 1024)).rejects.toMatchObject({ status: 415 });
    await expect(normalizeAvatarImage(Buffer.from('not an image'), 1024)).rejects.toBeInstanceOf(AvatarImageError);
    await expect(normalizeAvatarImage(Buffer.alloc(20), 10)).rejects.toMatchObject({ status: 413 });
  });
});
