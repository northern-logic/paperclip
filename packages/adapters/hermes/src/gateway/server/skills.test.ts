import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ensureGatewaySkillsReady,
  listGatewaySkills,
  syncGatewaySkills,
  testGatewaySkillServices,
} from "./skills.js";

interface Receipt {
  runtimeName: string;
  skillName: string;
  profile: string;
  versionId: string | null;
  currentVersionId: string | null;
  contentHash: string;
  state: "in_sync" | "drifted";
  owner: {
    kind: "paperclip";
    companyId: string;
    agentId: string;
    skillKey: string;
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createSkillSource(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-gateway-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: marketing\ndescription: Marketing operations\n---\nUse the supporting script.\n",
  );
  await fs.writeFile(path.join(root, "scripts", "run.sh"), "#!/bin/sh\necho marketing\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "assets", "logo.bin"), Buffer.from([0, 1, 2, 255]));
  return root;
}

function context(source: string, desiredSkills = ["marketing"]): AdapterSkillContext {
  return {
    adapterType: "hermes_gateway",
    companyId: "22222222-2222-4222-8222-222222222222",
    agentId: "11111111-1111-4111-8111-111111111111",
    config: {
      profile: "default",
      managementBaseUrl: "https://management.test",
      managementCredential: "dashboard-secret",
      skillBridgeBaseUrl: "https://bridge.test",
      skillBridgeCredential: "bridge-secret",
      paperclipSkillSync: { desiredSkills },
      paperclipRuntimeSkills: [{
        key: "marketing",
        runtimeName: "marketing--7b77c37595",
        source,
        versionId: "version-1",
        currentVersionId: "version-1",
      }],
    },
  };
}

function mockServices(input: {
  hermes?: Array<Record<string, unknown>>;
  receipts?: Receipt[];
  preserveDeletedReceipts?: boolean;
} = {}) {
  const hermes = input.hermes ?? [{
    name: "native-research",
    description: "Created by Hermes",
    category: "research",
    enabled: true,
    provenance: "agent",
  }];
  const receipts = input.receipts ?? [];
  const requests: Array<{ url: URL; method: string; body: Record<string, unknown> | null }> = [];

  vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof rawUrl === "string" || rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (url.hostname === "management.test" && url.pathname === "/api/skills" && method === "GET") {
      expect(init?.headers).toMatchObject({ "X-Hermes-Session-Token": "dashboard-secret" });
      return Response.json(hermes);
    }
    if (url.hostname === "management.test" && url.pathname === "/api/skills/toggle" && method === "PUT") {
      expect(url.searchParams.get("profile")).toBeNull();
      const name = String(body?.name ?? "");
      const enabled = body?.enabled === true;
      const existing = hermes.find((entry) => entry.name === name);
      if (existing) existing.enabled = enabled;
      return Response.json({ ok: true, name, enabled });
    }
    if (url.hostname === "bridge.test" && url.pathname === "/v1/skill-bundles" && method === "GET") {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bridge-secret" });
      return Response.json({ schemaVersion: 1, skills: receipts });
    }
    if (url.hostname === "bridge.test" && url.pathname.startsWith("/v1/skill-bundles/") && method === "PUT") {
      const runtimeName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const owner = body?.owner as Receipt["owner"];
      const next: Receipt = {
        runtimeName,
        skillName: String(body?.skillName ?? ""),
        profile: String(body?.profile ?? ""),
        versionId: typeof body?.versionId === "string" ? body.versionId : null,
        currentVersionId: typeof body?.currentVersionId === "string" ? body.currentVersionId : null,
        contentHash: String(body?.contentHash ?? ""),
        state: "in_sync",
        owner,
      };
      const existingIndex = receipts.findIndex((receipt) => receipt.runtimeName === runtimeName);
      if (existingIndex >= 0) receipts[existingIndex] = next;
      else receipts.push(next);
      if (!hermes.some((entry) => entry.name === next.skillName)) {
        hermes.push({ name: next.skillName, enabled: true, provenance: "agent" });
      }
      return Response.json({ ok: true, receipt: next }, { status: 201 });
    }
    if (url.hostname === "bridge.test" && url.pathname.startsWith("/v1/skill-bundles/") && method === "DELETE") {
      const runtimeName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const index = receipts.findIndex((receipt) => receipt.runtimeName === runtimeName);
      const skillName = index >= 0 ? receipts[index]!.skillName : runtimeName;
      if (index >= 0 && !input.preserveDeletedReceipts) receipts.splice(index, 1);
      const hermesIndex = hermes.findIndex((entry) => entry.name === skillName);
      if (hermesIndex >= 0) hermes.splice(hermesIndex, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url.toString()}`);
  }));

  return { hermes, receipts, requests };
}

describe("Hermes Gateway skill synchronization", () => {
  test("installs and verifies a complete multi-file Paperclip bundle", async () => {
    const source = await createSkillSource();
    const services = mockServices();
    const ctx = context(source);

    const snapshot = await syncGatewaySkills(ctx, ["marketing"]);

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("persistent");
    expect(snapshot.entries.find((entry) => entry.key === "marketing")).toMatchObject({
      runtimeName: "marketing--7b77c37595",
      state: "installed",
      managed: true,
      desired: true,
      readOnly: false,
    });
    expect(snapshot.entries.find((entry) => entry.key === "native-research")).toMatchObject({
      state: "external",
      managed: false,
      readOnly: true,
      originLabel: "Hermes agent-created skill",
    });

    const put = services.requests.find((request) => request.method === "PUT" && request.url.hostname === "bridge.test");
    expect(put?.body).toMatchObject({
      schemaVersion: 1,
      profile: "default",
      runtimeName: "marketing--7b77c37595",
      skillName: "marketing",
      owner: {
        kind: "paperclip",
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        skillKey: "marketing",
      },
    });
    const files = put?.body?.files as Array<Record<string, unknown>>;
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "assets/logo.bin", "scripts/run.sh"]);
    expect(files.find((file) => file.path === "assets/logo.bin")?.content).toBe("AAEC/w==");
    expect(files.find((file) => file.path === "scripts/run.sh")?.mode).toBe(0o755);
    expect(services.requests.find((request) =>
      request.url.pathname === "/api/skills/toggle" && request.method === "PUT"
    )?.body).toMatchObject({ name: "marketing", enabled: true });
  });

  test("repairs a managed bundle when the bridge reports filesystem drift", async () => {
    const source = await createSkillSource();
    const services = mockServices();
    const ctx = context(source);
    await syncGatewaySkills(ctx, ["marketing"]);
    services.receipts[0]!.state = "drifted";

    await syncGatewaySkills(ctx, ["marketing"]);

    expect(services.requests.filter((request) =>
      request.url.hostname === "bridge.test" && request.method === "PUT"
    )).toHaveLength(2);
    expect(services.receipts[0]?.state).toBe("in_sync");
  });

  test("removes only stale bundles owned by the same Paperclip agent", async () => {
    const source = await createSkillSource();
    const ctx = context(source);
    const ownedOrphan: Receipt = {
      runtimeName: "old-owned",
      skillName: "old-owned",
      profile: "default",
      versionId: null,
      currentVersionId: null,
      contentHash: `sha256:${"a".repeat(64)}`,
      state: "in_sync",
      owner: { kind: "paperclip", companyId: ctx.companyId, agentId: ctx.agentId, skillKey: "old-owned" },
    };
    const foreign: Receipt = {
      runtimeName: "foreign-owned",
      skillName: "foreign-owned",
      profile: "default",
      versionId: null,
      currentVersionId: null,
      contentHash: `sha256:${"b".repeat(64)}`,
      state: "in_sync",
      owner: {
        kind: "paperclip",
        companyId: ctx.companyId,
        agentId: "33333333-3333-4333-8333-333333333333",
        skillKey: "foreign-owned",
      },
    };
    const services = mockServices({
      hermes: [
        { name: "old-owned", enabled: true, provenance: "agent" },
        { name: "foreign-owned", enabled: true, provenance: "agent" },
      ],
      receipts: [ownedOrphan, foreign],
    });

    await syncGatewaySkills(ctx, ["marketing"]);

    const deletes = services.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => decodeURIComponent(request.url.pathname.split("/").pop() ?? ""));
    expect(deletes).toEqual(["old-owned"]);
    expect(services.receipts.some((receipt) => receipt.runtimeName === "foreign-owned")).toBe(true);
  });

  test("fails closed when the bridge does not confirm owned-bundle cleanup", async () => {
    const source = await createSkillSource();
    const ctx = context(source);
    const services = mockServices({
      hermes: [{ name: "old-owned", enabled: true, provenance: "agent" }],
      receipts: [{
        runtimeName: "old-owned",
        skillName: "old-owned",
        profile: "default",
        versionId: null,
        currentVersionId: null,
        contentHash: `sha256:${"a".repeat(64)}`,
        state: "in_sync",
        owner: { kind: "paperclip", companyId: ctx.companyId, agentId: ctx.agentId, skillKey: "old-owned" },
      }],
      preserveDeletedReceipts: true,
    });

    await expect(syncGatewaySkills(ctx, ["marketing"]))
      .rejects.toMatchObject({ code: "hermes_gateway_skill_cleanup_not_observed" });
    expect(services.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  test("run preflight cleans stale owned receipts after the desired set becomes empty", async () => {
    const source = await createSkillSource();
    const ctx = context(source, []);
    const services = mockServices({
      hermes: [{ name: "old-owned", enabled: true, provenance: "agent" }],
      receipts: [{
        runtimeName: "old-owned--40e876eeb5",
        skillName: "old-owned",
        profile: "default",
        versionId: null,
        currentVersionId: null,
        contentHash: `sha256:${"a".repeat(64)}`,
        state: "in_sync",
        owner: { kind: "paperclip", companyId: ctx.companyId, agentId: ctx.agentId, skillKey: "old-owned" },
      }],
    });

    await ensureGatewaySkillsReady(ctx);

    expect(services.requests.some((request) => request.method === "DELETE")).toBe(true);
    expect(services.receipts).toHaveLength(0);
  });

  test("rejects receipts for a different Hermes profile", async () => {
    const source = await createSkillSource();
    const ctx = context(source);
    mockServices({
      receipts: [{
        runtimeName: "marketing--7b77c37595",
        skillName: "marketing",
        profile: "other-profile",
        versionId: "version-1",
        currentVersionId: "version-1",
        contentHash: `sha256:${"a".repeat(64)}`,
        state: "in_sync",
        owner: { kind: "paperclip", companyId: ctx.companyId, agentId: ctx.agentId, skillKey: "marketing" },
      }],
    });

    await expect(syncGatewaySkills(ctx, ["marketing"]))
      .rejects.toMatchObject({ code: "hermes_gateway_skill_bridge_protocol_error" });
  });

  test("fails closed instead of overwriting a Hermes-owned name collision", async () => {
    const source = await createSkillSource();
    const services = mockServices({
      hermes: [{ name: "marketing", enabled: true, provenance: "hub" }],
    });

    await expect(syncGatewaySkills(context(source), ["marketing"]))
      .rejects.toMatchObject({ code: "hermes_gateway_skill_external_conflict" });
    expect(services.requests.some((request) => request.url.hostname === "bridge.test" && request.method === "PUT"))
      .toBe(false);
  });

  test("fails closed on a foreign bridge receipt even when Hermes inventory is empty", async () => {
    const source = await createSkillSource();
    const ctx = context(source);
    const services = mockServices({
      hermes: [],
      receipts: [{
        runtimeName: "marketing--7b77c37595",
        skillName: "marketing",
        profile: "default",
        versionId: "version-1",
        currentVersionId: "version-1",
        contentHash: `sha256:${"a".repeat(64)}`,
        state: "in_sync",
        owner: {
          kind: "paperclip",
          companyId: ctx.companyId,
          agentId: "33333333-3333-4333-8333-333333333333",
          skillKey: "marketing",
        },
      }],
    });

    await expect(syncGatewaySkills(ctx, ["marketing"]))
      .rejects.toMatchObject({ code: "hermes_gateway_skill_external_conflict" });
    expect(services.requests.some((request) => request.url.hostname === "bridge.test" && request.method === "PUT"))
      .toBe(false);
  });

  test("rejects a skill name that stock Hermes cannot address", async () => {
    const source = await createSkillSource();
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: Marketing Team\ndescription: invalid name\n---\nDo work.\n",
    );
    const services = mockServices();

    await expect(syncGatewaySkills(context(source), ["marketing"]))
      .rejects.toMatchObject({ code: "hermes_gateway_skill_name_invalid" });
    expect(services.requests).toHaveLength(0);
  });

  test("shows Hermes-native skills as read-only observed state", async () => {
    const source = await createSkillSource();
    mockServices();

    const snapshot = await listGatewaySkills(context(source, []));

    expect(snapshot.entries.find((entry) => entry.key === "native-research")).toMatchObject({
      desired: false,
      managed: false,
      state: "external",
      readOnly: true,
    });
  });

  test("requires both private management connections when a skill is assigned", async () => {
    const source = await createSkillSource();
    const ctx = context(source);
    delete ctx.config.skillBridgeCredential;

    await expect(syncGatewaySkills(ctx, ["marketing"]))
      .rejects.toMatchObject({
        code: "hermes_gateway_skill_management_config_incomplete",
      });
  });

  test("environment checks validate dashboard and bridge capability together", async () => {
    const source = await createSkillSource();
    mockServices();

    const checks = await testGatewaySkillServices(context(source).config);

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hermes_gateway_skill_management_ok", level: "info" }),
      expect.objectContaining({ code: "hermes_gateway_skill_bridge_ok", level: "info" }),
    ]));
  });
});
