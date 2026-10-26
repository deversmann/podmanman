import fs from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseQuadlet } from './quadlets.js';

const execute = promisify(execFile);
const quadletName = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.(container|pod|network|volume|image|build|artifact|kube)$/;
const serviceName = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/;

function adminError(status, message) {
  return Object.assign(new Error(message), { status });
}

function busPath() {
  return process.env.USER_SYSTEMD_BUS || `/run/user/${process.getuid?.()}/bus`;
}

export function userManagerAvailable() {
  if (!process.getuid || process.getuid() === 0) return false;
  try {
    if (!statSync(busPath()).isSocket()) return false;
    accessSync(process.env.SYSTEMCTL_PATH || '/bin/systemctl', constants.X_OK);
    return true;
  } catch { return false; }
}

export async function writableQuadletDir(inventory) {
  const configured = process.env.QUADLET_WRITE_DIR;
  if (!configured || !userManagerAvailable()) return null;
  try {
    const directory = await fs.realpath(configured);
    const roots = await Promise.all(inventory.directories.map(root => fs.realpath(root)));
    if (!roots.includes(directory)) return null;
    if (!(await fs.stat(directory)).isDirectory()) return null;
    await fs.access(directory, constants.W_OK);
    return directory;
  } catch { return null; }
}

export async function canRemoveQuadlet(item, directory) {
  if (!directory || path.dirname(await fs.realpath(item.path).catch(() => '')) !== directory) return false;
  try { return (await fs.lstat(item.path)).isFile(); }
  catch { return false; }
}

export async function runUserSystemctl(args, acceptedExitCodes = []) {
  if (!userManagerAvailable()) throw new Error('Rootless systemd access is not configured. Mount the user bus and run as its owner.');
  const bus = busPath();
  const env = { ...process.env, XDG_RUNTIME_DIR: path.dirname(bus), DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
  try {
    return await execute(process.env.SYSTEMCTL_PATH || '/bin/systemctl', ['--user', ...args], { env, timeout: 180000, maxBuffer: 64 * 1024 });
  } catch (error) {
    if (acceptedExitCodes.includes(error.code)) return { stdout: error.stdout || '', stderr: error.stderr || '' };
    throw new Error((error.stderr || error.message || 'systemctl failed').trim().slice(0, 500));
  }
}

async function isGeneratedQuadletService(service) {
  const { stdout } = await runUserSystemctl(['show', '-p', 'FragmentPath', '--value', service]);
  const fragment = stdout.trim();
  const generatorRoot = path.join(path.dirname(busPath()), 'systemd');
  return path.basename(fragment) === service && ['generator', 'generator.early', 'generator.late'].some(name => path.dirname(fragment) === path.join(generatorRoot, name));
}

export async function controlQuadlet(item, action) {
  if (!serviceName.test(item.service) || !['start', 'stop'].includes(action)) throw adminError(400, 'Invalid Quadlet service');
  if (!await isGeneratedQuadletService(item.service)) throw adminError(409, 'This service is not a generated rootless Quadlet unit.');
  await runUserSystemctl([action, item.service]);
}

export async function enableQuadletOnLogin(item, directory) {
  if (!await canRemoveQuadlet(item, directory)) throw adminError(403, 'This Quadlet file is outside the writable directory.');
  const original = await fs.readFile(item.path, 'utf8');
  if (/^\[Install\]\s*$/m.test(original)) return;
  await fs.writeFile(item.path, `${original.trimEnd()}\n\n[Install]\nWantedBy=default.target\n`);
  try { await runUserSystemctl(['daemon-reload']); }
  catch (error) {
    await fs.writeFile(item.path, original);
    await runUserSystemctl(['daemon-reload']).catch(() => {});
    throw error;
  }
}

export async function addQuadlet(inventory, name, content) {
  const directory = await writableQuadletDir(inventory);
  if (!directory) throw adminError(503, 'A writable rootless Quadlet directory and user systemd bus are required.');
  if (typeof name !== 'string' || !quadletName.test(name)) throw adminError(400, 'Enter a valid Quadlet filename, such as web.container.');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 32 * 1024 || content.includes('\0')) throw adminError(400, 'Quadlet contents must be between 1 byte and 32 KB.');
  const kind = path.extname(name).slice(1);
  if (!new RegExp(`^\\[${kind[0].toUpperCase()}${kind.slice(1)}\\]\\r?$`, 'm').test(content)) throw adminError(400, `The file needs a [${kind[0].toUpperCase()}${kind.slice(1)}] section.`);
  const parsed = parseQuadlet(name, content);
  if (!parsed || !serviceName.test(parsed.service)) throw adminError(400, 'Invalid Quadlet service name.');
  if (inventory.definitions.some(item => item.service === parsed.service)) throw adminError(409, 'A Quadlet already uses this service name.');
  const file = path.join(directory, name);
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('A file with that name already exists.'), { status: 409 }); throw error; }
  try {
    await handle.writeFile(content);
  } catch (error) {
    await handle.close();
    await fs.rm(file, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await runUserSystemctl(['daemon-reload']);
    const { stdout } = await runUserSystemctl(['show', '-p', 'LoadState', '--value', parsed.service]);
    if (stdout.trim() !== 'loaded' || !await isGeneratedQuadletService(parsed.service)) throw adminError(422, `Quadlet did not generate ${parsed.service}. Check its syntax and referenced files.`);
  } catch (error) {
    await fs.rm(file, { force: true });
    await runUserSystemctl(['daemon-reload']).catch(() => {});
    throw error;
  }
  return parsed;
}

export async function removeQuadlet(item, directory) {
  if (!await canRemoveQuadlet(item, directory)) throw adminError(403, 'This Quadlet file is outside the writable directory.');
  if (!serviceName.test(item.service)) throw adminError(400, 'Invalid Quadlet service name.');
  if (await isGeneratedQuadletService(item.service)) {
    const { stdout } = await runUserSystemctl(['is-active', item.service], [3, 4]);
    if (['active', 'activating', 'reloading'].includes(stdout.trim())) await runUserSystemctl(['stop', item.service]);
  }
  const content = await fs.readFile(item.path);
  await fs.unlink(item.path);
  try {
    await runUserSystemctl(['daemon-reload']);
  } catch (error) {
    await fs.writeFile(item.path, content, { flag: 'wx', mode: 0o600 });
    await runUserSystemctl(['daemon-reload']).catch(() => {});
    throw error;
  }
}
