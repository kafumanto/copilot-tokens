#!/bin/sh

# Required mount:
#   /data -> VS Code User directory containing workspaceStorage/ and globalStorage/
# Expected working directory:
#   Any; the entrypoint resolves the tool paths itself.

set -eu

WORKSPACE_STORAGE_ROOT=/data/workspaceStorage
GLOBAL_STORAGE_ROOT=/data/globalStorage

if [ ! -d "$WORKSPACE_STORAGE_ROOT" ]; then
	echo "Error: missing $WORKSPACE_STORAGE_ROOT. Mount a VS Code User directory at /data." >&2
	exit 1
fi

exec /app/bin/copilot-tokens \
	--workspace-storage "$WORKSPACE_STORAGE_ROOT" \
	--global-storage "$GLOBAL_STORAGE_ROOT" \
	"$@"
