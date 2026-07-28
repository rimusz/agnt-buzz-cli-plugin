# buzz-cli-plugin — Publish / Marketplace Release Plan

> Deliverable #4 for Rimas. Draft for review — **do not publish until sign-off.**
> Grounded in the real plugin state (v1.2.1, 10 tools, installed & active,
> trustTier `community`) and the real AGNT plugin pipeline verified 2026-07-28.

---

## 0. TL;DR

The plugin is functionally complete and installed locally. Before it goes to the
marketplace we need to: **(a) close a short list of manifest/metadata gaps,
(b) do a secrets + permissions audit, (c) dry-run the build + local install,
(d) publish the `.agnt` and list it.** The new **real-time listener** (streaming
replies, no-poll push) is the headline feature for the release and should ship
as **v1.3.0**.

---

## 1. Current state (verified)

| Fact | Value |
|------|-------|
| Installed name / version | `buzz-cli-plugin` **1.2.1** (active, enabled) |
| Tools | **10**: send-message, get-messages, list-channels, join-channel, create-channel, get-thread, send-diff, whoami, provision-identity, list-identities |
| Trust tier | `community` · integrityState `tofu` (trust-on-first-use) |
| Granted perms | `spawn-process`, `network`, `filesystem`, `env-access` |
| Build script | `backend/plugins/cli/build-plugin.js` (real, present) |
| Output | `backend/plugins/plugin-builds/buzz-cli-plugin.agnt` |
| Docs | ARCHITECTURE, CONNECT-ANY-AGENT, PER-AGENT-IDENTITY, SETUP-CHECKLIST, REALTIME-LISTENER-DESIGN |

### ⚠️ Gaps found (must fix before publish)

1. **Version drift** — `manifest.json` says `1.2.1` but `package.json` says `1.2.0`. Must match and bump together.
2. **Manifest metadata thin for a marketplace listing** — has `name`, `version`, `description`, `author: "AGNT"`, `icon`, `homepage`. **Missing:** `license`, `repository`, `keywords`, a longer `displayName`, and a `readme` pointer.
3. **`author: "AGNT"`** is a placeholder — decide the real publisher identity (org vs individual).
4. **No LICENSE file** in the plugin folder.
5. **Secrets audit needed** — confirm no baked-in `nsec`, relay URL, agent UUID, or AGNT token in any shipped file. (The tools already refuse to return private keys; this is about the *bundle contents*.)
6. **Per-tool polish** — every tool has a title/description/icon; do one pass for marketplace-quality wording + consistent examples.
7. **Listener is not yet part of the plugin bundle** — it currently lives in `~/.agnt/annie-buzz-listener/`. Decide: ship it inside the plugin (as `listener/` + a setup script) or keep it as a companion. (Recommendation below.)

---

## 2. The AGNT publish pipeline (real mechanics)

AGNT plugins are `.agnt` files (gzipped tar). The flow, using the endpoints
that actually exist:

```
 dev folder                build-plugin.js            /api/plugins/install-file          marketplace
┌────────────┐   build    ┌──────────────┐  base64   ┌────────────────────┐   publish   ┌───────────┐
│ manifest + │──────────▶ │ *.agnt bundle│──────────▶│ local validate +   │────────────▶│  agnt.gg  │
│ tools + js │            │ (tar.gz)     │           │ install (TOFU)     │             │  listing  │
└────────────┘            └──────────────┘           └────────────────────┘             └───────────┘
```

### Step-by-step (executable)

**A. Build the `.agnt`**
```sh
cd /Users/tom/.agnt-server/backend/plugins
node cli/build-plugin.js dev/buzz-cli-plugin
# -> backend/plugins/plugin-builds/buzz-cli-plugin.agnt
```

**B. Local validate + install (proves the bundle is well-formed)**
`POST /api/plugins/install-file` with `{ name, fileData(base64), fileName }`.
This is the same path the marketplace installer uses, so a clean install here =
a clean install for end users.

**C. Verify**
- `GET /api/plugins/installed/buzz-cli-plugin` → confirm 10 tools, schemas intact.
- `POST /api/plugins/reload` → confirm orchestrator + workflow processes pick it up.

**D. Publish to marketplace** *(owner action — gated)*
Publishing to `agnt.gg` is the go/no-go step. The `.agnt` from step A is the
artifact. (Publish auth/endpoint is an owner credential; confirm the exact
`publish` route/token with the AGNT team before first push — the install/build
half is fully local and safe to rehearse now.)

---

## 3. Release scope — what ships as v1.3.0

**Headline: real-time agent chat.**

| Feature | Deliverable | State |
|---------|-------------|-------|
| Streaming replies (edit-stream) | #1 | ✅ built, cadence-verified |
| Push/no-poll listener | #2 | ✅ built, running in observe-mode |
| Per-agent identity | (prior) | ✅ shipped in 1.2.x |
| 10 CLI-wrapped tools | (prior) | ✅ shipped |

### Recommendation: bundle the listener as an **optional companion**
Ship the listener inside the plugin under `listener/` plus a one-command setup
(`scripts/install-listener.sh` that writes the LaunchAgent), but keep it
**opt-in** — the plugin's core value (the 10 tools) works without it. This keeps
the base install lightweight and avoids forcing a background daemon on users who
just want request/response tools.

---

## 4. Pre-publish checklist (owner: Tom, review: Rimas)

- [ ] Reconcile version: bump `manifest.json` **and** `package.json` to `1.3.0`.
- [ ] Add `license`, `repository`, `keywords`, `displayName` to manifest.
- [ ] Add `LICENSE` file (MIT recommended unless Block/Buzz licensing requires otherwise).
- [ ] Decide + set real `author` / publisher identity.
- [ ] Secrets audit: grep the bundle for `nsec`, `BUZZ_PRIVATE_KEY`, relay URLs, UUIDs, tokens → none present.
- [ ] Per-tool wording + example pass (10 tools).
- [ ] Decide listener packaging (companion recommended) + write `install-listener.sh`.
- [ ] Update README with the real-time feature + a "What's new in 1.3" section.
- [ ] `CHANGELOG.md` entry for 1.3.0.
- [ ] Build `.agnt` → local install-file → verify 10 tools → reload. **Green.**
- [ ] Screenshots / short demo GIF of streaming reply for the listing.
- [ ] **Owner sign-off → publish to agnt.gg.**

---

## 5. Versioning & cadence

- **SemVer.** Breaking tool-schema changes = major; new tools/features = minor; fixes = patch.
- Keep `manifest.json` and `package.json` versions **locked in step** (the current drift is exactly the bug this rule prevents).
- Maintain `CHANGELOG.md` with a section per release.
- Tag releases in the repo; the `.agnt` is reproducible from a tag.

---

## 6. Security / privacy review (for the listing)

- Tools **never return private keys** (enforced) — state this in the listing.
- Per-agent identities; shared `BUZZ_PRIVATE_KEY` disabled by default.
- Declared permissions (`spawn-process`, `network`, `filesystem`, `env-access`)
  are broad because it shells the `buzz` CLI — **document why** each is needed so
  reviewers/users understand the ask.
- Trust tier `community` / TOFU — normal for a non-first-party plugin; note it.

---

## 7. Rollback plan

- Marketplace: keep the prior `.agnt` (1.2.1) archived; re-publish it if 1.3.0 regresses.
- Local: `DELETE /api/plugins/buzz-cli-plugin` then install-file the prior bundle.
- Listener: it's opt-in and independent — disabling it (`launchctl bootout`) can't break the tools.

---

## 8. Owner action matrix

| Action | Who | Gated? |
|--------|-----|--------|
| Close manifest/metadata gaps | Annie (on request) | no |
| Secrets audit | Annie | no |
| Build + local install-file + verify | Annie | no |
| Decide publisher identity / license | Tom | — |
| Publish to agnt.gg | Tom | **yes** |

*Everything up to the publish line is safe to rehearse locally now. Say the word and I'll close the gaps + dry-run the build so it's publish-ready on your go.*


---

## 9. Dry-run complete — 2026-07-28 ✅

All non-publish gaps closed and the build verified end-to-end.

| Step | Result |
|------|--------|
| Version reconciled | `manifest.json` **1.3.0** == `package.json` **1.3.0** ✅ |
| Marketplace metadata | added `displayName: "Buzz for AGNT"`, `license: MIT`, `repository`, `keywords[9]` ✅ |
| LICENSE file | MIT, written ✅ |
| Per-tool metadata | top-level `title` + `description` added to all 10 tools (validator now passes) ✅ |
| Secrets audit | no private keys / tokens in bundle; lab-specific relay host + pubkeys **sanitized** to `relay.example.com` / `<agent-pubkey-hex>` placeholders across 8 docs/skill files ✅ |
| Build | `node cli/build-plugin.js dev/buzz-cli-plugin` → **buzz-cli-plugin.agnt (50.9 KB, 41 entries)** ✅ |
| Integrity (SRI) | `sha256-mXOlBQGhj1rj3jfSKxi9riCZVd91gu3pg2pCsgSk4gI=` |
| Local install-file | `POST /api/plugins/install-file` → **200, v1.3.0, 10 tools, isValid:true**, reloaded (main+orchestrator+workflow) ✅ |

**Artifact:** `backend/plugins/plugin-builds/buzz-cli-plugin.agnt`

### The ONLY remaining step
**Publish to agnt.gg** — owner go/no-go. The build script prints the target:
`Upload to: https://agnt.gg/api/plugins/publish`. The `.agnt` above is the artifact.

> Still open (deliberately not done, per plan): (a) bundling the real-time
> listener as an opt-in companion + `install-listener.sh`, (b) a CHANGELOG entry,
> (c) demo GIF for the listing. None block a first publish; flag if you want them
> before the push.
