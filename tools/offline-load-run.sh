#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <image.tar.gz|image.tar> [image-ref]" >&2
  exit 1
fi

archive_path="$1"
image_ref="${2:-}"
container_name="${CONTAINER_NAME:-playwright-player}"
host_port="${HOST_PORT:-3000}"
runtime_root="${RUNTIME_ROOT:-$(pwd)/offline-runtime}"
scripts_dir="${SCRIPTS_DIR:-$runtime_root/scripts}"
storage_states_dir="${STORAGE_STATES_DIR:-$runtime_root/storage-states}"
data_dir="${DATA_DIR:-$runtime_root/data}"
disable_ipc_host="${DISABLE_IPC_HOST:-false}"

mkdir -p "$scripts_dir" "$storage_states_dir" "$data_dir"

load_target="$archive_path"
temp_tar=""
cleanup() {
  if [[ -n "$temp_tar" && -f "$temp_tar" ]]; then
    rm -f "$temp_tar"
  fi
}
trap cleanup EXIT

if [[ "$archive_path" == *.tar.gz ]]; then
  temp_tar="$(mktemp "${TMPDIR:-/tmp}/playwright-player-XXXXXX.tar")"
  echo "Decompressing archive to temporary tar file..."
  gzip -dc "$archive_path" > "$temp_tar"
  load_target="$temp_tar"
fi

echo "Loading Docker image from $archive_path"
load_output="$(docker load -i "$load_target" 2>&1)"
printf '%s\n' "$load_output"

if [[ -z "$image_ref" ]]; then
  image_ref="$(printf '%s\n' "$load_output" | sed -n 's/^Loaded image: //p' | tail -n 1)"
fi

if [[ -z "$image_ref" ]]; then
  echo "Unable to determine image reference automatically. Pass it as the second argument." >&2
  exit 1
fi

docker rm -f "$container_name" >/dev/null 2>&1 || true

run_args=(run -d --name "$container_name" --init)
if [[ "$disable_ipc_host" != "true" ]]; then
  run_args+=(--ipc=host)
fi

run_args+=(
  -p "${host_port}:3000"
  -e PORT=3000
  -e DEFAULT_HEADLESS=true
  -e ENABLE_EVALUATE=true
  -v "${scripts_dir}:/app/scripts"
  -v "${storage_states_dir}:/app/storage-states"
  -v "${data_dir}:/app/data"
)

container_id="$(docker "${run_args[@]}" "$image_ref")"

cat <<EOF

Container started.
  Container : $container_name
  Image     : $image_ref
  Id        : $container_id
  Runtime   : $runtime_root
  Health    : http://127.0.0.1:$host_port/health
  Docs      : http://127.0.0.1:$host_port/docs
  Playground: http://127.0.0.1:$host_port/playground

Mounted directories:
  Scripts        : $scripts_dir
  Storage states : $storage_states_dir
  Data           : $data_dir

Stop commands:
  docker stop $container_name
  docker rm $container_name
EOF
