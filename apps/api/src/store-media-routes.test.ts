import { describe, expect, it } from 'vitest';
import { detectStoreMedia } from './store-media-routes.js';

describe('store media type verification', () => {
  it('accepts supported signatures only when the filename and claimed MIME agree', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectStoreMedia(png, 'png', 'image/png')).toEqual({ kind: 'IMAGE', mime: 'image/png', extension: 'png' });

    const csv = Buffer.from('name,quantity\nSample,2\n', 'utf8');
    expect(detectStoreMedia(csv, 'csv', 'text/csv')).toEqual({ kind: 'DOCUMENT', mime: 'text/csv', extension: 'csv' });
  });

  it('uses the correct OOXML MIME type and rejects extension, MIME, or content mismatches', () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(detectStoreMedia(zipHeader, 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toEqual({
      kind: 'DOCUMENT',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx'
    });
    expect(() => detectStoreMedia(zipHeader, 'docx', 'application/docx')).toThrow(/content does not match/i);
    expect(() => detectStoreMedia(zipHeader, 'exe', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toThrow(/extension does not match/i);
    expect(() => detectStoreMedia(Buffer.from('<svg onload="alert(1)">'), 'svg', 'image/svg+xml')).toThrow(/content does not match/i);
  });
});
