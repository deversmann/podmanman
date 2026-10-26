const imagePattern = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const volumePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function lines(value, label) {
  if (value == null || value === '') return [];
  if (typeof value !== 'string' || value.length > 2000) throw new Error(`${label} is too long.`);
  const entries = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (entries.length > 20) throw new Error(`${label} is limited to 20 entries.`);
  return entries;
}

export function createContainerSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid container settings.');
  const image = typeof input.image === 'string' ? input.image.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!imagePattern.test(image)) throw new Error('Enter a valid image name already available in Podman.');
  if (input.name != null && typeof input.name !== 'string') throw new Error('Invalid container name.');
  if (name && !namePattern.test(name)) throw new Error('Container name may use letters, numbers, dots, underscores, and hyphens.');
  const spec = { image, portmappings: [], mounts: [], volumes: [] };
  if (name) spec.name = name;

  for (const line of lines(input.ports, 'Ports')) {
    const match = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(line);
    if (!match) throw new Error(`Invalid port mapping: ${line}`);
    const hostPort = Number(match[1]);
    const containerPort = Number(match[2]);
    if (hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535) throw new Error(`Port is out of range: ${line}`);
    spec.portmappings.push({ host_port: hostPort, container_port: containerPort, protocol: match[3] || 'tcp', host_ip: '127.0.0.1' });
  }

  for (const line of lines(input.mounts, 'Mounts')) {
    const match = /^([^:\s]+):(\/[^:\s]*)(?::(ro|rw))?$/.exec(line);
    if (!match) throw new Error(`Invalid mount: ${line}`);
    const [, source, destination, mode = 'rw'] = match;
    const options = mode === 'ro' ? ['ro'] : [];
    if (source.startsWith('/')) spec.mounts.push({ type: 'bind', source, destination, options });
    else if (volumePattern.test(source)) spec.volumes.push({ Name: source, Dest: destination, Options: options });
    else throw new Error(`Invalid volume name: ${source}`);
  }
  return spec;
}
