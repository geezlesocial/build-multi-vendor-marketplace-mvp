import { diagnostics } from "./diagnostics.js";

const requestMethods = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const routeTemplatePattern = /^\/[A-Za-z0-9_:/.*-]*$/;

type RequestLogSource = {
  method: string;
  route?: { path: unknown };
  originalUrl?: string;
};

type ResponseLogSource = {
  statusCode: number;
};

type FinishResponseLogSource = ResponseLogSource & {
  once(event: "finish", listener: () => void): unknown;
};

export function httpRequestLogFields(
  request: RequestLogSource,
  response: ResponseLogSource,
  durationMs: number,
) {
  const routePath = request.route?.path;
  const routeTemplate =
    typeof routePath === "string" &&
    routePath.length <= 180 &&
    routeTemplatePattern.test(routePath)
      ? routePath
      : "UNMATCHED";
  const normalizedMethod = request.method.toUpperCase();
  const method = requestMethods.has(normalizedMethod)
    ? normalizedMethod
    : "OTHER";
  const statusCode =
    Number.isInteger(response.statusCode) &&
    response.statusCode >= 100 &&
    response.statusCode <= 599
      ? response.statusCode
      : 500;

  return {
    method,
    routeTemplate,
    statusCode,
    durationMs: Number.isFinite(durationMs)
      ? Math.max(0, Math.round(durationMs))
      : 0,
  };
}

export function attachHttpRequestLog(
  request: RequestLogSource,
  response: FinishResponseLogSource,
) {
  const startedAt = Date.now();
  response.once("finish", () => {
    diagnostics.logHttpRequest(
      httpRequestLogFields(request, response, Date.now() - startedAt),
    );
  });
}
