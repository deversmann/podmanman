import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listQuadlets } from './quadlets.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const socketPath = process.env.PODMAN_SOCKET || '/run/podman/podman.sock';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const maxResponseBytes = 2 * 1024 * 1024;
const actions = new Set(['start', 'stop', 'restart']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let apiVersionPromise;

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
    pod: item.Pod || null,
    systemdUnit,
    source: systemdUnit ? 'systemd' : 'podman'
  };
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

export function podmanRequest(apiPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: apiPath, method, timeout: 10000 }, response => {
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
    request.end();
  });
}

async function libpodRequest(apiPath, method = 'GET') {
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
  return podmanRequest(`/v${version}/libpod${apiPath}`, method);
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

function podmanError(result) {
  try { return JSON.parse(result.body).message || `Podman returned ${result.status}`; }
  catch { return `Podman returned ${result.status}`; }
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
    return json(response, 200, await listQuadlets());
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
      return json(response, 200, { containers: list.map(normalizeContainer) });
    } catch { return json(response, 502, { error: 'Podman returned invalid container data' }); }
  }

  const match = /^\/api\/containers\/([^/]+)(?:\/(logs|start|stop|restart))?$/.exec(url.pathname);
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
  if (request.method === 'POST' && actions.has(operation)) {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
      return json(response, 403, { error: 'Cross-origin requests are not allowed' });
    }
    const current = await inspect(id);
    if (current.error) return json(response, current.status, { error: current.error });
    if (isSystemdManaged(current.data)) return json(response, 409, { error: 'This container is managed by systemd. Use its service unit for lifecycle actions.' });
    const result = await libpodRequest(`/containers/${id}/${operation}`, 'POST');
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
      if (error.code === 'ECONNREFUSED') message = `Podman socket at ${socketPath} refused the connection. Check that the mounted socket is active on this host or Podman machine.`;
      if (error.code === 'ENOENT' || error.code === 'EACCES') message = `Cannot access Podman socket at ${socketPath} (${error.code}).`;
      json(response, 503, { error: message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, host, () => console.log(`Podmanman listening on http://${host}:${port}`));
}
