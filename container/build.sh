#!/bin/sh

# Required tools:
#   podman
#
# Expected working directory:
#   Any; the script resolves repository paths relative to its own location.
#
# Credentials file format for --creds:
#
#   GITHUB_USER=your-github-user
#   GITHUB_TOKEN=your-github-token
#
# The GITHUB_TOKEN must have permissions to create and publish packages in the target repository,
# and to read package metadata if --push-public is used.
# For [personal accounts](https://github.com/settings/tokens), the "write:packages" scope is sufficient.
# For [organization accounts](https://github.com/settings/organizations), the token must have the "packages" permission for the target repository,
# and may require additional permissions depending on the organization's security settings.

set -eu

IMAGE_NAME=copilot-tokens
PACKAGE_NAME=copilot-tokens
REGISTRY=ghcr.io

CONTAINER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$CONTAINER_DIR/.." && pwd -P)

CREDS_FILE=
VERSION_OVERRIDE=
PUSH=false
PUSH_PUBLIC=false
GITHUB_USER=
GITHUB_TOKEN=

print_help() {
	cat <<'EOF'
Usage: ./container/build.sh [--version <version>] [--creds <file>] [--push] [--push-public]

Build the copilot-tokens container image with Podman.

Options:
  --version <version>  Override the version tag read from package.json
  --creds <file>       Read GITHUB_USER and GITHUB_TOKEN from a key=value file
  --push               Push ghcr.io/GITHUB_USER/copilot-tokens:<version> and :latest
  --push-public        Push the image, then stop with the package settings URL
                       because GitHub does not expose a supported API to change
                       GHCR package visibility from this script
  --help               Show this help text
EOF
}

get_package_version() {
	grep -m1 '"version"' "$REPO_ROOT/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

read_creds_file() {
	if [ ! -r "$CREDS_FILE" ]; then
		echo "Error: credentials file is not readable: $CREDS_FILE" >&2
		exit 1
	fi

	while IFS= read -r line || [ -n "$line" ]; do
		# Credentials files created on Windows may use CRLF; strip trailing CR so key parsing stays portable on Unix shells.
		line=$(printf '%s' "$line" | tr -d '\r')

		case "$line" in
			''|'#'*)
				continue
				;;
			GITHUB_USER=*)
				GITHUB_USER=${line#GITHUB_USER=}
				;;
			GITHUB_TOKEN=*)
				GITHUB_TOKEN=${line#GITHUB_TOKEN=}
				;;
			*)
				echo "Error: unsupported credentials entry: $line" >&2
				exit 1
				;;
		esac
	done < "$CREDS_FILE"

	if [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_TOKEN" ]; then
		echo "Error: credentials file must define both GITHUB_USER and GITHUB_TOKEN" >&2
		exit 1
	fi
}

build_image() {
	VERSION=$1

	set -- podman build \
		-f "$CONTAINER_DIR/Containerfile" \
		-t "$IMAGE_NAME:$VERSION" \
		-t "$IMAGE_NAME:latest"

	set -- "$@" "$REPO_ROOT"
	"$@"
}

push_image() {
	VERSION=$1
	REMOTE_IMAGE=$REGISTRY/$GITHUB_USER/$IMAGE_NAME

	printf '%s\n' "$GITHUB_TOKEN" | podman login "$REGISTRY" -u "$GITHUB_USER" --password-stdin

	podman tag "$IMAGE_NAME:$VERSION" "$REMOTE_IMAGE:$VERSION"
	podman tag "$IMAGE_NAME:latest" "$REMOTE_IMAGE:latest"

	podman push "$REMOTE_IMAGE:$VERSION"
	podman push "$REMOTE_IMAGE:latest"

	echo "Pushed: $REMOTE_IMAGE:$VERSION"
	echo "Pushed: $REMOTE_IMAGE:latest"
}

print_public_visibility_note() {
	PACKAGE_URL=https://github.com/users/$GITHUB_USER/packages/container/package/$PACKAGE_NAME

	echo ""
	echo "GitHub Container Registry packages are private by default."
	echo "Open the package settings to change visibility:"
	echo "  $PACKAGE_URL"
	echo ""
	echo "GitHub's documented package APIs expose package metadata but do not expose a supported endpoint to change GHCR package visibility from this script."
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--creds)
			if [ "$#" -lt 2 ]; then
				echo "Error: missing value for --creds" >&2
				exit 1
			fi
			CREDS_FILE=$2
			shift 2
			;;
		--version)
			if [ "$#" -lt 2 ]; then
				echo "Error: missing value for --version" >&2
				exit 1
			fi
			VERSION_OVERRIDE=$2
			shift 2
			;;
		--push)
			PUSH=true
			shift
			;;
		--push-public)
			PUSH=true
			PUSH_PUBLIC=true
			shift
			;;
		--help|-h)
			print_help
			exit 0
			;;
		*)
			echo "Error: unknown argument: $1" >&2
			print_help >&2
			exit 1
			;;
	esac
done

if [ -n "$CREDS_FILE" ]; then
	read_creds_file
fi

if [ "$PUSH" = true ] && [ -z "$CREDS_FILE" ]; then
	echo "Error: --push and --push-public require --creds <file>" >&2
	exit 1
fi

VERSION=${VERSION_OVERRIDE:-$(get_package_version)}

if [ -z "$VERSION" ]; then
	echo "Error: failed to determine package version from package.json" >&2
	exit 1
fi

build_image "$VERSION"

if [ "$PUSH" = true ]; then
	push_image "$VERSION"
	if [ "$PUSH_PUBLIC" = true ]; then
		print_public_visibility_note
		echo "--push-public could not complete automatically; GitHub requires the web UI for the visibility change." >&2
		exit 2
	fi
	print_public_visibility_note
fi