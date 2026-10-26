const safeValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
const safePath = value => safeValue(value) && /^\/[A-Za-z0-9_./@+-]*$/.test(value);
const safeVolume = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

function publishedPorts(data, warnings) {
  const bindings = data.NetworkSettings?.Ports || data.HostConfig?.PortBindings || {};
  const ports = [];
  for (const [container, hosts] of Object.entries(bindings)) {
    if (hosts == null || (Array.isArray(hosts) && hosts.length === 0)) continue;
    const match = /^(\d{1,5})\/(tcp|udp)$/.exec(container);
    if (!match || !Array.isArray(hosts)) { warnings.push('Some port bindings need manual review.'); continue; }
    for (const host of hosts) {
      const port = Number(host?.HostPort);
      const containerPort = Number(match[1]);
      const ip = host?.HostIp || '';
      if (!Number.isInteger(port) || port < 1 || port > 65535 || containerPort < 1 || containerPort > 65535 || (ip && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))) {
        warnings.push('Some port bindings need manual review.');
        continue;
      }
      ports.push(`${ip ? `${ip}:` : ''}${port}:${containerPort}/${match[2]}`);
    }
  }
  return [...new Set(ports)];
}

function volumeLines(data, warnings) {
  const mounts = [];
  for (const mount of data.Mounts || []) {
    if (!['bind', 'volume'].includes(mount.Type)) { warnings.push('A nonstandard mount was not copied.'); continue; }
    const source = mount.Type === 'volume' ? mount.Name : mount.Source;
    const destination = mount.Destination;
    if (!(mount.Type === 'volume' ? safeVolume(source) : safePath(source)) || !safePath(destination)) {
      warnings.push('A mount with an unsupported path or name was not copied.');
      continue;
    }
    const options = Array.isArray(mount.Options) ? mount.Options : [];
    if (options.some(option => !['ro', 'rw'].includes(option))) warnings.push('Review mount options such as SELinux labels or propagation; only read-only mode was copied.');
    mounts.push(`${source}:${destination}${mount.RW === false || options.includes('ro') ? ':ro' : ''}`);
  }
  return [...new Set(mounts)];
}

export function createQuadletDraft(data) {
  if (data.Pod) throw new Error('Containers in a Pod need a coordinated Pod and container Quadlet conversion.');
  const name = String(data.Name || '').replace(/^\//, '');
  const image = data.ImageName || data.Config?.Image;
  if (!safeValue(image) || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(image)) throw new Error('The container has no usable image name for a Quadlet draft.');
  const base = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name) ? name : `container-${String(data.Id || '').slice(0, 12)}`;
  const warnings = [];
  const ports = publishedPorts(data, warnings);
  const volumes = volumeLines(data, warnings);
  if (data.Config?.Env?.length) warnings.push('Environment values were omitted. Review custom variables and add them securely before switching.');
  if (data.Config?.Cmd?.length || data.Config?.Entrypoint?.length) warnings.push('Review command and entrypoint overrides against the image defaults; they were not copied.');
  if (data.HostConfig?.RestartPolicy?.Name && data.HostConfig.RestartPolicy.Name !== 'no') warnings.push('Review the restart policy; Quadlet service restart behavior may differ.');
  if (data.HostConfig?.NetworkMode && !['', 'default', 'bridge', 'slirp4netns', 'pasta'].includes(data.HostConfig.NetworkMode)) warnings.push('Review the network configuration; custom networking was not copied.');
  warnings.push('Review user, health checks, security settings, devices, and other options before switching.');
  const content = ['[Unit]', `Description=Converted from ${base}`, '', '[Container]', `Image=${image}`, 'Pull=never', ...ports.map(port => `PublishPort=${port}`), ...volumes.map(volume => `Volume=${volume}`), '', '[Service]', 'Restart=on-failure', ''].join('\n');
  return { name: `${base}.container`, content, warnings: [...new Set(warnings)] };
}
