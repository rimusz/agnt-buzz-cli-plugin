#!/bin/sh
# install-agent-skills.sh — install the plugin's AGNT AGENT skills so Annie (the
# AGNT orchestrator agent) can activate them from her <available-skills> catalog.
#
# These are DIFFERENT from the plugin's skills/ folder:
#   - skills/           -> CLI skills (grok/codex/claude CLIs), copied to ~/.grok/skills etc.
#   - agent-skills/      -> AGNT AGENT skills (Annie), copied to ~/.agnt/skills  <-- THIS
#
# ⚠️ BACKEND-RESTART REQUIREMENT (important):
#   AGNT's SkillDiscoveryService builds its catalog into an in-memory map at
#   BACKEND STARTUP. This build has NO live rescan endpoint (POST /api/skills/rescan
#   returns 404), so newly-copied skills will NOT appear in Annie's catalog until
#   the backend restarts. This script restarts it for you (unless --no-restart),
#   then health-checks and verifies the skills are in the catalog.
#
# Usage:
#   ./install-agent-skills.sh              copy skills + restart backend + verify
#   ./install-agent-skills.sh --dry-run    show what would happen, change nothing
#   ./install-agent-skills.sh --no-restart copy only (you restart the backend later)
#
# Env overrides:
#   AGNT_SKILLS_DIR   destination (default: ~/.agnt/skills)
#   AGNT_API          health/verify base (default: http://localhost:3333/api)

set -e

SRC_DIR="$(cd "$(dirname "$0")/../agent-skills" 2>/dev/null && pwd || true)"
DEST_DIR="${AGNT_SKILLS_DIR:-$HOME/.agnt/skills}"
AGNT_API="${AGNT_API:-http://localhost:3333/api}"
LABEL="ai.agnt.backend"

DRY_RUN=""
NO_RESTART=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="1" ;;
    --no-restart) NO_RESTART="1" ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

echo "== AGNT agent-skills installer =="
echo "source:      ${SRC_DIR:-<not found>}"
echo "destination: $DEST_DIR"
[ -n "$DRY_RUN" ] && echo "mode:        DRY RUN (no changes)"
echo ""

if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: agent-skills/ folder not found next to this script."
  echo "       Expected at: $(dirname "$0")/../agent-skills"
  exit 1
fi

# Discover the skills to install (each is a dir with a SKILL.md)
SKILLS=""
for d in "$SRC_DIR"/*/; do
  [ -f "${d}SKILL.md" ] || continue
  name="$(basename "$d")"
  SKILLS="$SKILLS $name"
done
if [ -z "$SKILLS" ]; then
  echo "ERROR: no skills (dirs containing SKILL.md) found in $SRC_DIR"
  exit 1
fi
echo "skills to install:$SKILLS"
echo ""

# 1. copy
for name in $SKILLS; do
  if [ -n "$DRY_RUN" ]; then
    echo "  would copy  $SRC_DIR/$name/  ->  $DEST_DIR/$name/"
  else
    mkdir -p "$DEST_DIR/$name"
    cp -f "$SRC_DIR/$name/SKILL.md" "$DEST_DIR/$name/SKILL.md"
    # copy optional bundled resources if present
    for sub in scripts references assets; do
      [ -d "$SRC_DIR/$name/$sub" ] && cp -Rf "$SRC_DIR/$name/$sub" "$DEST_DIR/$name/"
    done
    echo "  installed   $DEST_DIR/$name/SKILL.md"
  fi
done
echo ""

if [ -n "$DRY_RUN" ]; then
  echo "DRY RUN complete. Re-run without --dry-run to install."
  echo ""
  echo "NOTE: after a real install you MUST restart the AGNT backend (this script"
  echo "      does it automatically) — agent skills only load at backend startup;"
  echo "      there is no live rescan endpoint on this build."
  exit 0
fi

# 2. restart backend (unless --no-restart) so the catalog reloads
if [ -n "$NO_RESTART" ]; then
  echo "⚠️  --no-restart: skills copied but NOT yet live."
  echo "    Agent skills load only at backend startup (no live rescan endpoint)."
  echo "    Restart the backend to make them appear in Annie's catalog:"
  echo "      launchctl kickstart -k gui/\$(id -u)/$LABEL"
  exit 0
fi

echo "== restarting AGNT backend to load the new skills =="
echo "   (agent skills only load at startup — no live rescan endpoint on this build)"
if command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "$LABEL"; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL" || {
    echo "   kickstart failed; try manually: launchctl kickstart -k gui/\$(id -u)/$LABEL"
    exit 1
  }
  echo "   restart requested."
else
  echo "⚠️  Could not find launchd service '$LABEL'."
  echo "    If your backend runs another way (systemd / npm run dev / Docker),"
  echo "    restart it now so the skills load, then re-run with --no-restart to skip this."
  exit 1
fi

# 3. wait for health
echo ""
echo "== waiting for backend health =="
ok=""
i=0
while [ $i -lt 30 ]; do
  if curl -fsS "$AGNT_API/agents/health" >/dev/null 2>&1; then ok="1"; break; fi
  i=$((i+1)); sleep 1
done
if [ -z "$ok" ]; then
  echo "⚠️  backend didn't report healthy within 30s at $AGNT_API/agents/health"
  echo "    (it may still be starting — verify the catalog in a moment)"
else
  echo "   backend healthy."
fi

# 4. verify the skills are in the catalog
echo ""
echo "== verifying skills appear in the catalog =="
CATALOG="$(curl -fsS "$AGNT_API/skills" 2>/dev/null || echo '')"
all_ok="1"
for name in $SKILLS; do
  if printf '%s' "$CATALOG" | grep -q "\"$name\""; then
    echo "   ✅ $name is in Annie's catalog"
  else
    echo "   ❌ $name NOT in catalog yet"
    all_ok=""
  fi
done
echo ""
if [ -n "$all_ok" ]; then
  echo "DONE. Annie can now activate these skills (e.g. activate_skill \"buzz-teammate\")."
else
  echo "Some skills are not visible yet. Give the backend a few seconds and check:"
  echo "   curl $AGNT_API/skills | grep buzz-"
fi
