export async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}
