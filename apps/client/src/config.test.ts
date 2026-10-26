import { describe, expect, it } from "vitest";
import { resolveOrigins } from "./config";

describe("resolveOrigins", () => {
  it("defaults to production", () => {
    expect(resolveOrigins({})).toEqual({
      webAppUrl: "https://mcpemails.com",
      appOrigin: "https://app.mcpemails.com",
    });
  });

  it("takes a staging build's origins and drops trailing slashes", () => {
    expect(
      resolveOrigins({
        VITE_WEB_APP_URL: "https://staging.mcpemails.com/",
        VITE_APP_ORIGIN: " https://app-staging.mcpemails.com ",
      }),
    ).toEqual({
      webAppUrl: "https://staging.mcpemails.com",
      appOrigin: "https://app-staging.mcpemails.com",
    });
  });
});
