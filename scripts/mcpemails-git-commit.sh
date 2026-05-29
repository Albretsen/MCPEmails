#!/bin/bash
# mcpemails-git-commit.sh
# Runs natively on the host (not in the Cowork sandbox) to commit pending changes.
# Triggered by com.mcpemails.git-commit LaunchAgent when .pending-commit.txt appears.

REPO="$HOME/Repositories/MCPEmails"
PENDING="$REPO/.pending-commit.txt"
LOG="$REPO/.mcpemails-git-commit.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

if [ ! -s "$PENDING" ]; then
  exit 0
fi

MSG=$(head -1 "$PENDING")
log "Pending commit found: $MSG"

cd "$REPO" || { log "ERROR: cannot cd to $REPO"; exit 1; }

# Remove stale lock files — running as host user so unlink works
find .git -name "*.lock" -delete 2>/dev/null
find .git -name "*.lock.*" -delete 2>/dev/null
log "Cleared stale lock files"

git add -A
if git commit -m "$MSG"; then
  log "SUCCESS: $MSG"
  # If there are more queued messages, commit them one by one
  tail -n +2 "$PENDING" > "$PENDING.tmp" && mv "$PENDING.tmp" "$PENDING"
  if [ -s "$PENDING" ]; then
    log "More commits queued — will fire again on next poll"
  else
    rm -f "$PENDING"
    log "Removed .pending-commit.txt"
  fi
else
  log "ERROR: git commit failed"
  exit 1
fi
