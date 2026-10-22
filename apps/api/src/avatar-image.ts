import sharp from 'sharp';

const MAX_AVATAR_PIXELS = 16_000_000;

export class AvatarImageError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function normalizeAvatarImage(input: Buffer, maxBytes: number) {
  if (!input.length) throw new AvatarImageError('Choose an image to upload.', 400);
  if (input.length > maxBytes) throw new AvatarImageError('Image exceeds the configured size limit.', 413);
  try {
    const decoder = sharp(input, { failOn: 'warning', limitInputPixels: MAX_AVATAR_PIXELS, animated: false });
    const metadata = await decoder.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
      throw new AvatarImageError('Use a non-animated PNG, JPEG, or WebP image.', 415);
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_AVATAR_PIXELS) {
      throw new AvatarImageError('Image dimensions are invalid or too large.', 415);
    }
    const normalized = await sharp(input, { failOn: 'warning', limitInputPixels: MAX_AVATAR_PIXELS, animated: false })
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: normalized.data, width: normalized.info.width, height: normalized.info.height };
  } catch (error) {
    if (error instanceof AvatarImageError) throw error;
    throw new AvatarImageError('The uploaded file is not a valid supported image.', 415);
  }
}
