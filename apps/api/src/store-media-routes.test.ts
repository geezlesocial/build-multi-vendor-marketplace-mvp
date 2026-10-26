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

  it('recognizes AVIF and HEIC image signatures', () => {
    const ftyp = (brand: string) => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32BE(bytes.length, 0);
      bytes.write('ftyp', 4, 'ascii');
      bytes.write(brand, 8, 'ascii');
      return bytes;
    };
    expect(detectStoreMedia(ftyp('avif'), 'avif', 'image/avif')).toEqual({ kind: 'IMAGE', mime: 'image/avif', extension: 'avif' });
    expect(detectStoreMedia(ftyp('heic'), 'heic', 'image/heic')).toEqual({ kind: 'IMAGE', mime: 'image/heic', extension: 'heic' });
    expect(() => detectStoreMedia(ftyp('avif'), 'mp4', 'video/mp4')).toThrow(/content does not match/i);
  });

  it('recognizes the requested ISO-BMFF and Matroska video formats', () => {
    const ftyp = (brand: string) => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32BE(bytes.length, 0);
      bytes.write('ftyp', 4, 'ascii');
      bytes.write(brand, 8, 'ascii');
      return bytes;
    };
    expect(detectStoreMedia(ftyp('qt  '), 'mov', 'video/quicktime')).toEqual({ kind: 'VIDEO', mime: 'video/quicktime', extension: 'mov' });
    expect(detectStoreMedia(ftyp('M4V '), 'm4v', 'video/x-m4v')).toEqual({ kind: 'VIDEO', mime: 'video/x-m4v', extension: 'm4v' });
    expect(detectStoreMedia(ftyp('3gp6'), '3gp', 'video/3gpp')).toEqual({ kind: 'VIDEO', mime: 'video/3gpp', extension: '3gp' });
    expect(detectStoreMedia(ftyp('isom'), 'mp4', 'video/mp4')).toEqual({ kind: 'VIDEO', mime: 'video/mp4', extension: 'mp4' });
    const matroska = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska', 'ascii')]);
    expect(detectStoreMedia(matroska, 'mkv', 'video/x-matroska')).toEqual({ kind: 'VIDEO', mime: 'video/x-matroska', extension: 'mkv' });
  });

  it('recognizes legacy Word documents while retaining PDF support', () => {
    const word = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectStoreMedia(word, 'doc', 'application/msword')).toEqual({ kind: 'DOCUMENT', mime: 'application/msword', extension: 'doc' });
    expect(detectStoreMedia(Buffer.from('%PDF-1.7\n'), 'pdf', 'application/pdf')).toEqual({ kind: 'DOCUMENT', mime: 'application/pdf', extension: 'pdf' });
  });
});
