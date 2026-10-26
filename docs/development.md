# Development and releases

[Back to README](../README.md) · [Architecture and API](architecture.md) · [Getting started](getting-started.md)

## Run locally

Podmanman requires Node.js 22 or newer and has no npm dependencies. On a rootless Linux host with the Podman socket and user systemd bus enabled, run:

```sh
PODMAN_SOCKET="$XDG_RUNTIME_DIR/podman/podman.sock" \
QUADLET_DIRS="$HOME/.config/containers/systemd" \
USER_SYSTEMD_BUS="$XDG_RUNTIME_DIR/bus" \
QUADLET_WRITE_DIR="$HOME/.config/containers/systemd" \
npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST` and `PORT` to change this. Omit the Quadlet bus and write directory variables if you only need the inventory. `GET /api/health` checks Podman socket connectivity. See [configuration](configuration.md) for all settings.

Run the test suite with:

```sh
npm test
```

The tests use local fake Podman and systemctl endpoints to exercise container actions, Quadlet administration, conversion, and rollback. They do not require a running Podman machine. The [Containerfile](../Containerfile) packages Node.js and a systemctl client for deployment; use the [getting started guide](getting-started.md) to test the image against a rootless host.

## Project layout

| Path | Role |
| --- | --- |
| [`server.js`](../server.js) | HTTP server, static UI, Podman socket API, and route handling |
| [`container-admin.js`](../container-admin.js) | Container launch input validation and create specification |
| [`container-conversion.js`](../container-conversion.js) | Inspect-to-Quadlet draft generation |
| [`quadlets.js`](../quadlets.js) | Definition discovery and display-safe parsing |
| [`quadlet-admin.js`](../quadlet-admin.js) | Rootless systemd and Quadlet file administration |
| [`public/`](../public/) | Browser UI and styles |
| [`test/`](../test/) | Automated tests |

## CI and published images

Every push to `main` runs `npm test` in [the publish workflow](../.github/workflows/publish.yml). When the push includes application changes, a successful test job builds Linux `amd64` and `arm64` images and publishes them to GitHub Container Registry. Changes limited to `README.md` and `docs/` still run tests, but skip the image build and publish job.

The workflow tags images as:

- `ghcr.io/deversmann/podmanman:latest`
- `ghcr.io/deversmann/podmanman:sha-<full-commit-sha>`

It uses GitHub's `GITHUB_TOKEN` with `packages: write` for publication; no separate registry password is configured. A newly published package may be private. Set its visibility in GitHub package settings if anonymous pulls are needed. To use a published image, substitute its tag for `podmanman` in a [run example](getting-started.md).
