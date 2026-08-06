import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterEnvironmentCheck,
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

import { ADAPTER_TYPE } from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RUNTIME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HERMES_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_REMOTE_SKILLS = 1_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_FILES = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

type JsonRecord = Record<string, unknown>;

interface SkillServiceConfig {
  profile: string;
  managementBaseUrl: URL;
  managementCredential: string;
  bridgeBaseUrl: URL;
  bridgeCredential: string;
  timeoutMs: number;
}

interface HermesSkill {
  name: string;
  description: string | null;
  category: string | null;
  enabled: boolean;
  provenance: string | null;
}

interface PaperclipOwner {
  kind: "paperclip";
  companyId: string;
  agentId: string;
  skillKey: string;
}

interface BridgeReceipt {
  runtimeName: string;
  skillName: string;
  profile: string;
  versionId: string | null;
  currentVersionId: string | null;
  contentHash: string;
  state: "in_sync" | "drifted";
  owner: PaperclipOwner;
}

interface BridgeFile {
  path: string;
  encoding: "base64";
  content: string;
  size: number;
  sha256: string;
  mode: number;
}

interface DesiredBundle {
  key: string;
  runtimeName: string;
  skillName: string;
  versionId: string | null;
  currentVersionId: string | null;
  source: string;
  contentHash: string;
  files: BridgeFile[];
}

export class HermesGatewaySkillError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HermesGatewaySkillError";
    this.code = code;
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

function normalizeServiceBaseUrl(value: string, kind: "management" | "bridge"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HermesGatewaySkillError(
      `hermes_gateway_${kind}_base_url_invalid`,
      `Hermes ${kind} base URL must be a valid http:// or https:// URL.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HermesGatewaySkillError(
      `hermes_gateway_${kind}_base_url_invalid`,
      `Hermes ${kind} base URL must use http:// or https://.`,
    );
  }
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (kind === "management" && (pathname === "/api" || pathname === "/chat")) pathname = "";
  url.pathname = pathname || "/";
  return url;
}

function endpoint(baseUrl: URL, pathname: string, query: Record<string, string> = {}): string {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${pathname}`.replace(/\/{2,}/g, "/");
  url.search = "";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function configuredSkillFields(config: Record<string, unknown>): boolean {
  return [
    config.managementBaseUrl,
    config.managementCredential,
    config.skillBridgeBaseUrl,
    config.skillBridgeCredential,
  ].some((value) => nonEmpty(value) !== null);
}

function resolveSkillServiceConfig(config: Record<string, unknown>): SkillServiceConfig | null {
  if (!configuredSkillFields(config)) return null;

  const managementBaseUrl = nonEmpty(config.managementBaseUrl);
  const managementCredential = nonEmpty(config.managementCredential);
  const bridgeBaseUrl = nonEmpty(config.skillBridgeBaseUrl);
  const bridgeCredential = nonEmpty(config.skillBridgeCredential);
  if (!managementBaseUrl || !managementCredential || !bridgeBaseUrl || !bridgeCredential) {
    const missing = [
      !managementBaseUrl ? "managementBaseUrl" : null,
      !managementCredential ? "managementCredential" : null,
      !bridgeBaseUrl ? "skillBridgeBaseUrl" : null,
      !bridgeCredential ? "skillBridgeCredential" : null,
    ].filter((value): value is string => Boolean(value));
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_management_config_incomplete",
      `Hermes Gateway skill management is missing: ${missing.join(", ")}.`,
    );
  }

  const profile = nonEmpty(config.profile) ?? "default";
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_profile_invalid",
      `Invalid Hermes profile name ${JSON.stringify(profile)}.`,
    );
  }

  const resolvedManagementUrl = normalizeServiceBaseUrl(managementBaseUrl, "management");
  const resolvedBridgeUrl = normalizeServiceBaseUrl(bridgeBaseUrl, "bridge");
  for (const [kind, url] of [
    ["management", resolvedManagementUrl],
    ["skill bridge", resolvedBridgeUrl],
  ] as const) {
    if (isRemotePlainHttp(url) && !allowsInsecureRemoteHttp(config)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_plain_http_remote_denied",
        `${kind}: ${remotePlainHttpDeniedMessage(url.hostname)}`,
      );
    }
  }

  return {
    profile,
    managementBaseUrl: resolvedManagementUrl,
    managementCredential,
    bridgeBaseUrl: resolvedBridgeUrl,
    bridgeCredential,
    timeoutMs: Math.min(60_000, positiveInteger(config.skillManagementTimeoutMs, DEFAULT_TIMEOUT_MS)),
  };
}

async function readCappedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_response_too_large",
        "Hermes skill service response exceeded the allowed size.",
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
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_response_too_large",
        "Hermes skill service response exceeded the allowed size.",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  expectedStatuses: number[] = [200],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readCappedBody(response);
    if (!expectedStatuses.includes(response.status)) {
      throw new HermesGatewaySkillError(
        response.status === 401 || response.status === 403
          ? "hermes_gateway_skill_auth_failed"
          : "hermes_gateway_skill_service_error",
        `Hermes skill service returned HTTP ${response.status}.`,
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_protocol_error",
        "Hermes skill service returned invalid JSON.",
      );
    }
  } catch (error) {
    if (error instanceof HermesGatewaySkillError) throw error;
    const detail = error instanceof Error && error.name === "AbortError" ? "timed out" : "was unreachable";
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_service_unreachable",
      `Hermes skill service ${detail}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function managementHeaders(service: SkillServiceConfig, contentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Hermes-Session-Token": service.managementCredential,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  };
}

function bridgeHeaders(service: SkillServiceConfig, contentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${service.bridgeCredential}`,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchHermesSkills(service: SkillServiceConfig): Promise<HermesSkill[]> {
  const payload = await requestJson(
    endpoint(service.managementBaseUrl, "/api/skills", { profile: service.profile }),
    { method: "GET", headers: managementHeaders(service) },
    service.timeoutMs,
  );
  if (!Array.isArray(payload) || payload.length > MAX_REMOTE_SKILLS) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_protocol_error",
      "Hermes dashboard returned an invalid skill inventory.",
    );
  }

  const seen = new Set<string>();
  return payload.map((raw) => {
    const record = asRecord(raw);
    const name = nonEmpty(record?.name);
    if (!record || !name || typeof record.enabled !== "boolean" || seen.has(name)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_protocol_error",
        "Hermes dashboard returned an invalid or duplicate skill entry.",
      );
    }
    seen.add(name);
    return {
      name,
      description: nonEmpty(record.description),
      category: nonEmpty(record.category),
      enabled: record.enabled !== false,
      provenance: nonEmpty(record.provenance),
    };
  });
}

function parseOwner(value: unknown): PaperclipOwner | null {
  const record = asRecord(value);
  if (
    record?.kind !== "paperclip"
    || !nonEmpty(record.companyId)
    || !nonEmpty(record.agentId)
    || !nonEmpty(record.skillKey)
  ) return null;
  return {
    kind: "paperclip",
    companyId: nonEmpty(record.companyId)!,
    agentId: nonEmpty(record.agentId)!,
    skillKey: nonEmpty(record.skillKey)!,
  };
}

async function fetchBridgeReceipts(service: SkillServiceConfig): Promise<BridgeReceipt[]> {
  const payload = await requestJson(
    endpoint(service.bridgeBaseUrl, "/v1/skill-bundles", { profile: service.profile }),
    { method: "GET", headers: bridgeHeaders(service) },
    service.timeoutMs,
  );
  const record = asRecord(payload);
  const rawSkills = Array.isArray(record?.skills)
    ? record.skills
    : Array.isArray(record?.data)
      ? record.data
      : null;
  if (record?.schemaVersion !== 1 || !rawSkills || rawSkills.length > MAX_REMOTE_SKILLS) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_bridge_contract_mismatch",
      "Northern Logic skill bridge does not implement contract version 1.",
    );
  }

  const seen = new Set<string>();
  const seenSkillNames = new Set<string>();
  return rawSkills.map((raw) => {
    const item = asRecord(raw);
    const runtimeName = nonEmpty(item?.runtimeName);
    const skillName = nonEmpty(item?.skillName);
    const profile = nonEmpty(item?.profile);
    const contentHash = nonEmpty(item?.contentHash);
    const state = item?.state;
    const versionId = item?.versionId === null ? null : nonEmpty(item?.versionId);
    const currentVersionId = item?.currentVersionId === null ? null : nonEmpty(item?.currentVersionId);
    const owner = parseOwner(item?.owner);
    if (
      !item
      || !runtimeName
      || !RUNTIME_NAME_RE.test(runtimeName)
      || !skillName
      || !HERMES_SKILL_NAME_RE.test(skillName)
      || !profile
      || profile !== service.profile
      || !contentHash?.match(/^sha256:[0-9a-f]{64}$/)
      || (state !== "in_sync" && state !== "drifted")
      || (item.versionId !== null && !versionId)
      || (item.currentVersionId !== null && !currentVersionId)
      || !owner
      || seen.has(runtimeName)
      || seenSkillNames.has(skillName)
    ) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_bridge_protocol_error",
        "Northern Logic skill bridge returned an invalid or duplicate receipt.",
      );
    }
    seen.add(runtimeName);
    seenSkillNames.add(skillName);
    return {
      runtimeName,
      skillName,
      profile,
      versionId,
      currentVersionId,
      contentHash,
      state,
      owner,
    };
  });
}

function ownsReceipt(receipt: BridgeReceipt, ctx: AdapterSkillContext): boolean {
  return receipt.owner.kind === "paperclip"
    && receipt.owner.companyId === ctx.companyId
    && receipt.owner.agentId === ctx.agentId;
}

function safeRuntimeName(value: string): string {
  const name = value.trim();
  if (!RUNTIME_NAME_RE.test(name) || name.includes("..")) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_runtime_name_invalid",
      `Invalid Hermes runtime skill name ${JSON.stringify(value)}.`,
    );
  }
  return name;
}

function parseHermesSkillName(markdown: Buffer, sourceRoot: string): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(markdown).replace(/^\uFEFF/, "");
  } catch {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_markdown_invalid",
      `Managed skill SKILL.md is not valid UTF-8: ${sourceRoot}`,
    );
  }

  const lines = content.split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] ?? "")) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_markdown_invalid",
      `Managed skill SKILL.md must start with YAML frontmatter: ${sourceRoot}`,
    );
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line));
  if (closingIndex < 0 || closingIndex === lines.length - 1) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_markdown_invalid",
      `Managed skill SKILL.md has unclosed YAML frontmatter: ${sourceRoot}`,
    );
  }

  const nameValues: string[] = [];
  for (const line of lines.slice(1, closingIndex)) {
    if (/^\s/.test(line)) continue;
    const match = line.match(/^name\s*:\s*(.*?)\s*$/);
    if (match) nameValues.push(match[1] ?? "");
  }
  if (nameValues.length !== 1) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_name_invalid",
      `Managed skill SKILL.md must contain exactly one top-level name: ${sourceRoot}`,
    );
  }

  const scalar = nameValues[0]!.replace(/\s+#.*$/, "").trim();
  let skillName = scalar;
  const quoted = scalar.startsWith('"') || scalar.startsWith("'");
  if (scalar.startsWith('"') || scalar.endsWith('"')) {
    try {
      const parsed = JSON.parse(scalar) as unknown;
      skillName = typeof parsed === "string" ? parsed : "";
    } catch {
      skillName = "";
    }
  } else if (scalar.startsWith("'") || scalar.endsWith("'")) {
    skillName = scalar.startsWith("'") && scalar.endsWith("'")
      ? scalar.slice(1, -1).replace(/''/g, "'")
      : "";
  }
  if (!quoted && /^(?:null|~|true|false|yes|no|on|off|-?\d+(?:\.\d+)?)$/i.test(scalar)) skillName = "";
  if (!HERMES_SKILL_NAME_RE.test(skillName)) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_name_invalid",
      `Managed skill name ${JSON.stringify(skillName)} is not a valid Hermes skill name.`,
    );
  }
  return skillName;
}

async function collectBundleFiles(root: string): Promise<{ files: BridgeFile[]; skillName: string }> {
  const sourceRoot = path.resolve(root);
  const rootStat = await fs.lstat(sourceRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_source_invalid",
      `Managed skill source is not a regular directory: ${sourceRoot}`,
    );
  }

  const files: BridgeFile[] = [];
  let skillMarkdown: Buffer | null = null;
  let totalBytes = 0;
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_symlink_denied",
          `Managed skill bundles cannot contain symbolic links: ${entry.name}`,
        );
      }
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_source_invalid",
          `Managed skill bundles can contain only regular files: ${entry.name}`,
        );
      }
      const relative = path.relative(sourceRoot, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_path_invalid",
          "Managed skill file escaped its source directory.",
        );
      }
      const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
      if (!handle) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_source_changed",
          `Managed skill file changed while its bundle was being read: ${relative}`,
        );
      }
      let content: Buffer;
      let openedStat: Awaited<ReturnType<typeof handle.stat>>;
      try {
        openedStat = await handle.stat();
        if (!openedStat.isFile() || openedStat.size > MAX_FILE_BYTES) {
          throw new HermesGatewaySkillError(
            "hermes_gateway_skill_file_too_large",
            `Managed skill file ${relative} is not regular or exceeds ${MAX_FILE_BYTES} bytes.`,
          );
        }
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (content.byteLength !== openedStat.size) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_source_changed",
          `Managed skill file changed while its bundle was being read: ${relative}`,
        );
      }
      totalBytes += content.byteLength;
      if (files.length + 1 > MAX_BUNDLE_FILES || totalBytes > MAX_BUNDLE_BYTES) {
        throw new HermesGatewaySkillError(
          "hermes_gateway_skill_bundle_too_large",
          `Managed skill bundle exceeds ${MAX_BUNDLE_FILES} files or ${MAX_BUNDLE_BYTES} bytes.`,
        );
      }
      if (relative === "SKILL.md") skillMarkdown = content;
      const mode = openedStat.mode & 0o111 ? 0o755 : 0o644;
      files.push({
        path: relative,
        encoding: "base64",
        content: content.toString("base64"),
        size: content.byteLength,
        sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        mode,
      });
    }
  }
  await walk(sourceRoot);
  if (!skillMarkdown) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_markdown_missing",
      `Managed skill source is missing SKILL.md: ${sourceRoot}`,
    );
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { files, skillName: parseHermesSkillName(skillMarkdown, sourceRoot) };
}

function hashBundle(files: BridgeFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(file.mode), "utf8");
    hash.update("\0", "utf8");
    hash.update(String(file.size), "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function buildDesiredBundles(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Promise<Map<string, DesiredBundle>> {
  const available = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const availableByKey = new Map(available.map((entry) => [entry.key, entry]));
  const bundles = new Map<string, DesiredBundle>();
  for (const key of desiredSkills) {
    const entry = availableByKey.get(key);
    if (!entry || entry.sourceStatus === "missing") {
      throw new HermesGatewaySkillError(
        "hermes_gateway_desired_skill_missing",
        entry?.missingDetail ?? `Desired company skill ${JSON.stringify(key)} is unavailable.`,
      );
    }
    const runtimeName = safeRuntimeName(entry.runtimeName);
    if ([...bundles.values()].some((bundle) => bundle.runtimeName === runtimeName)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_runtime_name_conflict",
        `Multiple company skills resolve to Hermes runtime name ${JSON.stringify(runtimeName)}.`,
      );
    }
    const { files, skillName } = await collectBundleFiles(entry.source);
    if ([...bundles.values()].some((bundle) => bundle.skillName === skillName)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_name_conflict",
        `Multiple company skills declare Hermes skill name ${JSON.stringify(skillName)}.`,
      );
    }
    bundles.set(key, {
      key,
      runtimeName,
      skillName,
      versionId: entry.versionId ?? null,
      currentVersionId: entry.currentVersionId ?? null,
      source: entry.source,
      contentHash: hashBundle(files),
      files,
    });
  }
  return bundles;
}

async function putBundle(
  service: SkillServiceConfig,
  ctx: AdapterSkillContext,
  bundle: DesiredBundle,
): Promise<void> {
  const idempotencyHash = createHash("sha256")
    .update(`${service.profile}\0${ctx.companyId}\0${ctx.agentId}\0${bundle.runtimeName}\0${bundle.contentHash}`)
    .digest("hex");
  await requestJson(
    endpoint(
      service.bridgeBaseUrl,
      `/v1/skill-bundles/${encodeURIComponent(bundle.runtimeName)}`,
      { profile: service.profile },
    ),
    {
      method: "PUT",
      headers: {
        ...bridgeHeaders(service, true),
        "Idempotency-Key": `pc-skill-${idempotencyHash}`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        profile: service.profile,
        runtimeName: bundle.runtimeName,
        skillName: bundle.skillName,
        owner: {
          kind: "paperclip",
          companyId: ctx.companyId,
          agentId: ctx.agentId,
          skillKey: bundle.key,
        },
        versionId: bundle.versionId,
        currentVersionId: bundle.currentVersionId,
        contentHash: bundle.contentHash,
        files: bundle.files,
      }),
    },
    service.timeoutMs,
    [200, 201],
  );
}

async function deleteBundle(service: SkillServiceConfig, receipt: BridgeReceipt): Promise<void> {
  await requestJson(
    endpoint(
      service.bridgeBaseUrl,
      `/v1/skill-bundles/${encodeURIComponent(receipt.runtimeName)}`,
      {
        profile: service.profile,
        expectedContentHash: receipt.contentHash,
      },
    ),
    { method: "DELETE", headers: bridgeHeaders(service) },
    service.timeoutMs,
    [200, 204, 404],
  );
}

async function toggleHermesSkill(
  service: SkillServiceConfig,
  name: string,
  enabled: boolean,
): Promise<void> {
  await requestJson(
    endpoint(service.managementBaseUrl, "/api/skills/toggle"),
    {
      method: "PUT",
      headers: managementHeaders(service, true),
      body: JSON.stringify({ name, enabled, profile: service.profile }),
    },
    service.timeoutMs,
  );
}

function originLabel(provenance: string | null): string {
  if (provenance === "hub") return "Hermes hub skill";
  if (provenance === "bundled") return "Hermes bundled skill";
  if (provenance === "agent") return "Hermes agent-created skill";
  return "Hermes-native skill";
}

async function buildSnapshot(input: {
  ctx: AdapterSkillContext;
  hermesSkills: HermesSkill[];
  receipts: BridgeReceipt[];
  warnings?: string[];
  bundles?: Map<string, DesiredBundle>;
}): Promise<AdapterSkillSnapshot> {
  const { ctx, hermesSkills, receipts } = input;
  const available = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(ctx.config, available);
  const desiredSet = new Set(desiredSkills);
  const hermesByName = new Map(hermesSkills.map((skill) => [skill.name, skill]));
  const receiptByRuntimeName = new Map(receipts.map((receipt) => [receipt.runtimeName, receipt]));
  const receiptBySkillName = new Map(receipts.map((receipt) => [receipt.skillName, receipt]));
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(input.warnings ?? [])];
  let bundles = input.bundles;
  if (!bundles) {
    try {
      bundles = await buildDesiredBundles(ctx.config, desiredSkills);
    } catch (error) {
      bundles = new Map();
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const availableEntry of available) {
    const desired = desiredSet.has(availableEntry.key);
    const runtimeName = availableEntry.runtimeName;
    const desiredBundle = bundles.get(availableEntry.key) ?? null;
    const receipt = receiptByRuntimeName.get(runtimeName) ?? null;
    const desiredSkillName = desiredBundle?.skillName ?? receipt?.skillName ?? runtimeName;
    const owned = Boolean(receipt && ownsReceipt(receipt, ctx));
    const observedSkillName = owned ? receipt!.skillName : desiredSkillName;
    const remote = hermesByName.get(observedSkillName) ?? null;
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let readOnly = false;
    let detail: string | null = null;

    if (availableEntry.sourceStatus === "missing") {
      state = "missing";
      detail = availableEntry.missingDetail ?? "Paperclip cannot materialize this company skill.";
    } else if (remote && !owned) {
      state = "external";
      readOnly = true;
      detail = `A Hermes-owned skill already uses skill name ${JSON.stringify(desiredSkillName)}; Paperclip will not overwrite it.`;
    } else if (owned && desired) {
      managed = true;
      if (
        !remote
        || !remote.enabled
        || !desiredBundle
        || receipt?.skillName !== desiredBundle.skillName
        || receipt?.contentHash !== desiredBundle.contentHash
        || receipt?.state !== "in_sync"
      ) {
        state = "stale";
        detail = !remote
          ? "Paperclip has a bridge receipt, but Hermes does not report the installed skill."
          : !remote.enabled
            ? "The Paperclip-managed skill is disabled in Hermes."
            : receipt?.state === "drifted"
              ? "The Paperclip-managed skill directory has drifted from its signed bundle receipt."
              : "The installed Paperclip-managed bundle differs from the desired version.";
      } else {
        state = "installed";
        detail = "Installed in the Hermes profile and verified by bundle hash.";
      }
    } else if (owned) {
      managed = true;
      state = "stale";
      detail = "Paperclip installed this skill previously, but it is no longer assigned.";
    } else if (desired) {
      state = "missing";
      detail = "Assigned in Paperclip but not installed in the Hermes profile.";
    }

    entries.push({
      key: availableEntry.key,
      runtimeName,
      versionId: availableEntry.versionId ?? null,
      currentVersionId: availableEntry.currentVersionId ?? null,
      desired,
      managed,
      state,
      origin: readOnly ? "external_unknown" : "company_managed",
      originLabel: readOnly ? originLabel(remote?.provenance ?? null) : "Managed by Paperclip",
      readOnly,
      sourcePath: availableEntry.sourceStatus === "missing" ? null : availableEntry.source,
      targetPath: null,
      detail,
    });
  }

  const representedSkillNames = new Set(available.map((entry) => {
    const receipt = receiptByRuntimeName.get(entry.runtimeName);
    return receipt && ownsReceipt(receipt, ctx)
      ? receipt.skillName
      : bundles.get(entry.key)?.skillName ?? receipt?.skillName ?? entry.runtimeName;
  }));
  for (const remote of hermesSkills) {
    if (representedSkillNames.has(remote.name)) continue;
    const receipt = receiptBySkillName.get(remote.name) ?? null;
    const owned = Boolean(receipt && ownsReceipt(receipt, ctx));
    entries.push({
      key: owned ? receipt!.owner.skillKey : remote.name,
      runtimeName: receipt?.runtimeName ?? remote.name,
      versionId: receipt?.versionId ?? null,
      currentVersionId: receipt?.currentVersionId ?? null,
      desired: false,
      managed: owned,
      state: owned ? "stale" : "external",
      origin: owned ? "company_managed" : "user_installed",
      originLabel: owned ? "Managed by Paperclip" : originLabel(remote.provenance),
      readOnly: !owned,
      sourcePath: null,
      targetPath: null,
      detail: owned
        ? "Paperclip installed this skill previously, but its library entry or assignment is absent."
        : [remote.description, remote.enabled ? null : "Disabled in Hermes."].filter(Boolean).join(" ") || null,
    });
  }

  for (const desired of desiredSkills) {
    if (available.some((entry) => entry.key === desired)) continue;
    warnings.push(`Desired skill ${JSON.stringify(desired)} is unavailable from the Paperclip company library.`);
    entries.push({
      key: desired,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot resolve the assigned company skill.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));
  const availableByKey = new Map(available.map((entry) => [entry.key, entry]));
  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    mode: "persistent",
    desiredSkills,
    desiredSkillEntries: desiredSkills.map((key) => ({
      key,
      versionId: availableByKey.get(key)?.versionId ?? null,
    })),
    entries,
    warnings,
  };
}

export async function listGatewaySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  let service: SkillServiceConfig | null;
  try {
    service = resolveSkillServiceConfig(ctx.config);
  } catch (error) {
    return buildSnapshot({
      ctx,
      hermesSkills: [],
      receipts: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    });
  }
  if (!service) {
    return buildSnapshot({
      ctx,
      hermesSkills: [],
      receipts: [],
      warnings: [
        "Hermes skill management is not configured. Set managementBaseUrl, managementCredential, skillBridgeBaseUrl, and skillBridgeCredential.",
      ],
    });
  }

  try {
    const [hermesSkills, receipts] = await Promise.all([
      fetchHermesSkills(service),
      fetchBridgeReceipts(service),
    ]);
    return buildSnapshot({ ctx, hermesSkills, receipts });
  } catch (error) {
    return buildSnapshot({
      ctx,
      hermesSkills: [],
      receipts: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export async function syncGatewaySkills(
  ctx: AdapterSkillContext,
  requestedDesiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const available = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  const configuredDesiredSkills = resolvePaperclipDesiredSkillNames(ctx.config, available);
  const desiredSkills = Array.from(new Set(requestedDesiredSkills.map((value) => value.trim()).filter(Boolean)));
  if (
    desiredSkills.length !== configuredDesiredSkills.length
    || desiredSkills.some((value) => !configuredDesiredSkills.includes(value))
  ) {
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_desired_state_mismatch",
      "Requested Hermes skill sync does not match the desired state stored in Paperclip.",
    );
  }

  const service = resolveSkillServiceConfig(ctx.config);
  if (!service) {
    if (desiredSkills.length === 0) return listGatewaySkills(ctx);
    throw new HermesGatewaySkillError(
      "hermes_gateway_skill_management_unconfigured",
      "Assigned Hermes Gateway skills require the dashboard management and Northern Logic skill bridge connections.",
    );
  }

  const bundles = await buildDesiredBundles(ctx.config, desiredSkills);
  const [beforeHermes, beforeReceipts] = await Promise.all([
    fetchHermesSkills(service),
    fetchBridgeReceipts(service),
  ]);
  const beforeHermesByName = new Map(beforeHermes.map((skill) => [skill.name, skill]));
  const beforeReceiptByRuntimeName = new Map(beforeReceipts.map((receipt) => [receipt.runtimeName, receipt]));
  const beforeReceiptBySkillName = new Map(beforeReceipts.map((receipt) => [receipt.skillName, receipt]));

  for (const bundle of bundles.values()) {
    const remote = beforeHermesByName.get(bundle.skillName) ?? null;
    const receipt = beforeReceiptByRuntimeName.get(bundle.runtimeName) ?? null;
    const skillNameReceipt = beforeReceiptBySkillName.get(bundle.skillName) ?? null;
    if (receipt && !ownsReceipt(receipt, ctx)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_external_conflict",
        `Hermes runtime skill ${JSON.stringify(bundle.runtimeName)} is owned by a different Paperclip agent and will not be overwritten.`,
      );
    }
    if (skillNameReceipt && skillNameReceipt.runtimeName !== bundle.runtimeName) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_external_conflict",
        `Hermes skill name ${JSON.stringify(bundle.skillName)} is already mapped to a different managed runtime bundle.`,
      );
    }
    if (remote && (!receipt || !ownsReceipt(receipt, ctx) || receipt.skillName !== bundle.skillName)) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_external_conflict",
        `Hermes skill ${JSON.stringify(bundle.skillName)} is not owned by this Paperclip agent and will not be overwritten.`,
      );
    }
    if (
      !remote
      || !receipt
      || !ownsReceipt(receipt, ctx)
      || receipt.skillName !== bundle.skillName
      || receipt.contentHash !== bundle.contentHash
      || receipt.state !== "in_sync"
      || receipt.owner.skillKey !== bundle.key
      || receipt.versionId !== bundle.versionId
      || receipt.currentVersionId !== bundle.currentVersionId
    ) {
      await putBundle(service, ctx, bundle);
    }
    await toggleHermesSkill(service, bundle.skillName, true);
  }

  const desiredRuntimeNames = new Set([...bundles.values()].map((bundle) => bundle.runtimeName));
  for (const receipt of beforeReceipts) {
    if (!ownsReceipt(receipt, ctx) || desiredRuntimeNames.has(receipt.runtimeName)) continue;
    if (beforeHermesByName.has(receipt.skillName)) {
      await toggleHermesSkill(service, receipt.skillName, false);
    }
    await deleteBundle(service, receipt);
  }

  const [observedHermes, observedReceipts] = await Promise.all([
    fetchHermesSkills(service),
    fetchBridgeReceipts(service),
  ]);
  const observedHermesByName = new Map(observedHermes.map((skill) => [skill.name, skill]));
  const observedReceiptByRuntimeName = new Map(observedReceipts.map((receipt) => [receipt.runtimeName, receipt]));
  for (const bundle of bundles.values()) {
    const remote = observedHermesByName.get(bundle.skillName);
    const receipt = observedReceiptByRuntimeName.get(bundle.runtimeName);
    if (
      !remote
      || !remote.enabled
      || !receipt
      || !ownsReceipt(receipt, ctx)
      || receipt.skillName !== bundle.skillName
      || receipt.owner.skillKey !== bundle.key
      || receipt.contentHash !== bundle.contentHash
      || receipt.state !== "in_sync"
      || receipt.versionId !== bundle.versionId
      || receipt.currentVersionId !== bundle.currentVersionId
    ) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_not_observed",
        `Hermes did not report assigned skill ${JSON.stringify(bundle.key)} at the requested bundle hash.`,
      );
    }
  }
  for (const receipt of beforeReceipts) {
    if (
      ownsReceipt(receipt, ctx)
      && !desiredRuntimeNames.has(receipt.runtimeName)
      && observedReceiptByRuntimeName.has(receipt.runtimeName)
    ) {
      throw new HermesGatewaySkillError(
        "hermes_gateway_skill_cleanup_not_observed",
        `Northern Logic skill bridge still reports removed skill ${JSON.stringify(receipt.owner.skillKey)}.`,
      );
    }
  }

  return buildSnapshot({
    ctx,
    hermesSkills: observedHermes,
    receipts: observedReceipts,
    bundles,
  });
}

export async function ensureGatewaySkillsReady(ctx: AdapterSkillContext): Promise<void> {
  const available = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(ctx.config, available);
  if (desiredSkills.length === 0 && !configuredSkillFields(ctx.config)) return;
  await syncGatewaySkills(ctx, desiredSkills);
}

export async function testGatewaySkillServices(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck[]> {
  if (!configuredSkillFields(config)) return [];
  let service: SkillServiceConfig;
  try {
    const resolved = resolveSkillServiceConfig(config);
    if (!resolved) return [];
    service = resolved;
  } catch (error) {
    return [{
      code: error instanceof HermesGatewaySkillError
        ? error.code
        : "hermes_gateway_skill_management_config_invalid",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    }];
  }

  const checks: AdapterEnvironmentCheck[] = [];
  try {
    await fetchHermesSkills(service);
    checks.push({
      code: "hermes_gateway_skill_management_ok",
      level: "info",
      message: `Hermes dashboard skill inventory is reachable for profile ${service.profile}.`,
    });
  } catch (error) {
    checks.push({
      code: error instanceof HermesGatewaySkillError ? error.code : "hermes_gateway_skill_management_failed",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await fetchBridgeReceipts(service);
    checks.push({
      code: "hermes_gateway_skill_bridge_ok",
      level: "info",
      message: `Northern Logic skill bridge contract v1 is reachable for profile ${service.profile}.`,
    });
  } catch (error) {
    checks.push({
      code: error instanceof HermesGatewaySkillError ? error.code : "hermes_gateway_skill_bridge_failed",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return checks;
}
