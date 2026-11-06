import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnostics } from "./diagnostics.js";
import {
  attachHttpRequestLog,
  httpRequestLogFields,
} from "./http-request-logging.js";

describe("HTTP request log fields", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the registered route template and omits raw URL data", () => {
    const fields = httpRequestLogFields(
      {
        method: "post",
        route: { path: "/api/orders/:orderId" },
        originalUrl: "/api/orders/private-order?token=private-token",
      },
      { statusCode: 201 },
      12.6,
    );

    expect(fields).toEqual({
      method: "POST",
      routeTemplate: "/api/orders/:orderId",
      statusCode: 201,
      durationMs: 13,
    });
    expect(JSON.stringify(fields)).not.toContain("private-order");
    expect(JSON.stringify(fields)).not.toContain("private-token");
  });

  it("uses a fixed fallback for unmatched or non-literal routes", () => {
    expect(
      httpRequestLogFields(
        { method: "TRACE", route: { path: "/api/orders?token=secret" } },
        { statusCode: 700 },
        Number.NaN,
      ),
    ).toEqual({
      method: "OTHER",
      routeTemplate: "UNMATCHED",
      statusCode: 500,
      durationMs: 0,
    });
    expect(
      httpRequestLogFields({ method: "GET" }, { statusCode: 404 }, -10),
    ).toEqual({
      method: "GET",
      routeTemplate: "UNMATCHED",
      statusCode: 404,
      durationMs: 0,
    });
  });

  it("logs only the matched route template when the response finishes", () => {
    const logHttpRequest = vi
      .spyOn(diagnostics, "logHttpRequest")
      .mockImplementation(() => {});
    let finishRequest: (() => void) | undefined;
    const request: Parameters<typeof httpRequestLogFields>[0] = {
      method: "GET",
      originalUrl: "/api/products/private-id?token=private-token",
    };
    const response = {
      statusCode: 200,
      once: vi.fn((_event: "finish", listener: () => void) => {
        finishRequest = listener;
      }),
    };

    attachHttpRequestLog(request, response);
    request.route = { path: "/api/products/:productId" };
    finishRequest?.();

    expect(response.once).toHaveBeenCalledOnce();
    expect(logHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        routeTemplate: "/api/products/:productId",
        statusCode: 200,
      }),
    );
  });
});
