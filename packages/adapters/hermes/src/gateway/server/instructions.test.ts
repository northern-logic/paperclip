import type { AdapterInstructionsContext } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  deleteGatewayInstructionsFile,
  getGatewayInstructionsBundle,
  loadGatewayEntryInstructions,
  readGatewayInstructionsFile,
  testGatewayInstructionsService,
  writeGatewayInstructionsFile,
} from "./instructions.js";

function context(overrides: Record<string, unknown> = {}): AdapterInstructionsContext {
  return {
    adapterType: "hermes_gateway",
    companyId: "22222222-2222-4222-8222-222222222222",
    agentId: "11111111-1111-4111-8111-111111111111",
    config: {
      profile: "marketing",
      skillBridgeBaseUrl: "https://bridge.test/private",
      skillBridgeCredential: "bridge-secret",
      ...overrides,
    },
  };
}

const hash = `sha256:${"a".repeat(64)}`;

function hashFor(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hermes Gateway remote instruction files", () => {
  test("lists and reads the allowlisted profile files", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof raw === "string" || raw instanceof URL ? raw.toString() : raw.url);
      requests.push({ url, init });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bridge-secret" });
      if (url.pathname === "/private/v1/instructions") {
        return Response.json({
          schemaVersion: 1,
          profile: "marketing",
          entryFile: "AGENTS.md",
          files: [
            { path: "AGENTS.md", size: 7, sha256: hash, updatedAt: "2026-08-08T00:00:00Z" },
            { path: "SOUL.md", size: 6, sha256: hash, updatedAt: "2026-08-08T00:00:00Z" },
          ],
        });
      }
      return Response.json({
        schemaVersion: 1,
        profile: "marketing",
        path: "AGENTS.md",
        size: 7,
        sha256: hashFor("# Role\n"),
        updatedAt: "2026-08-08T00:00:00Z",
        content: "# Role\n",
      });
    }));

    const bundle = await getGatewayInstructionsBundle(context());
    expect(bundle).toMatchObject({
      mode: "remote",
      entryFile: "AGENTS.md",
      editable: true,
      files: [
        { path: "AGENTS.md", isEntryFile: true, markdown: true },
        { path: "SOUL.md", isEntryFile: false, markdown: true },
      ],
    });
    const file = await readGatewayInstructionsFile(context(), "AGENTS.md");
    expect(file.content).toBe("# Role\n");
    expect(requests.every(({ url }) => url.searchParams.get("profile") === "marketing")).toBe(true);
  });

  test("creates, updates, and deletes remote files with the fixed contract", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof raw === "string" || raw instanceof URL ? raw.toString() : raw.url);
      const method = init?.method ?? "GET";
      methods.push(`${method} ${url.pathname}`);
      if (method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({
          schemaVersion: 1,
          profile: "marketing",
          content: "# Tools\n",
        });
        return Response.json({
          schemaVersion: 1,
          profile: "marketing",
          path: "TOOLS.md",
          size: 8,
          sha256: hashFor("# Tools\n"),
          content: "# Tools\n",
        }, { status: 201 });
      }
      if (method === "DELETE") {
        return Response.json({ schemaVersion: 1, profile: "marketing", path: "TOOLS.md", deleted: true });
      }
      return Response.json({
        schemaVersion: 1,
        profile: "marketing",
        entryFile: "AGENTS.md",
        files: [],
      });
    }));

    const written = await writeGatewayInstructionsFile(context(), "TOOLS.md", "# Tools\n");
    expect(written.content).toBe("# Tools\n");
    const bundle = await deleteGatewayInstructionsFile(context(), "TOOLS.md");
    expect(bundle.files).toEqual([]);
    expect(methods).toEqual([
      "PUT /private/v1/instructions/TOOLS.md",
      "DELETE /private/v1/instructions/TOOLS.md",
      "GET /private/v1/instructions",
    ]);
  });

  test("uses remote AGENTS.md as stable run instructions and tolerates a missing entry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        profile: "marketing",
        path: "AGENTS.md",
        size: 7,
        sha256: hashFor("# Role\n"),
        content: "# Role\n",
      }))
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        error: "instruction_file_not_found",
        message: "missing",
      }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadGatewayEntryInstructions(context().config)).resolves.toBe("# Role\n");
    await expect(loadGatewayEntryInstructions(context().config)).resolves.toBeNull();
  });

  test("rejects arbitrary paths and unsafe remote HTTP", async () => {
    await expect(readGatewayInstructionsFile(context(), "config.yaml")).rejects.toMatchObject({
      code: "hermes_gateway_instruction_file_invalid",
      status: 422,
    });
    await expect(getGatewayInstructionsBundle(context({
      skillBridgeBaseUrl: "http://bridge.example.test",
    }))).rejects.toMatchObject({
      code: "hermes_gateway_plain_http_remote_denied",
    });
  });

  test("advertises instruction management only when the bridge contract is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      schemaVersion: 1,
      profile: "marketing",
      entryFile: "AGENTS.md",
      files: [],
    })));

    await expect(testGatewayInstructionsService(context().config)).resolves.toEqual([
      expect.objectContaining({
        code: "hermes_gateway_instruction_management_ok",
        level: "info",
      }),
    ]);
    await expect(testGatewayInstructionsService({})).resolves.toEqual([]);
  });
});
