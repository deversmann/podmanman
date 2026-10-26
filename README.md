# Podmanman

Podmanman is a small web dashboard for Podman containers and Quadlet resources. It runs in a container, connects to the host's Podman Unix socket, and reads mounted Quadlet definitions.

## Features

- View direct containers and Quadlet resources in separate, searchable tables. Sort columns and choose which columns to display, including ports and volume mounts.
- Inspect containers, read recent logs, and start, stop, restart, launch, or remove directly managed containers.
- View and manage rootless Quadlet definitions and services when the user systemd bus and a writable definition directory are available.
- Convert a direct container to a reviewable Quadlet draft, then switch services while retaining the stopped original for recovery.

The dashboard works without a mounted Quadlet directory, but that directory is needed to show source definitions. Rootless Quadlet administration requires additional mounts and configuration. Podmanman has no built-in authentication; keep its web port on loopback or put it behind an authenticated proxy.

## Get started

Enable the rootless Podman socket on the host:

```sh
systemctl --user enable --now podman.socket
```

Then follow the [Linux](docs/getting-started.md#rootless-linux-host) or [Podman machine on macOS](docs/getting-started.md#podman-machine-on-macos) run instructions. For local Node.js development, see the [development guide](docs/development.md).

## Documentation

- [Getting started](docs/getting-started.md) — Linux and macOS installation and run examples
- [Configuration](docs/configuration.md) — sockets, Quadlet mounts, access modes, and security
- [User guide](docs/user-guide.md) — tables, administration, and container conversion
- [Development](docs/development.md) — local setup, tests, CI, and published images
- [Architecture and API](docs/architecture.md) — data flow, safeguards, and HTTP routes
