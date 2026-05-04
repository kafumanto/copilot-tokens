#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
# Use an absolute workspace path so the alias works from any shell location
# inside the container without relying on the current directory.
ALIAS_LINE="alias copilot-tokens='node \"$REPO_ROOT/bin/copilot-tokens\" --workspace-storage /host-vscode-data/workspaceStorage'"

cd "$REPO_ROOT"
# Keep dependency installation local to the tool so the container setup stays
# focused on the workspace utilities rather than the whole repository.
npm install

# Make the convenience alias idempotent so rebuilding or reopening the container
# does not append duplicate lines to the user's shell startup file.
if [ -f "$HOME/.bashrc" ]; then
	if ! grep -Fqx "$ALIAS_LINE" "$HOME/.bashrc"; then
		printf '\n%s\n' "$ALIAS_LINE" >> "$HOME/.bashrc"
	fi
else
	printf '%s\n' "$ALIAS_LINE" > "$HOME/.bashrc"
fi
