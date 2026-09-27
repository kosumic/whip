#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
container_name="whip-live-ssh-${RANDOM}-$$"
image="${RUSSH_SSH_TEST_IMAGE:-lscr.io/linuxserver/openssh-server@sha256:4e3054a3c64f19cf4ee28dcac64c030f3a722a4fe46a319f68f9e0952c7de074}"

if command -v podman >/dev/null 2>&1; then
  container_runtime=podman
elif command -v docker >/dev/null 2>&1; then
  container_runtime=docker
else
  echo "error: Podman or Docker is required for the live SSH test" >&2
  exit 1
fi

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    "$container_runtime" logs "$container_name" >&2 || true
  fi
  "$container_runtime" exec "$container_name" rm -rf \
    /workspace/client /workspace/download /workspace/remote >/dev/null 2>&1 || true
  "$container_runtime" rm --force "$container_name" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
  return "$status"
}
trap cleanup EXIT

mkdir -p "$test_dir/shared"
chmod 0777 "$test_dir/shared"
ssh-keygen -q -t ed25519 -N '' -C russh-live-test -f "$test_dir/client_key"
# PKCS#8 ("BEGIN PRIVATE KEY") RSA, the format cloud consoles hand out.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$test_dir/client_rsa_key" 2>/dev/null
chmod 0600 "$test_dir/client_rsa_key"
cat "$test_dir/client_key.pub" >"$test_dir/authorized_keys"
ssh-keygen -y -f "$test_dir/client_rsa_key" >>"$test_dir/authorized_keys"
printf '%s\n' \
  '#!/usr/bin/with-contenv bash' \
  "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config" \
  >"$test_dir/enable-forwarding"
chmod 0755 "$test_dir/enable-forwarding"
printf '%s\n' \
  '#!/usr/bin/with-contenv bash' \
  "echo 'russh:russh-test-password' | chpasswd" \
  >"$test_dir/set-password"
chmod 0755 "$test_dir/set-password"

"$container_runtime" run --detach --name "$container_name" \
  --env PUID="$(id -u)" \
  --env PGID="$(id -g)" \
  --env TZ=Etc/UTC \
  --env PUBLIC_KEY_FILE=/run/secrets/russh_test_key.pub \
  --env PASSWORD_ACCESS=true \
  --env USER_PASSWORD=whip-test-password \
  --env USER_NAME=russh \
  --env LOG_STDOUT=true \
  --publish 127.0.0.1::2222 \
  --volume "$test_dir/authorized_keys:/run/secrets/russh_test_key.pub:ro" \
  --volume "$test_dir/enable-forwarding:/etc/cont-init.d/88-enable-forwarding:ro" \
  --volume "$test_dir/set-password:/custom-cont-init.d/99-set-password:ro" \
  --volume "$test_dir/shared:/workspace" \
  "$image" >/dev/null

port_mapping="$($container_runtime port "$container_name" 2222/tcp)"
host_port="${port_mapping##*:}"
outer_key=''
for _ in $(seq 1 60); do
  scan_output="$(ssh-keyscan -T 1 -t ed25519 -p "$host_port" 127.0.0.1 2>/dev/null || true)"
  outer_key="$(printf '%s\n' "$scan_output" | awk '!/^#/ { print; exit }')"
  if [[ -n "$outer_key" ]]; then
    break
  fi
  sleep 1
done
if [[ -z "$outer_key" ]]; then
  "$container_runtime" logs "$container_name" >&2
  echo "error: live SSH container did not become ready" >&2
  exit 1
fi

key_material="${outer_key#* }"
printf '%s\n' "$outer_key" "[127.0.0.1]:2222 $key_material" >"$test_dir/known_hosts"

(
  cd "$rust_dir"
  RUSSH_SSH_TEST_HOST=127.0.0.1 \
  RUSSH_SSH_TEST_PORT="$host_port" \
  RUSSH_SSH_TEST_TARGET_PORT=2222 \
  RUSSH_SSH_TEST_USER=russh \
  RUSSH_SSH_TEST_PRIVATE_KEY="$test_dir/client_key" \
  RUSSH_SSH_TEST_RSA_PRIVATE_KEY="$test_dir/client_rsa_key" \
  RUSSH_SSH_TEST_KNOWN_HOSTS="$test_dir/known_hosts" \
  RUSSH_SSH_TEST_SHARED_DIR="$test_dir/shared" \
  cargo test --locked live_openssh_feature_matrix -- --ignored --nocapture
)
