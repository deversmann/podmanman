# Configuration

[Back to README](../README.md) · [Getting started](getting-started.md) · [User guide](user-guide.md)

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PODMAN_SOCKET` | `/run/podman/podman.sock` | Unix socket for container data and direct container actions. The selected socket determines which Podman store is shown. |
| `QUADLET_DIRS` | `/quadlets` | Colon-separated directories to scan for Quadlet definitions. |
| `QUADLET_WRITE_DIR` | unset | One writable directory, matching a root in `QUADLET_DIRS`, where files may be added or removed. |
| `USER_SYSTEMD_BUS` | `/run/user/<uid>/bus` | Rootless user's systemd bus socket for Quadlet service controls. |
| `SYSTEMCTL_PATH` | `/bin/systemctl` | Path to the systemctl client inside the dashboard; primarily useful for custom images and tests. |
| `HOST` | `127.0.0.1` in Node.js; `0.0.0.0` in the image | HTTP listen address. |
| `PORT` | `3000` | HTTP listen port inside the dashboard. |

The [container run examples](getting-started.md) bind the published web port to `127.0.0.1` on the host. Keep that host-side binding when using the image's `HOST=0.0.0.0` setting.

## Access modes

| Setup | Quadlet capabilities |
| --- | --- |
| No Quadlet directory | Container view remains available; Quadlet source files cannot be shown. |
| Directory mounted read-only | View definitions and related containers. |
| Directory and matching rootless user bus | Also start and stop generated rootless Quadlet services. |
| Bus plus a writable directory named by `QUADLET_WRITE_DIR` | Also add and remove top-level definitions in that directory. |

Direct container actions use the Podman socket in every mode; mounting Quadlet files read-only does **not** make the whole dashboard read-only. Container-to-Quadlet cutover additionally requires the socket and user bus to belong to the same non-root user. If those requirements are absent, the conversion control is disabled.

## Quadlet directories

The usual rootless definition path is `~/.config/containers/systemd`. Podman also supports [other rootless search paths](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html). Mount each path you want to inventory and set `QUADLET_DIRS` to its path **inside** the dashboard container. For example, these additional `podman run` arguments mount a runtime directory read-only and a user directory read-write:

```sh
-v "$XDG_RUNTIME_DIR/containers/systemd:/quadlets/runtime:ro" \
-v "$HOME/.config/containers/systemd:/quadlets/user:rw" \
-e QUADLET_DIRS=/quadlets/runtime:/quadlets/user \
-e QUADLET_WRITE_DIR=/quadlets/user
```

Podmanman finds definitions in nested directories, but file additions and removals are limited to the top level of `QUADLET_WRITE_DIR`. Other mounted directories and nested definitions remain read-only in the UI. To enable writes, the configured directory must be mounted, writable by the dashboard process, and paired with a working rootless user bus. Quadlet source may run commands with that user's privileges.

The inventory displays selected fields from mounted source files. It does not expose environment or credential directives to the browser, resolve drop-ins, or report the effective systemd unit state. When the Podman API reports a systemd managed container without its definition file, the UI shows the known service and container as **Source file not mounted**. Mount the directory containing its `.container` file to see the definition.

## Socket and bus troubleshooting

- **Podman unavailable or `ECONNREFUSED`:** Confirm the socket is active with `systemctl --user status podman.socket`. On macOS, mount the *VM's* `/run/user/<uid>/podman/podman.sock`, as in the [Podman machine example](getting-started.md#podman-machine-on-macos), rather than the forwarding socket on macOS.
- **Quadlet controls disabled:** Check that the dashboard runs as the rootless user, `/run/user/<uid>/bus` is mounted, and `USER_SYSTEMD_BUS` points to it. File changes also need `QUADLET_WRITE_DIR` to match a mounted writable root.
- **Definition not shown:** Mount its actual search path and include that path in `QUADLET_DIRS`. A Podman container's systemd label identifies its service, but does not provide the source Quadlet file.

A rootful Podman socket, usually `/run/podman/podman.sock` on the host, points at a separate container store. You can mount it for inventory if the dashboard process can access it, but direct container actions would also affect that rootful store; this is not a read-only mode. Quadlet administration currently targets rootless user services. A dedicated read-only rootful view remains an [exploration](user-guide.md#planned-features).

## Security

The Podman socket grants broad control of the selected container store, and Podmanman has no built-in user authentication. Keep the web port on loopback, or use an authenticated reverse proxy for remote access. The run examples use `--security-opt label=disable` to allow the socket and bus mounts across SELinux labels; limit access to those mounts and to the dashboard. Only allow trusted users to add or edit Quadlet source.
