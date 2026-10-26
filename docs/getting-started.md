# Getting started

[Back to README](../README.md) · [Configuration](configuration.md) · [User guide](user-guide.md)

Podmanman needs a Podman socket for container data. Mounting Quadlet definitions adds the Quadlet inventory; mounting the rootless user systemd bus and allowing writes to one definition directory enables its administration controls. The examples below enable all of these features. See [configuration](configuration.md#access-modes) for less privileged setups.

## Rootless Linux host

Enable the Podman API socket and create the usual user Quadlet directory:

```sh
systemctl --user enable --now podman.socket
mkdir -p "$HOME/.config/containers/systemd"
```

From the project directory, build and run the dashboard:

```sh
podman build -t podmanman .
podman run -d --name podmanman \
  --userns=keep-id \
  --user "$(id -u):$(id -g)" \
  --security-opt label=disable \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock" \
  -v "$XDG_RUNTIME_DIR/bus:$XDG_RUNTIME_DIR/bus" \
  -e USER_SYSTEMD_BUS="$XDG_RUNTIME_DIR/bus" \
  -v "$HOME/.config/containers/systemd:/quadlets:rw" \
  -e QUADLET_WRITE_DIR=/quadlets \
  -p 127.0.0.1:3000:3000 \
  podmanman
```

Open <http://127.0.0.1:3000>. Change the host side of `-p` to use a different browser port. The process runs with your UID so its `systemctl --user` client can reach the same user manager as the mounted bus and Podman socket.

You can replace the locally built `podmanman` image with `ghcr.io/deversmann/podmanman:latest` if the package is accessible to you. See [published images](development.md#ci-and-published-images) for tags and visibility.

## Podman machine on macOS

Podman containers on macOS run inside a Linux VM. Start your Podman machine if needed, then use the VM's rootless socket and bus paths. A macOS forwarding socket cannot be bind mounted into the dashboard as a working Unix socket; doing so can lead to `ECONNREFUSED`.

```sh
machine_uid=$(podman machine ssh -- id -u)
machine_gid=$(podman machine ssh -- id -g)
podman machine ssh -- mkdir -p /var/home/core/.config/containers/systemd
podman build -t podmanman .
podman run -d --name podmanman \
  --userns=keep-id \
  --user "$machine_uid:$machine_gid" \
  --security-opt label=disable \
  -v "/run/user/$machine_uid/podman/podman.sock:/run/podman/podman.sock" \
  -v "/run/user/$machine_uid/bus:/run/user/$machine_uid/bus" \
  -e USER_SYSTEMD_BUS="/run/user/$machine_uid/bus" \
  -v "/var/home/core/.config/containers/systemd:/quadlets:rw" \
  -e QUADLET_WRITE_DIR=/quadlets \
  -p 127.0.0.1:3030:3000 \
  podmanman
```

Open <http://127.0.0.1:3030>. `/var/home/core` is the usual home path in Podman machine; adjust the mount if your machine uses a different path. To locate Quadlets in other directories, run `podman machine ssh -- podman quadlet list --format json`, mount the relevant directories, and set `QUADLET_DIRS` as described in [configuration](configuration.md#quadlet-directories). In the Linux example, `$HOME` and `$XDG_RUNTIME_DIR` refer to the host running the command; on macOS those paths are inside the VM.

## Next steps

- [Configure read-only or writable Quadlet access](configuration.md#access-modes).
- [Learn the dashboard and conversion flow](user-guide.md).
- [Run from Node.js and contribute](development.md).
