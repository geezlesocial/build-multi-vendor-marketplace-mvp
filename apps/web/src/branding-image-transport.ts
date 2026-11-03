export type Asset = {
  id: string;
  originalName: string;
  safeName?: string;
  kind?: string;
  sizeBytes: number;
  scanStatus: string;
  scanErrorCode?: string | null;
  scanAttemptCount?: number;
  uploadStatus: string;
  storageProvider?: string;
  width?: number | null;
  height?: number | null;
};

export type MediaList =
  Asset[] | { assets: Asset[]; usedBytes: number; limitBytes: number };

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Image request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

const mediaListRequests = new Map<string, Promise<MediaList>>();

export function requestMediaList(path: string): Promise<MediaList> {
  const csrfToken = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const requestKey = `${csrfToken ?? "anonymous"}:${path}`;
  const existing = mediaListRequests.get(requestKey);
  if (existing) return existing;
  const request = api<MediaList>(path).finally(() => {
    if (mediaListRequests.get(requestKey) === request)
      mediaListRequests.delete(requestKey);
  });
  mediaListRequests.set(requestKey, request);
  return request;
}

export function uploadToSignedPost(
  url: string,
  fields: Record<string, string>,
  file: File,
  progress: (value: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const localUpload = fields["x-local-upload"] === "1";
    request.open(localUpload ? "PUT" : "POST", url);
    request.withCredentials = false;
    if (localUpload) {
      request.setRequestHeader("Content-Type", file.type);
      const csrf = document.cookie
        .split("; ")
        .find((value) => value.startsWith("marketplace_csrf="))
        ?.split("=")[1];
      if (csrf) request.setRequestHeader("x-csrf-token", csrf);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(
            new Error(
              "Managed storage rejected the upload. The existing published image remains active.",
            ),
          );
    request.onerror = () =>
      reject(
        new Error(
          "Managed storage could not be reached. The existing published image remains active.",
        ),
      );
    if (localUpload) {
      request.send(file);
      return;
    }
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    form.append("file", file);
    request.send(form);
  });
}

export async function cropRaster(
  file: File,
  ratio: number,
  focusX: number,
  focusY: number,
): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height)
      throw new Error("Image dimensions could not be read.");
    const sourceRatio = bitmap.width / bitmap.height;
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    if (sourceRatio > ratio) {
      sw = bitmap.height * ratio;
      sx = (bitmap.width - sw) * focusX;
    } else {
      sh = bitmap.width / ratio;
      sy = (bitmap.height - sh) * focusY;
    }
    const outputWidth = Math.min(1400, Math.max(256, Math.round(sw)));
    const outputHeight = Math.max(1, Math.round(outputWidth / ratio));
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image crop is unavailable in this browser.");
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Image crop could not be encoded.")),
        "image/webp",
        0.86,
      ),
    );
    return new File(
      [blob],
      `${file.name.replace(/\.[^.]+$/, "") || "branding-image"}.webp`,
      { type: "image/webp", lastModified: Date.now() },
    );
  } finally {
    bitmap.close();
  }
}
