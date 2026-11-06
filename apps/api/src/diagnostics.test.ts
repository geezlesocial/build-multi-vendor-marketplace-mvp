import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnostics } from "./diagnostics.js";

describe("structured diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes safe structured request records with the active correlation id", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    diagnostics.runWithRequestContext("request-log-test-123", () => {
      diagnostics.logHttpRequest({
        method: "GET",
        routeTemplate: "/api/products/:productId",
        statusCode: 200,
        durationMs: 18,
      });
    });

    expect(write).toHaveBeenCalledOnce();
    const record = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      level: "info",
      event: "HTTP_REQUEST_COMPLETED",
      correlationId: "request-log-test-123",
      method: "GET",
      routeTemplate: "/api/products/:productId",
      statusCode: 200,
      durationMs: 18,
    });
  });

  it("writes a safe JSON error record with the active request correlation id", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    diagnostics.runWithRequestContext("request-test-123", () => {
      diagnostics.logOperationalError(
        "HTTP_REQUEST_FAILED",
        new Error("private-token-must-not-be-logged"),
      );
    });

    expect(write).toHaveBeenCalledOnce();
    const record = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      level: "error",
      event: "HTTP_REQUEST_FAILED",
      correlationId: "request-test-123",
      errorCategory: "APPLICATION_ERROR",
    });
    expect(String(write.mock.calls[0]?.[0])).not.toContain(
      "private-token-must-not-be-logged",
    );
  });

  it("normalizes unknown event names and non-Error payloads", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    diagnostics.logOperationalError("untrusted-event-name", {
      secret: "not-for-logs",
    });

    const record = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      event: "APPLICATION_ERROR",
      errorCategory: "UNKNOWN_ERROR",
    });
    expect(String(write.mock.calls[0]?.[0])).not.toContain("not-for-logs");
  });
});
