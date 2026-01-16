import { describe, expect, it } from "vitest";

import { GET } from "../app/health/route";

describe("GET /health", () => {
  it("returns the stable Web health payload", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      service: "web",
      status: "ok",
    });
  });
});
