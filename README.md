# Podmanman

A small web dashboard for containers and Quadlet resources on a Podman host. It runs in a container, talks to Podman through the host's Unix socket, and reads mounted Quadlet directories.

## What it does

- Uses top tabs to switch between direct containers and Quadlet/systemd resources. The selected tab has a shareable `#containers` or `#quadlets` URL.
- Lists directly managed Podman containers, including stopped containers.
- Shows state, image, ports, inspect details, and the latest 200 log lines.
- Searches and filters containers.
- Sorts the Containers and Quadlets tables independently by clicking a column heading. Click again to reverse the order; an arrow marks the active column and direction. Each choice stays in place as the data refreshes.
- Use each table's **Columns** menu to show or hide columns, including **Volume mounts**. Choices are saved separately in the browser for the two tables. At least one data column stays visible.
- The Quadlet table also offers an optional **Ports** column. It shows ports reported for linked containers, or declared `PublishPort=` values when no container ports are reported.
- Starts, stops, and restarts containers managed directly through Podman. A launch form creates and starts a container from an image already present in Podman, with optional name, loopback-bound ports, and bind or named-volume mounts. Stopped direct containers can be removed without deleting their images or volumes.
- Offers **Convert to Quadlet** in direct container details. It drafts a `.container` file from the inspected image, port bindings, and mounts, with warnings about settings that need review. Saving the draft leaves the original container unchanged and does not configure automatic startup. A separate switch action stops the original and starts the new service; if startup fails, Podmanman attempts to restart the original. On success it adds `WantedBy=default.target` for future user sessions. The original remains stopped until you choose to remove it.
- Identifies systemd managed containers through the `PODMAN_SYSTEMD_UNIT` label and points users to their service unit. Their lifecycle controls are intentionally handled by systemd.
- Displays Quadlet definitions for containers, pods, networks, volumes, images, builds, artifacts, and Kubernetes deployments. These remain visible before their service creates a Podman resource.
- Starts and stops mounted rootless Quadlet services through the systemd user manager when its bus is available. With one explicitly writable Quadlet directory, you can add new definition files and remove files in that directory. Removing a Quadlet stops its active service and reloads the user manager.
- Shows a running container's actual name prominently in its Quadlet row, with the definition filename underneath. The detail view includes the inferred service name, source path, description, selected declared fields, and linked containers.
- Places systemd managed containers in the Quadlet and systemd section. When a definition directory is not mounted, it still shows the service and container details reported by Podman.

The direct container list only includes objects that currently exist in Podman and are not marked as systemd managed. The Quadlet and systemd section lists definitions from mounted directories and links current containers by service label. It does not report systemd unit state. Additions accept Quadlet source text; editing existing definitions is not available yet.

Conversion requires a writable rootless Quadlet directory, the rootless user systemd bus, and a Podman socket owned by that same user. Containers in a Pod need a coordinated conversion and are excluded. Review the generated text before saving: environment values, command and entrypoint overrides, custom networks, security settings, and other advanced options are not copied automatically. The replacement uses Quadlet's generated container name, so it does not collide with the original. Switching briefly stops the workload. Keep the stopped original until you verify the new service and its data.

When the Volume mounts column is enabled, Podmanman inspects existing containers to show mount sources and destinations. Named volumes use their volume name. Quadlet rows show the linked container's actual mounts when available, or declared `Volume=` and `Mount=` entries from the Quadlet source file before a container exists. Other Quadlet resource types show a dash when they do not declare container mounts. Container inspection adds API requests during refresh while this column is enabled.

## Planned features

- Edit existing user-space Quadlet definitions.
- Explore read-only views of rootful containers and Quadlets.

## Run on a rootless Linux host

Enable the Podman API socket:

```sh
systemctl --user enable --now podman.socket
```

Build and run the dashboard:

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

Open <http://127.0.0.1:3000>. To use another port, change the host side of `-p`.

The example mounts the rootless systemd user bus and the usual Quadlet directory. Podmanman runs as that user's UID, so its `systemctl --user` client can reach the user manager. `QUADLET_WRITE_DIR` enables file additions and removals in exactly one mounted directory; omit it or mount the directory read only to keep the inventory read only. If the bus is absent, service controls remain unavailable. If your Quadlet files are in other [Podman search paths](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), mount those directories too and set `QUADLET_DIRS` to a colon separated list of their paths inside the dashboard container. For example:

```sh
-v "$XDG_RUNTIME_DIR/containers/systemd:/quadlets/runtime:ro" \
-v "$HOME/.config/containers/systemd:/quadlets/user:rw" \
-e QUADLET_WRITE_DIR=/quadlets/user \
-e QUADLET_DIRS=/quadlets/runtime:/quadlets/user
```

Quadlet files in nested directories are included. File additions and removals are limited to the top level of `QUADLET_WRITE_DIR`; other mounted directories and nested definitions remain read only. Environment variables and credential directives in definitions are not returned to the browser. Files that are not mounted cannot be inventoried. The displayed fields come from each source file; drop-ins and systemd's effective unit state are not resolved. Quadlet source can execute commands as the rootless user, so only use this feature from a trusted local browser.

If a Quadlet container appears with “Source file not mounted,” mount the directory containing its `.container` file and restart Podmanman. The systemd service label identifies the container, but Podman's socket API does not expose the source Quadlet file.

For a rootful socket, mount `/run/podman/podman.sock` instead and run the dashboard with an identity that can access it. The socket selected determines which Podman containers appear; rootless and rootful stores are separate.

## Run with Podman machine on macOS

Podman containers on macOS run inside a Linux VM. Mount the **VM's** rootless socket into the dashboard. The macOS forwarding socket shown by `podman info` or `podman system connection list` cannot be bind mounted into another container as a working Unix socket; doing so can produce `ECONNREFUSED` even when the file exists.

```sh
machine_uid=$(podman machine ssh -- id -u)
machine_gid=$(podman machine ssh -- id -g)
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

Open <http://127.0.0.1:3030>. The Quadlet mount uses Podman machine's usual user directory. If your Quadlet files are elsewhere, run `podman machine ssh -- podman quadlet list --format json` to find their paths, then mount the containing directories and set `QUADLET_DIRS` as described above. The Linux example's `$XDG_RUNTIME_DIR` and `$HOME` paths refer to the machine running the command; on macOS those are not the VM's paths.

The Podman socket grants broad control over the host's containers. Keep the web port bound to loopback and use a trusted local browser or an authenticated reverse proxy if remote access is needed. The app has no built in user authentication.

## Local development

Node.js 22 or newer is required. There are no npm dependencies.

```sh
PODMAN_SOCKET="$XDG_RUNTIME_DIR/podman/podman.sock" QUADLET_DIRS="$HOME/.config/containers/systemd" USER_SYSTEMD_BUS="$XDG_RUNTIME_DIR/bus" QUADLET_WRITE_DIR="$HOME/.config/containers/systemd" npm start
npm test
```

The server listens on `127.0.0.1:3000` by default. Set `HOST` and `PORT` to change this. `QUADLET_DIRS` defaults to `/quadlets`; when the directory is absent, the UI explains how to mount it. `USER_SYSTEMD_BUS` defaults to `/run/user/<uid>/bus`; Quadlet administration requires that socket and a non-root process identity. `QUADLET_WRITE_DIR` must match one of the mounted `QUADLET_DIRS`. A `GET /api/health` endpoint checks Podman socket connectivity. The server uses Podman's reported API version for Libpod requests.

## CI and container images

Every push to `main` runs the test suite. If it passes, [the publish workflow](.github/workflows/publish.yml) builds the `Containerfile` for Linux `amd64` and `arm64` and pushes both platforms to GitHub Container Registry unless the push changes only `README.md` or files under `docs/`. Documentation-only pushes still run tests but skip the image build and publish job. Published images are tagged as:

- `ghcr.io/deversmann/podmanman:latest`
- `ghcr.io/deversmann/podmanman:sha-<full-commit-sha>`

The workflow uses GitHub's `GITHUB_TOKEN` with `packages: write` in the publish job, so no registry password or personal access token is needed. Replace `podmanman` in the run examples above with the GHCR image name to use a published build. The package may be private initially; set its visibility in GitHub package settings if you want anonymous pulls.

## Design

The server serves a static browser UI and provides a narrow HTTP API. It proxies selected calls to Podman's Libpod API over the Unix socket. The browser never connects to the socket directly. Inspect responses are reduced to the fields the UI displays, so environment variables and unrelated inspect data are not sent to the browser. The Quadlet inventory reads mounted files and returns selected display keys while omitting environment and credential directives. The server validates container IDs and inputs, checks request origins for state changes, and does not accept arbitrary Podman API paths.

Quadlet creates systemd services, so lifecycle operations go through `systemctl --user` to keep service state and dependencies consistent. The current inventory shows file definitions and links containers by their systemd unit label; it does not infer whether a pod, network, volume, or other resource currently exists. Service start and stop buttons do not show systemd's actual unit state.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Check Podman connectivity |
| `GET /api/containers` | List all containers |
| `GET /api/quadlets` | List mounted Quadlet definitions |
| `POST /api/quadlets` | Add a rootless Quadlet definition to the configured writable directory |
| `DELETE /api/quadlets` | Stop and remove a definition in that directory |
| `POST /api/quadlets/action` | Start or stop a mounted rootless Quadlet service |
| `GET /api/containers/:id` | Get display safe inspect details |
| `GET /api/containers/:id/logs` | Get recent logs |
| `POST /api/containers` | Create and start a direct container |
| `GET /api/containers/:id/quadlet-draft` | Generate a reviewable Quadlet draft without exposing environment values |
| `POST /api/containers/:id/quadlet-cutover` | Stop the original and start a saved rootless Quadlet, restarting the original on failure |
| `DELETE /api/containers/:id` | Remove a stopped direct container |
| `POST /api/containers/:id/start` | Start a directly managed container |
| `POST /api/containers/:id/stop` | Stop a directly managed container |
| `POST /api/containers/:id/restart` | Restart a directly managed container |

Podman API and Quadlet behavior are documented in the [Podman API reference](https://docs.podman.io/en/latest/_static/api.html), [Podman system service guide](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html), and [Quadlet guide](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).
