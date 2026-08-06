# Hermes Gateway Skills

This document defines Northern Logic's version 1 skill-management contract for
the built-in `hermes_gateway` adapter. It extends the gateway adapter without
changing or forking Hermes.

## Authority and ownership

- Paperclip is the desired-state authority for the company library, selected
  versions, agent assignments, and Paperclip-owned bundles.
- Stock Hermes is the observed runtime authority for profile inventory,
  enablement, and execution.
- Hermes hub, bundled, hand-made, and agent-created skills are observed as
  read-only. Paperclip never claims, overwrites, or deletes them.
- A bridge receipt is the only proof that Paperclip owns an installed runtime
  directory. Cleanup requires an exact company and agent owner match.

Every agent names its Hermes profile explicitly. `default` is the default
value, but it is still sent on every management and bridge operation.
For a stock multiplexed Hermes gateway, the same agent's run URL must select
that profile (`/p/<profile>` for a non-default profile). Skill reconciliation
cannot compensate for a run URL that targets a different profile.

## Connections

The adapter uses three independent private connections:

| Purpose | Configuration | Authentication |
|---|---|---|
| Agent runs | `apiBaseUrl`, `apiKey` | `Authorization: Bearer <API_SERVER_KEY>` |
| Stock Hermes management | `managementBaseUrl`, `managementCredential` | `X-Hermes-Session-Token` |
| Complete bundle transport | `skillBridgeBaseUrl`, `skillBridgeCredential` | `Authorization: Bearer` |

The management and bridge URLs may use loopback HTTP through a private tunnel.
Non-loopback plain HTTP is denied unless the existing development-only unsafe
transport override is set. Credentials are adapter secret fields and must not
be exposed to the browser or included in run prompts.

For unattended loopback management, start the stock dashboard with a stable
`HERMES_DASHBOARD_SESSION_TOKEN`. Paperclip uses only these stock routes:

- `GET /api/skills?profile=<profile>`
- `PUT /api/skills/toggle` with `{ "name", "enabled", "profile" }`

## Bundle bridge contract v1

The bridge is a small Northern Logic service installed beside stock Hermes. It
does not patch or import Hermes internals. It validates and atomically writes a
complete directory into the requested profile's skills root, then records a
receipt in bridge-owned state.

### Inventory

```http
GET /v1/skill-bundles?profile=default
Authorization: Bearer <bridge credential>
Accept: application/json
```

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "runtimeName": "marketing--7b77c37595",
      "skillName": "marketing",
      "profile": "default",
      "versionId": "skill-version-id-or-null",
      "currentVersionId": "current-version-id-or-null",
      "contentHash": "sha256:<64 lowercase hex characters>",
      "state": "in_sync",
      "owner": {
        "kind": "paperclip",
        "companyId": "company-id",
        "agentId": "agent-id",
        "skillKey": "company-skill-key"
      }
    }
  ]
}
```

Unknown contract versions, malformed receipts, duplicates, and oversized
responses fail closed.

### Atomic install or update

```http
PUT /v1/skill-bundles/marketing--7b77c37595?profile=default
Authorization: Bearer <bridge credential>
Content-Type: application/json
Idempotency-Key: pc-skill-<sha256>
```

```json
{
  "schemaVersion": 1,
  "profile": "default",
  "runtimeName": "marketing--7b77c37595",
  "skillName": "marketing",
  "owner": {
    "kind": "paperclip",
    "companyId": "company-id",
    "agentId": "agent-id",
    "skillKey": "company-skill-key"
  },
  "versionId": "skill-version-id-or-null",
  "currentVersionId": "current-version-id-or-null",
  "contentHash": "sha256:<bundle-manifest-hash>",
  "files": [
    {
      "path": "SKILL.md",
      "encoding": "base64",
      "content": "LS0tLi4u",
      "size": 123,
      "sha256": "sha256:<file-hash>",
      "mode": 420
    }
  ]
}
```

The bridge must validate the profile, runtime name, and Hermes skill name. The
declared `skillName` must exactly match the root `SKILL.md` YAML frontmatter
name. It must reject duplicate skill names within a profile, absolute paths,
traversal, symlinks, special files, duplicate paths, size-limit violations,
hash mismatches, and ownership conflicts. It writes to a temporary sibling,
fsyncs as appropriate, atomically swaps the directory, and commits its receipt
only after installation succeeds. Replaying the same bundle is idempotent and
returns the existing verified receipt.

Success is HTTP `200` or `201`. Paperclip does not trust the acknowledgement
alone; it re-reads both bridge receipts and stock Hermes inventory.

### Guarded removal

```http
DELETE /v1/skill-bundles/marketing--7b77c37595?profile=default&expectedContentHash=sha256%3A...
Authorization: Bearer <bridge credential>
Accept: application/json
```

There is no request body. The bridge removes a directory only when:

1. a receipt exists for the profile and runtime name;
2. its owner is Paperclip;
3. its stored hash exactly equals `expectedContentHash`.

An ownership or hash mismatch returns `409` or `412` and leaves everything
unchanged. Successful removal returns `200` or `204`; a missing receipt may
return `404` and is treated as an idempotent success.

## Reconciliation

For every sync, Paperclip:

1. Resolves the exact assigned company-skill versions and materializes their
   complete directories.
2. Creates a deterministic manifest containing every regular file, file mode,
   byte length, and SHA-256 hash.
3. Reads stock Hermes inventory and bridge receipts for the profile.
4. Refuses either a runtime-directory collision or a Hermes skill-name
   collision unless the receipt proves the same company and agent owns it.
5. Uploads missing or stale Paperclip-owned bundles and enables them through
   the stock dashboard API.
6. Disables and removes only no-longer-desired receipts owned by that exact
   company and agent.
7. Re-reads both services and verifies every assigned skill is present,
   enabled, owned, at the requested bundle hash, and reported `in_sync` by the
   bridge's on-disk drift check.

The adapter performs this reconciliation again before starting a gateway run.
Configured agents are checked even when their desired set is empty so a failed
earlier unassignment cannot leave a stale bundle usable at runtime. Any missing
source, unreachable service, authentication error, collision, stale
observation, or incomplete configuration prevents run creation. Legacy agents
with no assigned skills and no management fields retain gateway-only
compatibility and do not require the management connections.
