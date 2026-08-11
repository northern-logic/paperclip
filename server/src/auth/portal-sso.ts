export const NORTHERN_LOGIC_PORTAL_PROVIDER_ID = "northern-logic-portal";

export type PortalSsoEnvironment = {
  PAPERCLIP_PORTAL_SSO_CLIENT_ID?: string;
  PAPERCLIP_PORTAL_SSO_CLIENT_SECRET?: string;
  PAPERCLIP_PORTAL_SSO_DISCOVERY_URL?: string;
};

export type PortalSsoConfig = {
  clientId: string;
  clientSecret?: string;
  discoveryUrl: string;
  providerId: typeof NORTHERN_LOGIC_PORTAL_PROVIDER_ID;
  redirectURI: string;
};

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function requireSafeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if ((url.protocol !== "https:" && !isLoopbackHttpUrl(url)) || url.username || url.password) {
    throw new Error(`${label} must use HTTPS (or loopback HTTP) without embedded credentials.`);
  }
  return url;
}

export function hasPortalSsoConfiguration(env: PortalSsoEnvironment = process.env): boolean {
  return Boolean(
    env.PAPERCLIP_PORTAL_SSO_CLIENT_ID?.trim()
      && env.PAPERCLIP_PORTAL_SSO_DISCOVERY_URL?.trim(),
  );
}

export function resolvePortalSsoConfig(
  env: PortalSsoEnvironment = process.env,
  publicUrl?: string,
): PortalSsoConfig | null {
  const clientId = env.PAPERCLIP_PORTAL_SSO_CLIENT_ID?.trim() ?? "";
  const discoveryUrl = env.PAPERCLIP_PORTAL_SSO_DISCOVERY_URL?.trim() ?? "";
  const clientSecret = env.PAPERCLIP_PORTAL_SSO_CLIENT_SECRET?.trim() || undefined;
  const configuredValueCount = Number(Boolean(clientId)) + Number(Boolean(discoveryUrl));

  if (configuredValueCount === 0) return null;
  if (configuredValueCount !== 2) {
    throw new Error(
      "Northern Logic portal SSO requires both PAPERCLIP_PORTAL_SSO_CLIENT_ID and "
        + "PAPERCLIP_PORTAL_SSO_DISCOVERY_URL.",
    );
  }
  if (!publicUrl?.trim()) {
    throw new Error("Northern Logic portal SSO requires PAPERCLIP_PUBLIC_URL or an explicit auth public URL.");
  }
  if (!/^[a-zA-Z0-9._~-]{3,128}$/.test(clientId)) {
    throw new Error("PAPERCLIP_PORTAL_SSO_CLIENT_ID contains unsupported characters.");
  }

  const discovery = requireSafeUrl(discoveryUrl, "PAPERCLIP_PORTAL_SSO_DISCOVERY_URL");
  if (!discovery.pathname.endsWith("/.well-known/openid-configuration")) {
    throw new Error("PAPERCLIP_PORTAL_SSO_DISCOVERY_URL must target OpenID Connect discovery metadata.");
  }
  const paperclipUrl = requireSafeUrl(publicUrl.trim(), "Paperclip public URL");
  if (paperclipUrl.pathname !== "/" || paperclipUrl.search || paperclipUrl.hash) {
    throw new Error("Paperclip public URL must be an origin without a path, query, or fragment for portal SSO.");
  }

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    discoveryUrl: discovery.toString(),
    providerId: NORTHERN_LOGIC_PORTAL_PROVIDER_ID,
    redirectURI: `${paperclipUrl.origin}/api/auth/oauth2/callback/${NORTHERN_LOGIC_PORTAL_PROVIDER_ID}`,
  };
}
