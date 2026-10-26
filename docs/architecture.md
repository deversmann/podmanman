# Architecture and API

[Back to README](../README.md) · [Development](development.md) · [Configuration](configuration.md)

## How it works

The Node.js server serves the static browser UI and exposes a focused HTTP API. It calls selected Libpod endpoints over the configured Unix socket, using the API version reported by Podman; the browser never connects to Podman directly. The socket determines which Podman container store is visible. The UI places containers carrying a `PODMAN_SYSTEMD_UNIT` or `io.containers.systemd.unit` label in the Quadlets tab and links them to mounted definitions by service name. Podman and Quadlet inventory requests are independent, so mounted definitions can remain visible when the Podman socket is unavailable.

The Quadlet inventory scans mounted directories and returns selected display fields. It omits environment and credential directives. Container inspect responses sent to the browser also omit environment variables and unrelated inspect data. Conversion reads the full inspect result on the server, but sends only an editable draft and warnings, not environment values.

Direct container lifecycle calls go to Podman. Rootless Quadlet lifecycle calls use `systemctl --user` on the mounted user bus, keeping systemd responsible for its generated services. File additions and removals are limited to one configured writable Quadlet directory. Service actions check that the target unit's fragment was generated from a rootless Quadlet; cutover also checks that the Podman socket and user bus belong to the same non-root user.

The server validates container IDs and form inputs, limits JSON request bodies, checks the request `Origin` for state-changing calls, and does not accept arbitrary Podman API paths. These checks are safeguards, not user authentication. Keep access to the web UI and Podman socket restricted as described in [security](configuration.md#security).

The UI does not report the effective systemd unit state or infer whether a non-container Quadlet resource currently exists. It shows definition data and any containers that Podman reports with a matching service label. Conversion checks service activity during cutover, but the regular Quadlets table displays linked container state.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Check Podman socket connectivity |
| `GET /api/containers` | List Podman containers, including systemd managed ones; `?mounts=true` adds inspect-based mount details |
| `POST /api/containers` | Create and start a direct container from validated form settings |
| `GET /api/containers/:id` | Get display-safe inspect details |
| `GET /api/containers/:id/logs` | Get the latest 200 log lines |
| `POST /api/containers/:id/start` | Start a direct container |
| `POST /api/containers/:id/stop` | Stop a direct container |
| `POST /api/containers/:id/restart` | Restart a direct container |
| `DELETE /api/containers/:id` | Remove a stopped direct container, retaining its image and volumes |
| `GET /api/containers/:id/quadlet-draft` | Generate a reviewable Quadlet draft without environment values |
| `POST /api/containers/:id/quadlet-cutover` | Stop the original, start a saved rootless Quadlet, and attempt recovery on failure |
| `GET /api/quadlets` | List mounted definitions and available management capabilities |
| `POST /api/quadlets` | Add and validate a definition in the configured writable directory |
| `POST /api/quadlets/action` | Start or stop a mounted generated rootless service |
| `DELETE /api/quadlets` | Stop and remove a definition from the writable directory |

State-changing routes use JSON bodies where needed and return JSON results or errors. The create-container route creates the Podman object before starting it; if startup fails, the error includes its ID so the created container can be inspected or removed. The [user guide](user-guide.md#convert-a-container-to-a-quadlet) describes the two-stage conversion flow and the retained original container.

For the underlying behavior, see the [Podman API reference](https://docs.podman.io/en/latest/_static/api.html), [Podman system service guide](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html), and [Quadlet guide](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).
