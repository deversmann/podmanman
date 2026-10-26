import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podmanman-test-'));
const socket = path.join(dir, 'podman.sock');
const quadletDir = path.join(dir, 'quadlets');
const systemctl = path.join(dir, 'systemctl');
const systemctlLog = path.join(dir, 'systemctl.log');
await fs.mkdir(path.join(quadletDir, 'nested'), { recursive: true });
await fs.writeFile(systemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\nif [ "$2" = is-active ]; then if [ "$3" = "$SYSTEMCTL_ACTIVE_SERVICE" ]; then echo active; exit 0; fi; echo inactive; exit 3; fi\nif [ "$2" = start ] && [ "$3" = "$SYSTEMCTL_FAIL_START_SERVICE" ]; then echo "start failed" >&2; exit 1; fi\nif [ "$2" = show ]; then if [ "$4" = FragmentPath ]; then if [ "$6" = "$SYSTEMCTL_UNRELATED_SERVICE" ]; then echo "/usr/lib/systemd/user/$6"; else echo "$(dirname "$USER_SYSTEMD_BUS")/systemd/generator/$6"; fi; elif [ "$6" = "$SYSTEMCTL_REJECT_SERVICE" ]; then echo not-found; else echo loaded; fi; fi\n');
await fs.chmod(systemctl, 0o755);
await fs.writeFile(path.join(quadletDir, 'nested', 'web.container'), '[Unit]\nDescription=Web server\n[Container]\nImage=quay.io/example/web:latest\nPublishPort=8080:80\nVolume=web-data:/data:ro\nMount=type=tmpfs,destination=/cache\nEnvironment=PASSWORD=secret\n');
await fs.writeFile(path.join(quadletDir, 'data.volume'), '[Volume]\nVolumeName=web-data\n');
await fs.writeFile(path.join(quadletDir, 'backbone.network'), '[Network]\nSubnet=10.10.0.0/24\n');
await fs.writeFile(path.join(dir, 'outside.container'), '[Container]\nImage=private\n');
await fs.symlink(path.join(dir, 'outside.container'), path.join(quadletDir, 'outside.container'));
process.env.PODMAN_SOCKET = socket;
process.env.QUADLET_DIRS = quadletDir;
process.env.QUADLET_WRITE_DIR = quadletDir;
process.env.USER_SYSTEMD_BUS = socket;
process.env.SYSTEMCTL_PATH = systemctl;
process.env.SYSTEMCTL_LOG = systemctlLog;
const { createServer, isContainerId, normalizeContainer, normalizeMounts, decodeLogStream } = await import('../server.js');
const { listQuadlets, parseQuadlet } = await import('../quadlets.js');
const { createContainerSpec } = await import('../container-admin.js');
const { createQuadletDraft } = await import('../container-conversion.js');
const id = 'a'.repeat(64);
const managedId = 'b'.repeat(64);
const createdId = 'c'.repeat(64);
const stoppedId = 'd'.repeat(64);
const calls = [];
let createdSpec;
const libpod = '/v6.1.4/libpod';

const fakePodman = http.createServer((request, response) => {
  calls.push(`${request.method} ${request.url}`);
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/_ping') return response.end('OK');
  if (request.url === '/version') return response.end(JSON.stringify({ Components: [{ Name: 'Podman Engine', Details: { APIVersion: '6.1.4' } }] }));
  if (request.url === `${libpod}/containers/json?all=true`) return response.end(JSON.stringify([
    { Id: id, Names: ['web'], Image: 'nginx:latest', State: 'running', Ports: [] },
    { Id: managedId, Names: ['service'], Image: 'redis:latest', State: 'running', Labels: { PODMAN_SYSTEMD_UNIT: 'service.service' } },
    { Id: stoppedId, Names: ['old'], Image: 'alpine:latest', State: 'exited', Ports: [] }
  ]));
  if (request.url === `${libpod}/containers/create` && request.method === 'POST') {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { createdSpec = JSON.parse(Buffer.concat(chunks).toString()); response.statusCode = 201; response.end(JSON.stringify({ Id: createdId })); });
    return;
  }
  if (request.url === `${libpod}/containers/${createdId}/start`) return response.end('{}');
  if (request.url === `${libpod}/containers/${stoppedId}/json`) return response.end(JSON.stringify({ Id: stoppedId, State: { Status: 'exited' }, Config: { Labels: {} } }));
  if (request.url === `${libpod}/containers/${stoppedId}?force=false&v=false` && request.method === 'DELETE') return response.end('{}');
  if (request.url === `${libpod}/containers/${id}/json`) return response.end(JSON.stringify({ Id: id, Name: '/web', State: { Status: 'running' }, Mounts: [{ Type: 'volume', Name: 'web-data', Source: '/home/user/.local/share/containers/storage/volumes/web-data/_data', Destination: '/data', RW: false }, { Type: 'bind', Source: '/home/user/config', Destination: '/config' }], NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } }, Config: { Image: 'nginx:latest', Env: ['PASSWORD=secret'], Labels: {} } }));
  if (request.url === `${libpod}/containers/${managedId}/json`) return response.end(JSON.stringify({ Id: managedId, Name: '/service', State: { Status: 'running' }, Config: { Labels: { PODMAN_SYSTEMD_UNIT: 'service.service' } } }));
  if (request.url === `${libpod}/containers/${id}/logs?stdout=true&stderr=true&tail=200`) return response.end('hello\n');
  if (request.url === `${libpod}/containers/${id}/stop`) return response.end('{}');
  if (request.url === `${libpod}/containers/${id}/start`) return response.end('{}');
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

test('ignores image-exposed ports without a host binding in Quadlet drafts', () => {
  const draft = createQuadletDraft({ Name: '/plain', Config: { Image: 'nginx:latest' }, NetworkSettings: { Ports: { '80/tcp': null } } });
  assert.doesNotMatch(draft.content, /PublishPort=/);
  assert.equal(draft.warnings.some(warning => warning.includes('port bindings')), false);
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
  assert.equal(data.containers.length, 3);
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
  assert.equal(web.fields.find(field => field.label === 'PublishPort').value, '8080:80');
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

test('validates a focused launch spec and starts a created container', async () => {
  assert.throws(() => createContainerSpec({ image: 'nginx', ports: '70000:80' }), /out of range/);
  assert.throws(() => createContainerSpec({ image: 'nginx', mounts: '../secret:/secret' }), /Invalid volume name/);
  const invalid = await fetch(`${base}/api/containers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'nginx', ports: '70000:80' }) });
  assert.equal(invalid.status, 400);
  const response = await fetch(`${base}/api/containers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'docker.io/library/nginx:latest', name: 'new-web', ports: '8080:80', mounts: 'data:/data:ro\n/host/config:/config' })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).id, createdId);
  assert.equal(createdSpec.image, 'docker.io/library/nginx:latest');
  assert.deepEqual(createdSpec.portmappings, [{ host_port: 8080, container_port: 80, protocol: 'tcp', host_ip: '127.0.0.1' }]);
  assert.deepEqual(createdSpec.volumes, [{ Name: 'data', Dest: '/data', Options: ['ro'] }]);
  assert.deepEqual(createdSpec.mounts, [{ type: 'bind', source: '/host/config', destination: '/config', options: [] }]);
  assert.ok(calls.includes(`POST ${libpod}/containers/${createdId}/start`));
});

test('removes stopped direct containers, but not running or systemd managed containers', async () => {
  const stopped = await fetch(`${base}/api/containers/${stoppedId}`, { method: 'DELETE' });
  assert.equal(stopped.status, 200);
  assert.ok(calls.includes(`DELETE ${libpod}/containers/${stoppedId}?force=false&v=false`));
  const running = await fetch(`${base}/api/containers/${id}`, { method: 'DELETE' });
  assert.equal(running.status, 409);
  const managed = await fetch(`${base}/api/containers/${managedId}`, { method: 'DELETE' });
  assert.equal(managed.status, 409);
});

test('drafts a Quadlet without secrets and switches with the original retained', async () => {
  const preview = await fetch(`${base}/api/containers/${id}/quadlet-draft`);
  assert.equal(preview.status, 200);
  const draft = await preview.json();
  assert.equal(draft.name, 'web.container');
  assert.match(draft.content, /Image=nginx:latest/);
  assert.match(draft.content, /PublishPort=127\.0\.0\.1:8080:80\/tcp/);
  assert.match(draft.content, /Volume=web-data:\/data:ro/);
  assert.doesNotMatch(draft.content, /WantedBy=default\.target/);
  assert.doesNotMatch(JSON.stringify(draft), /secret/);
  assert.ok(draft.warnings.some(message => message.includes('Environment values')));
  const managed = await fetch(`${base}/api/containers/${managedId}/quadlet-draft`);
  assert.equal(managed.status, 409);

  const saved = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'migrated-web.container', content: draft.content }) });
  assert.equal(saved.status, 201);
  const inventory = await (await fetch(`${base}/api/quadlets`)).json();
  const item = inventory.definitions.find(definition => definition.name === 'migrated-web.container');
  process.env.SYSTEMCTL_ACTIVE_SERVICE = 'migrated-web.service';
  try {
    const switched = await fetch(`${base}/api/containers/${id}/quadlet-cutover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quadletId: item.id }) });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).originalRetained, true);
  } finally { delete process.env.SYSTEMCTL_ACTIVE_SERVICE; }
  assert.ok(calls.includes(`POST ${libpod}/containers/${id}/stop`));
  assert.match(await fs.readFile(systemctlLog, 'utf8'), /--user start migrated-web\.service/);
  assert.match(await fs.readFile(path.join(quadletDir, 'migrated-web.container'), 'utf8'), /WantedBy=default\.target/);
});

test('restarts the original if the replacement Quadlet fails to start', async () => {
  const saved = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'fail.container', content: '[Container]\nImage=alpine\n' }) });
  assert.equal(saved.status, 201);
  const inventory = await (await fetch(`${base}/api/quadlets`)).json();
  const item = inventory.definitions.find(definition => definition.name === 'fail.container');
  const before = calls.filter(call => call === `POST ${libpod}/containers/${id}/start`).length;
  process.env.SYSTEMCTL_FAIL_START_SERVICE = 'fail.service';
  try {
    const switched = await fetch(`${base}/api/containers/${id}/quadlet-cutover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quadletId: item.id }) });
    assert.equal(switched.status, 502);
    assert.match((await switched.json()).error, /original container was restarted/);
  } finally { delete process.env.SYSTEMCTL_FAIL_START_SERVICE; }
  assert.equal(calls.filter(call => call === `POST ${libpod}/containers/${id}/start`).length, before + 1);
});

test('treats an inactive replacement service as a failed cutover', async () => {
  const saved = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'inactive.container', content: '[Container]\nImage=alpine\n' }) });
  assert.equal(saved.status, 201);
  const item = (await saved.json()).item;
  const before = calls.filter(call => call === `POST ${libpod}/containers/${id}/start`).length;
  const switched = await fetch(`${base}/api/containers/${id}/quadlet-cutover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quadletId: item.id }) });
  assert.equal(switched.status, 502);
  assert.match((await switched.json()).error, /not active after starting/);
  assert.equal(calls.filter(call => call === `POST ${libpod}/containers/${id}/start`).length, before + 1);
  assert.doesNotMatch(await fs.readFile(path.join(quadletDir, 'inactive.container'), 'utf8'), /WantedBy=default\.target/);
});

test('adds, controls, and removes only Quadlets in the configured writable directory', async () => {
  const reloadsBefore = (await fs.readFile(systemctlLog, 'utf8')).match(/--user daemon-reload/g)?.length || 0;
  const initial = await (await fetch(`${base}/api/quadlets`)).json();
  assert.equal(initial.canControl, true);
  assert.equal(initial.canAdd, true);
  assert.equal(initial.canConvert, true);
  assert.equal(initial.definitions.find(item => item.name === 'web.container').canRemove, false);
  const invalid = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '../bad.container', content: '[Container]\nImage=alpine\n' }) });
  assert.equal(invalid.status, 400);
  const add = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new.container', content: '[Container]\nImage=alpine\n' }) });
  assert.equal(add.status, 201);
  process.env.SYSTEMCTL_REJECT_SERVICE = 'bad.service';
  try {
    const bad = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bad.container', content: '[Container]\nImage=alpine\n' }) });
    assert.equal(bad.status, 422);
    await assert.rejects(fs.access(path.join(quadletDir, 'bad.container')));
  } finally { delete process.env.SYSTEMCTL_REJECT_SERVICE; }
  const inventory = await (await fetch(`${base}/api/quadlets`)).json();
  const item = inventory.definitions.find(definition => definition.name === 'new.container');
  assert.equal(item.canRemove, true);
  process.env.SYSTEMCTL_UNRELATED_SERVICE = 'new.service';
  try {
    const unrelated = await fetch(`${base}/api/quadlets/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, action: 'start' }) });
    assert.equal(unrelated.status, 409);
  } finally { delete process.env.SYSTEMCTL_UNRELATED_SERVICE; }
  const start = await fetch(`${base}/api/quadlets/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, action: 'start' }) });
  assert.equal(start.status, 200);
  const stop = await fetch(`${base}/api/quadlets/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, action: 'stop' }) });
  assert.equal(stop.status, 200);
  const remove = await fetch(`${base}/api/quadlets`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
  assert.equal(remove.status, 200);
  await assert.rejects(fs.access(path.join(quadletDir, 'new.container')));
  const log = await fs.readFile(systemctlLog, 'utf8');
  assert.ok(log.includes('--user start new.service'));
  assert.ok(log.includes('--user stop new.service'));
  assert.equal(log.match(/--user daemon-reload/g).length - reloadsBefore, 4);
});

test('keeps Quadlet management unavailable without the rootless user bus', async () => {
  const bus = process.env.USER_SYSTEMD_BUS;
  process.env.USER_SYSTEMD_BUS = path.join(dir, 'missing-bus');
  try {
    const inventory = await (await fetch(`${base}/api/quadlets`)).json();
    assert.equal(inventory.canControl, false);
    assert.equal(inventory.canAdd, false);
    const response = await fetch(`${base}/api/quadlets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unavailable.container', content: '[Container]\nImage=alpine\n' }) });
    assert.equal(response.status, 503);
  } finally { process.env.USER_SYSTEMD_BUS = bus; }
});

test('rejects foreign origins and invalid IDs', async () => {
  const foreign = await fetch(`${base}/api/containers/${id}/stop`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
  const invalid = await fetch(`${base}/api/containers/not-an-id/stop`, { method: 'POST' });
  assert.equal(invalid.status, 404);
});
