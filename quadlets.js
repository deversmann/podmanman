import fs from 'node:fs/promises';
import path from 'node:path';

const kinds = new Set(['container', 'pod', 'network', 'volume', 'image', 'build', 'artifact', 'kube']);
const fieldsByKind = {
  container: ['Image', 'ContainerName', 'Pod', 'Network', 'PublishPort', 'AutoUpdate'],
  pod: ['PodName', 'Network', 'PublishPort'],
  network: ['NetworkName', 'Driver', 'Subnet', 'Gateway'],
  volume: ['VolumeName', 'Driver', 'Device'],
  image: ['Image', 'ImageTag'],
  build: ['ImageTag', 'File', 'SetWorkingDirectory'],
  artifact: ['Artifact'],
  kube: ['Yaml', 'Network', 'PublishPort', 'AutoUpdate']
};

function sectionsFrom(text) {
  const sections = new Map();
  let section;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading) {
      section = heading[1];
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (!section || separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    const values = sections.get(section).get(key) || [];
    values.push(value);
    sections.get(section).set(key, values);
  }
  return sections;
}

function first(section, key) {
  return section?.get(key)?.[0] || null;
}

function serviceName(kind, base, section) {
  const override = first(section, 'ServiceName');
  return `${override || (kind === 'container' || kind === 'kube' ? base : `${base}-${kind}`)}.service`;
}

export function parseQuadlet(file, content, id = file) {
  const kind = path.extname(file).slice(1);
  if (!kinds.has(kind)) return null;
  const name = path.basename(file);
  const base = name.slice(0, -(kind.length + 1));
  const sections = sectionsFrom(content);
  const body = sections.get(kind[0].toUpperCase() + kind.slice(1));
  const unit = sections.get('Unit');
  const fields = [];
  for (const key of fieldsByKind[kind]) {
    for (const value of body?.get(key) || []) {
      fields.push({ label: key, value: value.slice(0, 256) });
    }
  }
  return {
    id,
    name,
    kind,
    path: file,
    service: serviceName(kind, base, body),
    description: first(unit, 'Description')?.slice(0, 256) || '',
    fields
  };
}

async function visit(directory, root, rootIndex, output, depth = 0) {
  if (depth > 12) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(file, root, rootIndex, output, depth + 1);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const kind = path.extname(entry.name).slice(1);
    if (!kinds.has(kind)) continue;
    const real = await fs.realpath(file).catch(() => null);
    if (!real || (real !== root && !real.startsWith(`${root}${path.sep}`))) continue;
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 128 * 1024) continue;
    const content = await fs.readFile(real, 'utf8');
    const item = parseQuadlet(file, content, `${rootIndex}:${path.relative(root, file)}`);
    if (item) output.push(item);
  }
}

export async function listQuadlets(directories = (process.env.QUADLET_DIRS || '/quadlets').split(path.delimiter)) {
  const definitions = [];
  const mounted = [];
  for (const [index, directory] of directories.entries()) {
    if (!directory) continue;
    let real;
    try { real = await fs.realpath(directory); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) continue;
    mounted.push(directory);
    await visit(real, real, index, definitions);
  }
  definitions.sort((a, b) => a.name.localeCompare(b.name));
  return { configured: mounted.length > 0, directories: mounted, definitions };
}
