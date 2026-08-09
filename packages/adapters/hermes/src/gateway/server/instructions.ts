import { createHash } from "node:crypto";

import type {
  AdapterEnvironmentCheck,
  AdapterInstructionsBundleSnapshot,
  AdapterInstructionsContext,
  AdapterInstructionsFileDetail,
  AdapterInstructionsFileSummary,
} from "@paperclipai/adapter-utils";

import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const INSTRUCTION_ENTRY_FILE = "AGENTS.md";
const INSTRUCTION_FILE_NAMES = [INSTRUCTION_ENTRY_FILE, "HEARTBEAT.md", "SOUL.md", "TOOLS.md"] as const;
const INSTRUCTION_FILE_NAME_SET = new Set<string>(INSTRUCTION_FILE_NAMES);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

type InstructionServiceConfig = {
  profile: string;
  bridgeBaseUrl: URL;
  bridgeCredential: string;
  timeoutMs: number;
};

export class HermesGatewayInstructionsError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "HermesGatewayInstructionsError";
    this.code = code;
    this.status = status;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function instructionFileName(value: string): string {
  if (!INSTRUCTION_FILE_NAME_SET.has(value)) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_file_invalid",
      `Hermes Gateway instruction file must be one of: ${INSTRUCTION_FILE_NAMES.join(", ")}.`,
      422,
    );
  }
  return value;
}

function normalizeBridgeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_bridge_url_invalid",
      "Hermes instruction bridge URL must be a valid http:// or https:// URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_bridge_url_invalid",
      "Hermes instruction bridge URL must use http:// or https://.",
    );
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function resolveInstructionServiceConfig(config: Record<string, unknown>): InstructionServiceConfig {
  const bridgeBaseUrl = nonEmpty(config.skillBridgeBaseUrl);
  const bridgeCredential = nonEmpty(config.skillBridgeCredential);
  if (!bridgeBaseUrl || !bridgeCredential) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_management_config_incomplete",
      "Hermes Gateway instruction management requires skillBridgeBaseUrl and skillBridgeCredential.",
    );
  }

  const profile = nonEmpty(config.profile) ?? "default";
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_profile_invalid",
      `Invalid Hermes profile name ${JSON.stringify(profile)}.`,
    );
  }

  const resolvedBridgeUrl = normalizeBridgeBaseUrl(bridgeBaseUrl);
  if (isRemotePlainHttp(resolvedBridgeUrl) && !allowsInsecureRemoteHttp(config)) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_plain_http_remote_denied",
      remotePlainHttpDeniedMessage(resolvedBridgeUrl.hostname),
    );
  }

  return {
    profile,
    bridgeBaseUrl: resolvedBridgeUrl,
    bridgeCredential,
    timeoutMs: Math.min(60_000, positiveInteger(config.skillManagementTimeoutMs, DEFAULT_TIMEOUT_MS)),
  };
}

function endpoint(service: InstructionServiceConfig, fileName?: string): string {
  const url = new URL(service.bridgeBaseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/v1/instructions${fileName ? `/${encodeURIComponent(fileName)}` : ""}`
    .replace(/\/{2,}/g, "/");
  url.search = "";
  url.searchParams.set("profile", service.profile);
  return url.toString();
}

async function readCappedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new HermesGatewayInstructionsError(
        "hermes_gateway_instruction_response_too_large",
        "Hermes instruction service response exceeded the allowed size.",
      );
    }
    return text;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HermesGatewayInstructionsError(
        "hermes_gateway_instruction_response_too_large",
        "Hermes instruction service response exceeded the allowed size.",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestJson(
  service: InstructionServiceConfig,
  url: string,
  init: RequestInit,
  expectedStatuses: number[] = [200],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${service.bridgeCredential}`,
        ...init.headers,
      },
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readCappedBody(response);
    if (!expectedStatuses.includes(response.status)) {
      const payload = (() => {
        try {
          return asRecord(JSON.parse(text) as unknown);
        } catch {
          return null;
        }
      })();
      throw new HermesGatewayInstructionsError(
        response.status === 404
          ? "hermes_gateway_instruction_file_not_found"
          : response.status === 401 || response.status === 403
            ? "hermes_gateway_instruction_auth_failed"
            : "hermes_gateway_instruction_service_error",
        nonEmpty(payload?.message) ?? `Hermes instruction service returned HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HermesGatewayInstructionsError(
        "hermes_gateway_instruction_protocol_error",
        "Hermes instruction service returned invalid JSON.",
      );
    }
  } catch (error) {
    if (error instanceof HermesGatewayInstructionsError) throw error;
    const detail = error instanceof Error && error.name === "AbortError" ? "timed out" : "was unreachable";
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_service_unreachable",
      `Hermes instruction service ${detail}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseSummary(raw: unknown, entryFile: string): AdapterInstructionsFileSummary {
  const item = asRecord(raw);
  const filePath = nonEmpty(item?.path);
  const size = item?.size;
  const sha256 = nonEmpty(item?.sha256);
  if (
    !item
    || !filePath
    || !INSTRUCTION_FILE_NAME_SET.has(filePath)
    || !Number.isSafeInteger(size)
    || Number(size) < 0
    || Number(size) > MAX_INSTRUCTION_FILE_BYTES
    || !sha256
    || !CONTENT_HASH_RE.test(sha256)
  ) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_protocol_error",
      "Hermes instruction service returned invalid file metadata.",
    );
  }
  return {
    path: filePath,
    size: Number(size),
    language: "markdown",
    markdown: true,
    isEntryFile: filePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

function parseBundle(payload: unknown, service: InstructionServiceConfig): AdapterInstructionsBundleSnapshot {
  const record = asRecord(payload);
  const entryFile = nonEmpty(record?.entryFile);
  const rawFiles = Array.isArray(record?.files) ? record.files : null;
  if (
    record?.schemaVersion !== 1
    || record?.profile !== service.profile
    || entryFile !== INSTRUCTION_ENTRY_FILE
    || !rawFiles
    || rawFiles.length > INSTRUCTION_FILE_NAMES.length
  ) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_bridge_contract_mismatch",
      "Northern Logic bridge does not implement the profile instruction contract.",
    );
  }
  const seen = new Set<string>();
  const files = rawFiles.map((raw) => {
    const summary = parseSummary(raw, entryFile);
    if (seen.has(summary.path)) {
      throw new HermesGatewayInstructionsError(
        "hermes_gateway_instruction_protocol_error",
        "Hermes instruction service returned duplicate files.",
      );
    }
    seen.add(summary.path);
    return summary;
  });
  return {
    mode: "remote",
    entryFile,
    editable: true,
    warnings: [],
    files,
  };
}

function parseDetail(payload: unknown, service: InstructionServiceConfig, fileName: string): AdapterInstructionsFileDetail {
  const record = asRecord(payload);
  if (record?.schemaVersion !== 1 || record?.profile !== service.profile || record?.path !== fileName) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_protocol_error",
      "Hermes instruction service returned mismatched file content.",
    );
  }
  const summary = parseSummary(record, INSTRUCTION_ENTRY_FILE);
  const contentHash = typeof record.content === "string"
    ? `sha256:${createHash("sha256").update(record.content, "utf8").digest("hex")}`
    : null;
  if (
    typeof record.content !== "string"
    || Buffer.byteLength(record.content, "utf8") !== summary.size
    || record.sha256 !== contentHash
  ) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_protocol_error",
      "Hermes instruction service returned invalid file content.",
    );
  }
  return { ...summary, content: record.content };
}

export async function getGatewayInstructionsBundle(
  ctx: AdapterInstructionsContext,
): Promise<AdapterInstructionsBundleSnapshot> {
  const service = resolveInstructionServiceConfig(ctx.config);
  const payload = await requestJson(service, endpoint(service), { method: "GET" });
  return parseBundle(payload, service);
}

export async function testGatewayInstructionsService(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck[]> {
  if (!nonEmpty(config.skillBridgeBaseUrl) && !nonEmpty(config.skillBridgeCredential)) return [];
  try {
    const service = resolveInstructionServiceConfig(config);
    const payload = await requestJson(service, endpoint(service), { method: "GET" });
    parseBundle(payload, service);
    return [{
      code: "hermes_gateway_instruction_management_ok",
      level: "info",
      message: `Hermes profile instruction files are reachable for profile ${service.profile}.`,
    }];
  } catch (error) {
    return [{
      code: error instanceof HermesGatewayInstructionsError
        ? error.code
        : "hermes_gateway_instruction_management_failed",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    }];
  }
}

export async function readGatewayInstructionsFile(
  ctx: AdapterInstructionsContext,
  path: string,
): Promise<AdapterInstructionsFileDetail> {
  const service = resolveInstructionServiceConfig(ctx.config);
  const fileName = instructionFileName(path);
  const payload = await requestJson(service, endpoint(service, fileName), { method: "GET" });
  return parseDetail(payload, service, fileName);
}

export async function writeGatewayInstructionsFile(
  ctx: AdapterInstructionsContext,
  path: string,
  content: string,
): Promise<AdapterInstructionsFileDetail> {
  const service = resolveInstructionServiceConfig(ctx.config);
  const fileName = instructionFileName(path);
  if (Buffer.byteLength(content, "utf8") > MAX_INSTRUCTION_FILE_BYTES) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_file_too_large",
      "Hermes instruction file exceeds the allowed size.",
      413,
    );
  }
  const payload = await requestJson(
    service,
    endpoint(service, fileName),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, profile: service.profile, content }),
    },
    [200, 201],
  );
  return parseDetail(payload, service, fileName);
}

export async function deleteGatewayInstructionsFile(
  ctx: AdapterInstructionsContext,
  path: string,
): Promise<AdapterInstructionsBundleSnapshot> {
  const service = resolveInstructionServiceConfig(ctx.config);
  const fileName = instructionFileName(path);
  if (fileName === INSTRUCTION_ENTRY_FILE) {
    throw new HermesGatewayInstructionsError(
      "hermes_gateway_instruction_entry_required",
      `${INSTRUCTION_ENTRY_FILE} is the remote profile entry file and cannot be deleted.`,
      422,
    );
  }
  await requestJson(service, endpoint(service, fileName), { method: "DELETE" });
  const payload = await requestJson(service, endpoint(service), { method: "GET" });
  return parseBundle(payload, service);
}

export async function loadGatewayEntryInstructions(config: Record<string, unknown>): Promise<string | null> {
  const service = resolveInstructionServiceConfig(config);
  try {
    const payload = await requestJson(
      service,
      endpoint(service, INSTRUCTION_ENTRY_FILE),
      { method: "GET" },
    );
    const detail = parseDetail(payload, service, INSTRUCTION_ENTRY_FILE);
    return detail.content.trim() ? detail.content : null;
  } catch (error) {
    if (error instanceof HermesGatewayInstructionsError && error.status === 404) return null;
    throw error;
  }
}
