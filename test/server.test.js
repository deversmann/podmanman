import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podmanman-test-'));
const socket = path.join(dir, 'podman.sock');
const quadletDir = path.join(dir, 'quadlets');
await fs.mkdir(path.join(quadletDir, 'nested'), { recursive: true });
await fs.writeFile(path.join(quadletDir, 'nested', 'web.container'), '[Unit]\nDescription=Web server\n[Container]\nImage=quay.io/example/web:latest\nPublishPort=8080:80\nVolume=web-data:/data:ro\nMount=type=tmpfs,destination=/cache\nEnvironment=PASSWORD=secret\n');
await fs.writeFile(path.join(quadletDir, 'data.volume'), '[Volume]\nVolumeName=web-data\n');
await fs.writeFile(path.join(quadletDir, 'backbone.network'), '[Network]\nSubnet=10.10.0.0/24\n');
await fs.writeFile(path.join(dir, 'outside.container'), '[Container]\nImage=private\n');
await fs.symlink(path.join(dir, 'outside.container'), path.join(quadletDir, 'outside.container'));
process.env.PODMAN_SOCKET = socket;
process.env.QUADLET_DIRS = quadletDir;
const { createServer, isContainerId, normalizeContainer, normalizeMounts, decodeLogStream } = await import('../server.js');
const { listQuadlets, parseQuadlet } = await import('../quadlets.js');
const id = 'a'.repeat(64);
const managedId = 'b'.repeat(64);
const calls = [];
const libpod = '/v6.1.4/libpod';

const fakePodman = http.createServer((request, response) => {
  calls.push(`${request.method} ${request.url}`);
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/_ping') return response.end('OK');
  if (request.url === '/version') return response.end(JSON.stringify({ Components: [{ Name: 'Podman Engine', Details: { APIVersion: '6.1.4' } }] }));
  if (request.url === `${libpod}/containers/json?all=true`) return response.end(JSON.stringify([
    { Id: id, Names: ['web'], Image: 'nginx:latest', State: 'running', Ports: [] },
    { Id: managedId, Names: ['service'], Image: 'redis:latest', State: 'running', Labels: { PODMAN_SYSTEMD_UNIT: 'service.service' } }
  ]));
  if (request.url === `${libpod}/containers/${id}/json`) return response.end(JSON.stringify({ Id: id, Name: '/web', State: { Status: 'running' }, Mounts: [{ Type: 'volume', Name: 'web-data', Source: '/home/user/.local/share/containers/storage/volumes/web-data/_data', Destination: '/data' }, { Type: 'bind', Source: '/home/user/config', Destination: '/config' }], Config: { Image: 'nginx:latest', Env: ['PASSWORD=secret'], Labels: {} } }));
  if (request.url === `${libpod}/containers/${managedId}/json`) return response.end(JSON.stringify({ Id: managedId, Name: '/service', State: { Status: 'running' }, Config: { Labels: { PODMAN_SYSTEMD_UNIT: 'service.service' } } }));
  if (request.url === `${libpod}/containers/${id}/logs?stdout=true&stderr=true&tail=200`) return response.end('hello\n');
  if (request.url === `${libpod}/containers/${id}/stop`) return response.end('{}');
  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'no such container' }));
});
await new Promise(resolve => fakePodman.listen(socket, resolve));
const app = createServer();
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

test.after(async () => {
  await new Promise(resolve => app.close(resolve));
  await new Promise(resolve => fakePodman.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

test('validates container IDs and normalizes Podman list output', () => {
  assert.equal(isContainerId(id), true);
  assert.equal(isContainerId('../etc/passwd'), false);
  assert.equal(normalizeContainer({ Id: managedId, Names: ['service'], Labels: { PODMAN_SYSTEMD_UNIT: 'service.service' } }).source, 'systemd');
});

test('decodes Podman framed logs and keeps raw text logs', () => {
  const message = Buffer.from('hello\n');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(message.length, 4);
  assert.equal(decodeLogStream(Buffer.concat([header, message])), 'hello\n');
  assert.equal(decodeLogStream(message), 'hello\n');
});

test('lists CLI and systemd managed containers', async () => {
  const response = await fetch(`${base}/api/containers`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.containers.length, 2);
  assert.equal(data.containers[0].source, 'podman');
  assert.equal(data.containers[1].systemdUnit, 'service.service');
});

test('includes display-safe mount sources and destinations only when requested', async () => {
  assert.deepEqual(normalizeMounts([{ Type: 'volume', Name: 'data', Source: '/private/path', Destination: '/data' }]), [{ type: 'volume', source: 'data', destination: '/data' }]);
  const response = await fetch(`${base}/api/containers?mounts=true`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.containers[0].mounts, [
    { type: 'volume', source: 'web-data', destination: '/data' },
    { type: 'bind', source: '/home/user/config', destination: '/config' }
  ]);
  assert.deepEqual(data.containers[1].mounts, []);
  assert.equal(JSON.stringify(data).includes('secret'), false);
});

test('lists Quadlet containers and resources without requiring a Podman object', async () => {
  const response = await fetch(`${base}/api/quadlets`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, true);
  assert.deepEqual(data.definitions.map(item => item.kind).sort(), ['container', 'network', 'volume']);
  const web = data.definitions.find(item => item.name === 'web.container');
  assert.equal(web.service, 'web.service');
  assert.equal(web.description, 'Web server');
  assert.equal(web.fields.find(field => field.label === 'Image').value, 'quay.io/example/web:latest');
  assert.deepEqual(web.fields.filter(field => ['Volume', 'Mount'].includes(field.label)), [
    { label: 'Volume', value: 'web-data:/data:ro' },
    { label: 'Mount', value: 'type=tmpfs,destination=/cache' }
  ]);
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(JSON.stringify(data).includes('outside.container'), false);
});

test('parses service overrides and returns a clear state for missing mounts', async () => {
  const parsed = parseQuadlet('cache.pod', '[Pod]\nServiceName=cache-stack\nPodName=cache\n');
  assert.equal(parsed.service, 'cache-stack.service');
  assert.equal(parsed.fields[0].value, 'cache');
  const missing = await listQuadlets([path.join(dir, 'missing')]);
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.definitions, []);
});

test('inspect removes environment secrets', async () => {
  const response = await fetch(`${base}/api/containers/${id}`);
  const data = await response.json();
  assert.equal(data.container.Name, '/web');
  assert.equal(JSON.stringify(data).includes('secret'), false);
});

test('starts direct actions and protects systemd managed containers', async () => {
  const direct = await fetch(`${base}/api/containers/${id}/stop`, { method: 'POST' });
  assert.equal(direct.status, 200);
  assert.ok(calls.includes(`POST ${libpod}/containers/${id}/stop`));
  const managed = await fetch(`${base}/api/containers/${managedId}/stop`, { method: 'POST' });
  assert.equal(managed.status, 409);
  assert.equal(calls.includes(`POST ${libpod}/containers/${managedId}/stop`), false);
});

test('rejects foreign origins and invalid IDs', async () => {
  const foreign = await fetch(`${base}/api/containers/${id}/stop`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
  const invalid = await fetch(`${base}/api/containers/not-an-id/stop`, { method: 'POST' });
  assert.equal(invalid.status, 404);
});
