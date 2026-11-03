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
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function uploadThemePreviewFile(
  url: string,
  fields: Record<string, string>,
  file: File,
  progress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const localUpload = fields["x-local-upload"] === "1";
    request.open(localUpload ? "PUT" : "POST", url);
    request.withCredentials = false;
    request.timeout = 120_000;
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
              "Media storage rejected the upload; the current theme image remains active.",
            ),
          );
    request.onerror = () =>
      reject(
        new Error(
          "Media storage could not be reached; the current theme image remains active.",
        ),
      );
    request.ontimeout = () =>
      reject(
        new Error(
          "The image upload timed out; the current theme image remains active.",
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
