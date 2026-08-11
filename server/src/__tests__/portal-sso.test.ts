import { describe, expect, it } from "vitest";
import {
  hasPortalSsoConfiguration,
  NORTHERN_LOGIC_PORTAL_PROVIDER_ID,
  resolvePortalSsoConfig,
} from "../auth/portal-sso.js";

describe("Northern Logic portal SSO configuration", () => {
  it("is disabled without portal client configuration", () => {
    expect(hasPortalSsoConfiguration({})).toBe(false);
    expect(resolvePortalSsoConfig({}, "https://paperclip.example.test")).toBeNull();
  });

  it("builds the fixed PKCE callback from the canonical public URL", () => {
    const env = {
      PAPERCLIP_PORTAL_SSO_CLIENT_ID: "northern-logic-paperclip",
      PAPERCLIP_PORTAL_SSO_DISCOVERY_URL:
        "https://portal.northernlogic.ai/api/auth/.well-known/openid-configuration",
    };

    expect(hasPortalSsoConfiguration(env)).toBe(true);
    expect(resolvePortalSsoConfig(env, "https://paperclip.northernlogic.ai")).toEqual({
      clientId: "northern-logic-paperclip",
      discoveryUrl: "https://portal.northernlogic.ai/api/auth/.well-known/openid-configuration",
      providerId: NORTHERN_LOGIC_PORTAL_PROVIDER_ID,
      redirectURI:
        "https://paperclip.northernlogic.ai/api/auth/oauth2/callback/northern-logic-portal",
    });
  });

  it("fails closed on partial or unsafe configuration", () => {
    expect(() => resolvePortalSsoConfig(
      { PAPERCLIP_PORTAL_SSO_CLIENT_ID: "northern-logic-paperclip" },
      "https://paperclip.northernlogic.ai",
    )).toThrow(/requires both/);

    expect(() => resolvePortalSsoConfig({
      PAPERCLIP_PORTAL_SSO_CLIENT_ID: "northern-logic-paperclip",
      PAPERCLIP_PORTAL_SSO_DISCOVERY_URL:
        "http://portal.northernlogic.ai/api/auth/.well-known/openid-configuration",
    }, "https://paperclip.northernlogic.ai")).toThrow(/must use HTTPS/);

    expect(() => resolvePortalSsoConfig({
      PAPERCLIP_PORTAL_SSO_CLIENT_ID: "northern-logic-paperclip",
      PAPERCLIP_PORTAL_SSO_DISCOVERY_URL:
        "https://portal.northernlogic.ai/api/auth/.well-known/openid-configuration",
    }, "https://paperclip.northernlogic.ai/untrusted-path")).toThrow(/must be an origin/);
  });
});
