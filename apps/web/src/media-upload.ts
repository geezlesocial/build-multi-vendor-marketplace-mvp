const extensionMimeTypes: Record<string, string[]> = {
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'], webp: ['image/webp'], avif: ['image/avif'],
  gif: ['image/gif'], heic: ['image/heic', 'image/heif'], heif: ['image/heif', 'image/heic'],
  mp4: ['video/mp4'], mov: ['video/quicktime'], webm: ['video/webm'], m4v: ['video/x-m4v', 'video/mp4'],
  '3gp': ['video/3gpp'], mkv: ['video/x-matroska', 'video/matroska'],
  pdf: ['application/pdf'], doc: ['application/msword'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], csv: ['text/csv']
};

export const PRODUCT_MEDIA_ACCEPT = Object.keys(extensionMimeTypes).map(extension => `.${extension}`).join(',');
export const PRODUCT_MEDIA_LIMITS = { IMAGE: 12, VIDEO: 1, DOCUMENT: 4 } as const;
export type ProductMediaKind = keyof typeof PRODUCT_MEDIA_LIMITS;
export type ProductMediaCounts = Record<ProductMediaKind, number>;

export function productMediaKindForFile(fileName: string): ProductMediaKind | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'heic', 'heif'].includes(extension)) return 'IMAGE';
  if (['mp4', 'mov', 'webm', 'm4v', '3gp', 'mkv'].includes(extension)) return 'VIDEO';
  if (['pdf', 'doc', 'docx', 'xlsx', 'pptx', 'csv'].includes(extension)) return 'DOCUMENT';
  return null;
}

export function productMediaCounts(product: { images?: unknown[]; mediaAttachments?: { mediaAsset?: { kind?: string }; kind?: string }[] }): ProductMediaCounts {
  const counts: ProductMediaCounts = { IMAGE: product.images?.length ?? 0, VIDEO: 0, DOCUMENT: 0 };
  for (const attachment of product.mediaAttachments ?? []) {
    const kind = attachment.mediaAsset?.kind ?? attachment.kind;
    if (kind === 'IMAGE') counts.IMAGE += 1;
    else if (kind === 'VIDEO') counts.VIDEO += 1;
    else if (kind === 'DOCUMENT') counts.DOCUMENT += 1;
  }
  return counts;
}

export function uploadContentType(file: Pick<File, 'name' | 'type'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const supported = extensionMimeTypes[extension];
  if (!supported) return null;
  if (file.type && supported.includes(file.type)) return file.type;
  if (!file.type || file.type === 'application/octet-stream') return supported[0] ?? null;
  return null;
}

export function uploadToSignedPost(url: string, fields: Record<string, string>, file: File, onProgress: (percent: number) => void) {
  return uploadToSignedPostWithType(url, fields, file, onProgress, file.type);
}

export function uploadToSignedPostWithType(url: string, fields: Record<string, string>, file: File, onProgress: (percent: number) => void, contentType: string) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = false;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error('Managed storage could not be reached. Try again.'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Managed storage rejected ${file.name} (HTTP ${xhr.status}). Retry the upload or contact support if it continues.`));
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    const typedFile = file.type === contentType ? file : new File([file], file.name, { type: contentType, lastModified: file.lastModified });
    form.append('file', typedFile);
    xhr.send(form);
  });
}

export function uploadToLocalApi(url: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const csrfToken = document.cookie
      .split('; ')
      .find(value => value.startsWith('marketplace_csrf='))
      ?.slice('marketplace_csrf='.length);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error(`${file.name}: the local upload service could not be reached. Check your connection and retry.`));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `${file.name}: upload failed (HTTP ${xhr.status}). Retry the upload.`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) message = `${file.name}: ${body.error}`;
      } catch { /* The API may return a non-JSON request-limit response. */ }
      reject(new Error(message));
    };
    xhr.send(file);
  });
}
