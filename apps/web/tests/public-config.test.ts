import { describe, expect, it } from "vitest";

import { getPublicConfig } from "../app/public-config";

describe("public config", () => {
  it("uses the injected GitHub repository URL", () => {
    expect(
      getPublicConfig({
        PUBLIC_GITHUB_URL: "https://github.com/example/snapflow-shell/",
      }),
    ).toEqual({
      githubUrl: "https://github.com/example/snapflow-shell",
    });
  });

  it("rejects non-GitHub and non-HTTPS source links", () => {
    expect(() =>
      getPublicConfig({ PUBLIC_GITHUB_URL: "http://example.com/source" }),
    ).toThrow("PUBLIC_GITHUB_URL must be an HTTPS GitHub repository URL");
  });
});
