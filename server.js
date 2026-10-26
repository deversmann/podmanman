import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listQuadlets } from './quadlets.js';
import { addQuadlet, canRemoveQuadlet, controlQuadlet, enableQuadletOnLogin, removeQuadlet, runUserSystemctl, userManagerAvailable, writableQuadletDir } from './quadlet-admin.js';
import { createContainerSpec } from './container-admin.js';
import { createQuadletDraft } from './container-conversion.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const socketPath = process.env.PODMAN_SOCKET || '/run/podman/podman.sock';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const maxResponseBytes = 2 * 1024 * 1024;
const maxRequestBytes = 40 * 1024;
const actions = new Set(['start', 'stop', 'restart']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let apiVersionPromise;
const cutovers = new Set();

export function isContainerId(value) {
  return /^[a-f0-9]{12,64}$/i.test(value);
}

export function normalizeContainer(item) {
  const labels = item.Labels || {};
  const systemdUnit = labels.PODMAN_SYSTEMD_UNIT || labels['io.containers.systemd.unit'] || null;
  return {
    id: item.Id || item.ID || '',
    name: (Array.isArray(item.Names) ? item.Names[0] : item.Names) || item.Name || '',
    image: item.Image || '',
    state: item.State || 'unknown',
    status: item.Status || '',
    created: item.Created || null,
    ports: item.Ports || [],
    mounts: null,
    pod: item.Pod || null,
    systemdUnit,
    source: systemdUnit ? 'systemd' : 'podman'
  };
}

export function normalizeMounts(mounts) {
  if (!Array.isArray(mounts)) return [];
  return mounts.map(mount => ({
    type: mount.Type || '',
    source: mount.Name || mount.Source || '',
    destination: mount.Destination || ''
  })).filter(mount => mount.source || mount.destination);
}

export function decodeLogStream(buffer) {
  if (buffer.length < 8 || ![0, 1, 2].includes(buffer[0]) || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
    return buffer.toString('utf8');
  }
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    if (![0, 1, 2].includes(buffer[offset]) || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) break;
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return offset === buffer.length ? Buffer.concat(chunks).toString('utf8') : buffer.toString('utf8');
}

export function podmanRequest(apiPath, method = 'GET', body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = payload == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const request = http.request({ socketPath, path: apiPath, method, headers, timeout: timeoutMs }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          response.destroy(new Error('Podman response exceeded 2 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: response.statusCode, body: raw.toString('utf8'), raw });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Podman request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function libpodRequest(apiPath, method = 'GET', body, timeoutMs = 10000) {
  if (!apiVersionPromise) {
    apiVersionPromise = podmanRequest('/version').then(result => {
      if (result.status !== 200) throw new Error(`Podman version request returned ${result.status}`);
      const data = JSON.parse(result.body);
      const version = data.Components?.find(component => component.Name === 'Podman Engine')?.Details?.APIVersion || data.APIVersion || data.ApiVersion;
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(version || '')) throw new Error('Podman returned an invalid API version');
      return version;
    }).catch(error => { apiVersionPromise = undefined; throw error; });
  }
  const version = await apiVersionPromise;
  return podmanRequest(`/v${version}/libpod${apiPath}`, method, body, timeoutMs);
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

function podmanError(result) {
  try { return JSON.parse(result.body).message || `Podman returned ${result.status}`; }
  catch { return `Podman returned ${result.status}`; }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
    throw httpError(403, 'Cross-origin requests are not allowed');
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, 'JSON content type is required');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) throw httpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON body'); }
}

async function inspect(id) {
  const result = await libpodRequest(`/containers/${id}/json`);
  if (result.status >= 400) return { error: podmanError(result), status: result.status === 404 ? 404 : 502 };
  try { return { data: JSON.parse(result.body) }; }
  catch { return { error: 'Podman returned invalid container data', status: 502 }; }
}

function isSystemdManaged(data) {
  const labels = data?.Config?.Labels || data?.Labels || {};
  return Boolean(labels.PODMAN_SYSTEMD_UNIT || labels['io.containers.systemd.unit']);
}

function sameUserPodmanSocket() {
  try { return process.getuid?.() !== 0 && fs.statSync(socketPath).uid === process.getuid(); }
  catch { return false; }
}

function publicInspect(data) {
  const labels = data?.Config?.Labels || data?.Labels || {};
  return {
    Id: data.Id,
    Name: data.Name,
    ImageName: data.ImageName || data.Config?.Image,
    Created: data.Created,
    State: {
      Status: data.State?.Status,
      StartedAt: data.State?.StartedAt,
      ExitCode: data.State?.ExitCode
    },
    Config: { Labels: {
      PODMAN_SYSTEMD_UNIT: labels.PODMAN_SYSTEMD_UNIT,
      'io.containers.systemd.unit': labels['io.containers.systemd.unit']
    } }
  };
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/quadlets') {
    const inventory = await listQuadlets();
    const directory = await writableQuadletDir(inventory);
    const definitions = await Promise.all(inventory.definitions.map(async item => ({ ...item, canRemove: await canRemoveQuadlet(item, directory) })));
    return json(response, 200, { ...inventory, definitions, canControl: userManagerAvailable(), canAdd: Boolean(directory), canConvert: Boolean(directory && sameUserPodmanSocket()) });
  }
  if (url.pathname === '/api/quadlets' && request.method === 'POST') {
    checkOrigin(request);
    const input = await readJson(request);
    if (!input || typeof input !== 'object') throw httpError(400, 'Invalid Quadlet settings');
    await addQuadlet(await listQuadlets(), input.name, input.content);
    const inventory = await listQuadlets();
    const directory = await writableQuadletDir(inventory);
    const item = inventory.definitions.find(definition => definition.name === input.name && path.dirname(definition.path) === directory);
    if (!item) throw httpError(503, 'Quadlet was saved, but its definition could not be found after reload.');
    return json(response, 201, { item });
  }
  if (url.pathname === '/api/quadlets' && request.method === 'DELETE') {
    checkOrigin(request);
    const input = await readJson(request);
    if (!input || typeof input !== 'object') throw httpError(400, 'Invalid Quadlet settings');
    const inventory = await listQuadlets();
    const item = inventory.definitions.find(definition => definition.id === input.id);
    if (!item) return json(response, 404, { error: 'Quadlet definition not found' });
    if (inventory.definitions.filter(definition => definition.service === item.service).length !== 1) return json(response, 409, { error: 'Multiple Quadlets use this service name' });
    await removeQuadlet(item, await writableQuadletDir(inventory));
    return json(response, 200, { ok: true });
  }
  if (url.pathname === '/api/quadlets/action' && request.method === 'POST') {
    checkOrigin(request);
    const input = await readJson(request);
    if (!input || !['start', 'stop'].includes(input.action)) throw httpError(400, 'Invalid Quadlet action');
    const inventory = await listQuadlets();
    const item = inventory.definitions.find(definition => definition.id === input.id);
    if (!item) return json(response, 404, { error: 'Quadlet definition not found' });
    if (inventory.definitions.filter(definition => definition.service === item.service).length !== 1) return json(response, 409, { error: 'Multiple Quadlets use this service name' });
    await controlQuadlet(item, input.action);
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const result = await podmanRequest('/_ping');
    return json(response, result.status === 200 ? 200 : 502, { connected: result.status === 200 });
  }
  if (request.method === 'GET' && url.pathname === '/api/containers') {
    const result = await libpodRequest('/containers/json?all=true');
    if (result.status >= 400) return json(response, 502, { error: podmanError(result) });
    try {
      const list = JSON.parse(result.body);
      if (!Array.isArray(list)) throw new Error('Expected a container list');
      const containers = list.map(normalizeContainer);
      if (url.searchParams.get('mounts') === 'true') {
        // Inspect is needed for source and destination; list summaries only contain mount strings.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, containers.length) }, async () => {
          while (next < containers.length) {
            const container = containers[next++];
            try {
              const result = await inspect(container.id);
              if (result.data) container.mounts = normalizeMounts(result.data.Mounts);
            } catch { /* Keep this row available when its inspect request fails. */ }
          }
        }));
      }
      return json(response, 200, { containers });
    } catch { return json(response, 502, { error: 'Podman returned invalid container data' }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/containers') {
    checkOrigin(request);
    let spec;
    try { spec = createContainerSpec(await readJson(request)); }
    catch (error) { if (error.status) throw error; throw httpError(400, error.message); }
    const created = await libpodRequest('/containers/create', 'POST', spec);
    if (created.status >= 400) return json(response, created.status === 404 ? 422 : 502, { error: podmanError(created) });
    let id;
    try { id = JSON.parse(created.body).Id; }
    catch { /* Fall through to a clear response. */ }
    if (!isContainerId(id)) return json(response, 502, { error: 'Podman created a container but returned no valid ID' });
    const started = await libpodRequest(`/containers/${id}/start`, 'POST');
    if (started.status >= 400) return json(response, 502, { error: `Container was created but could not start: ${podmanError(started)}`, id });
    return json(response, 201, { id });
  }

  const match = /^\/api\/containers\/([^/]+)(?:\/(logs|start|stop|restart|quadlet-draft|quadlet-cutover))?$/.exec(url.pathname);
  if (!match || !isContainerId(match[1])) return json(response, 404, { error: 'Not found' });
  const [, id, operation] = match;
  if (request.method === 'GET' && !operation) {
    const result = await inspect(id);
    return result.error ? json(response, result.status, { error: result.error }) : json(response, 200, { container: publicInspect(result.data) });
  }
  if (request.method === 'GET' && operation === 'logs') {
    const result = await libpodRequest(`/containers/${id}/logs?stdout=true&stderr=true&tail=200`);
    if (result.status >= 400) return json(response, result.status === 404 ? 404 : 502, { error: podmanError(result) });
    return json(response, 200, { logs: decodeLogStream(result.raw) });
  }
  if (request.method === 'GET' && operation === 'quadlet-draft') {
    const current = await inspect(id);
    if (current.error) return json(response, current.status, { error: current.error });
    if (isSystemdManaged(current.data)) return json(response, 409, { error: 'This container is already managed by systemd.' });
    try { return json(response, 200, createQuadletDraft(current.data)); }
    catch (error) { return json(response, 422, { error: error.message }); }
  }
  if (request.method === 'POST' && operation === 'quadlet-cutover') {
    checkOrigin(request);
    const input = await readJson(request);
    if (typeof input?.quadletId !== 'string') throw httpError(400, 'Select a saved Quadlet definition.');
    if (cutovers.has(id)) return json(response, 409, { error: 'A cutover is already in progress for this container.' });
    cutovers.add(id);
    try {
      if (!userManagerAvailable() || !sameUserPodmanSocket()) throw httpError(409, 'Cutover requires a rootless Podman socket and user systemd bus owned by the same user.');
      const current = await inspect(id);
      if (current.error) return json(response, current.status, { error: current.error });
      if (isSystemdManaged(current.data)) return json(response, 409, { error: 'This container is already managed by systemd.' });
      if (current.data.Pod) return json(response, 409, { error: 'Containers in a Pod need a coordinated Pod and container Quadlet conversion.' });
      const state = current.data.State?.Status;
      if (!['running', 'exited', 'created', 'configured', 'stopped'].includes(state)) return json(response, 409, { error: `Stop or unpause the container before switching (current state: ${state || 'unknown'}).` });
      const inventory = await listQuadlets();
      const item = inventory.definitions.find(definition => definition.id === input.quadletId);
      const directory = await writableQuadletDir(inventory);
      if (!item || item.kind !== 'container' || !await canRemoveQuadlet(item, directory)) return json(response, 409, { error: 'Select a rootless container Quadlet in the writable directory.' });
      if (inventory.definitions.filter(definition => definition.service === item.service).length !== 1) return json(response, 409, { error: 'Multiple Quadlets use this service name.' });
      const wasRunning = state === 'running';
      if (wasRunning) {
        try {
          const stopped = await libpodRequest(`/containers/${id}/stop`, 'POST', undefined, 45000);
          if (stopped.status >= 400) throw new Error(podmanError(stopped));
        } catch (error) {
          const latest = await inspect(id).catch(() => ({}));
          if (latest.data?.State?.Status === 'running') return json(response, 502, { error: `Could not stop the original container: ${error.message}. It is still running.` });
          try {
            const restarted = await libpodRequest(`/containers/${id}/start`, 'POST', undefined, 30000);
            if (restarted.status >= 400) throw new Error(podmanError(restarted));
            return json(response, 502, { error: `Could not confirm the original container stopped: ${error.message}. It was restarted.` });
          } catch (restartError) {
            return json(response, 502, { error: `Could not stop the original container: ${error.message}. Restarting it also failed: ${restartError.message}` });
          }
        }
      }
      try {
        await controlQuadlet(item, 'start');
        const { stdout } = await runUserSystemctl(['is-active', item.service], [3, 4]);
        if (stdout.trim() !== 'active') throw new Error(`Service ${item.service} is not active after starting.`);
        await enableQuadletOnLogin(item, directory);
      } catch (error) {
        await controlQuadlet(item, 'stop').catch(() => {});
        if (wasRunning) {
          const restarted = await libpodRequest(`/containers/${id}/start`, 'POST', undefined, 30000);
          if (restarted.status >= 400) return json(response, 502, { error: `Quadlet failed to start: ${error.message}. Restarting the original container also failed: ${podmanError(restarted)}` });
        }
        return json(response, 502, { error: `Quadlet failed to start: ${error.message}. The original container ${wasRunning ? 'was restarted' : 'remains stopped'}.` });
      }
      return json(response, 200, { ok: true, service: item.service, originalId: id, originalRetained: true });
    } finally { cutovers.delete(id); }
  }
  if (request.method === 'DELETE' && !operation) {
    checkOrigin(request);
    const current = await inspect(id);
    if (current.error) return json(response, current.status, { error: current.error });
    if (isSystemdManaged(current.data)) return json(response, 409, { error: 'This container is managed by systemd. Remove its Quadlet definition instead.' });
    if (['running', 'paused', 'restarting'].includes(current.data.State?.Status)) return json(response, 409, { error: 'Stop the container before removing it.' });
    const result = await libpodRequest(`/containers/${id}?force=false&v=false`, 'DELETE');
    if (result.status >= 400) return json(response, result.status === 404 ? 404 : 502, { error: podmanError(result) });
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && actions.has(operation)) {
    checkOrigin(request);
    const current = await inspect(id);
    if (current.error) return json(response, current.status, { error: current.error });
    if (isSystemdManaged(current.data)) return json(response, 409, { error: 'This container is managed by systemd. Use its service unit for lifecycle actions.' });
    const result = await libpodRequest(`/containers/${id}/${operation}`, 'POST', undefined, ['stop', 'restart'].includes(operation) ? 45000 : 10000);
    if (result.status >= 400) return json(response, result.status === 404 ? 404 : 502, { error: podmanError(result) });
    return json(response, 200, { ok: true });
  }
  return json(response, 405, { error: 'Method not allowed' });
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(file)) return json(response, 404, { error: 'Not found' });
      const content = await fs.promises.readFile(path.join(publicDir, file));
      response.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      let message = error.message;
      if (url.pathname.startsWith('/api/containers') || url.pathname === '/api/health') {
        if (error.code === 'ECONNREFUSED') message = `Podman socket at ${socketPath} refused the connection. Check that the mounted socket is active on this host or Podman machine.`;
        if (error.code === 'ENOENT' || error.code === 'EACCES') message = `Cannot access Podman socket at ${socketPath} (${error.code}).`;
      }
      json(response, error.status || 503, { error: message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, host, () => console.log(`Podmanman listening on http://${host}:${port}`));
}
