# User guide

[Back to README](../README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md)

## Navigate the dashboard

The **Containers** and **Quadlets** tabs have shareable `#containers` and `#quadlets` URLs. Both tables support search and sorting: click a heading to sort by that column, then click it again to reverse the direction. The Containers tab also filters by all, running, or stopped containers. Data refreshes every 15 seconds, and **Refresh** updates it on demand.

Each table has its own **Columns** menu. Show or hide columns such as **Volume mounts**; the Quadlet table also offers an optional **Ports** column. Column choices are saved in the browser separately for each table, with at least one data column always visible. Turning on mounts makes Podmanman inspect existing containers during refresh, so that view performs additional Podman API requests.

## Direct containers

The Containers tab lists Podman containers that are not marked as systemd managed, including stopped ones. Open a row to see its state, image, ID, ports, inspect details, and the latest 200 log lines. Available actions are:

- **Start**, **Stop**, and **Restart** through the connected Podman socket.
- **Remove** for a stopped direct container. This removes the container but keeps its image and volumes.
- **Launch container** from an image available in the connected Podman store. The form accepts an optional name, one `host:container[/tcp|udp]` port mapping per line, and one `source:/destination[:ro]` mount per line. Published ports bind to `127.0.0.1` on the Podman host. A mount source can be a named volume or an absolute path on that host.
- **Convert to Quadlet**, described [below](#convert-a-container-to-a-quadlet).

Containers labeled with a systemd unit are shown with Quadlet and systemd resources instead. Their container detail view points to the service; lifecycle actions belong to systemd so it can track the workload correctly.

## Quadlets and systemd resources

The Quadlets tab reads mounted definitions for containers, pods, networks, volumes, images, builds, artifacts, and Kubernetes deployments. A definition remains visible even before its service creates a Podman resource. A linked running container's actual name appears in the row, with the definition filename beneath it. The detail view shows the source file, inferred service name, description, selected declared fields, and linked containers.

The optional **Ports** column shows runtime ports for linked containers, falling back to declared `PublishPort=` entries. **Volume mounts** shows actual linked-container mounts when available, or declared `Volume=` and `Mount=` entries before a container exists. Named volumes are shown by name. Other resource types show a dash if they declare no container mounts.

When the rootless user bus is available, the detail view can **Start** or **Stop** a mounted service generated from a Quadlet. With a configured writable directory, **Add Quadlet** saves source text as a new top-level definition, reloads the user manager, and checks that it generated a service. **Remove Quadlet** stops an active service, deletes its definition, and reloads the manager. Definitions outside that writable directory cannot be removed in the UI. See [access modes](configuration.md#access-modes) for setup.

A systemd managed container with no mounted source definition still appears as a detected unit. Mount its Quadlet path to view the file and use definition controls. The table does not show the actual systemd unit state; it shows linked Podman container state where available.

## Convert a container to a Quadlet

**Convert to Quadlet** is available for a direct container when the writable rootless Quadlet directory, user systemd bus, and Podman socket belong to the same non-root user. Containers in a Pod are excluded because they need a coordinated Pod conversion.

1. Open the container detail and choose **Convert to Quadlet**. Podmanman drafts a `.container` file from the image, published ports, and supported bind or named-volume mounts. It uses `Pull=never` and Quadlet's generated container name, avoiding a collision with the original container.
2. Review the editable draft and its warnings. Environment values are never copied into the browser draft. Command and entrypoint overrides, custom networking, security options, health checks, and other advanced settings may need manual translation. Port or mount forms that cannot be translated are flagged. Check that the replacement will use the intended data and image before proceeding.
3. Choose **Save draft**. This creates and validates the Quadlet, but leaves the original container running. The generated draft has no automatic startup setting at this stage.
4. Choose **Switch to Quadlet** when ready for a brief interruption. Podmanman stops the original, starts the Quadlet service, and verifies that the service is active. On success, it adds `[Install]` with `WantedBy=default.target` for future user sessions when the definition has no `[Install]` section. If the switch fails, it attempts to stop the new service and restart the original.
5. Verify the replacement, then choose **Remove original** if it is no longer needed. Until then, the original remains stopped and available for recovery. Its image and volumes are retained when the container is removed.

A saved draft can be started later from the Quadlets tab, but that separate action does not perform the guided cutover or add the default startup setting. If you close the conversion dialog before switching, stop the original and review the saved definition before starting its service.

## Planned features

- Edit existing user-space Quadlet definitions.
- Explore read-only views of rootful containers and Quadlets.
