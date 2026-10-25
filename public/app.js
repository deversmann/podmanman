const $ = selector => document.querySelector(selector);
const state = { containers: [], quadlets: [], quadletRows: [], quadletConfigured: null, filter: 'all', query: '', quadletQuery: '', selected: null, loading: false, sort: { containers: { key: 'name', direction: 'asc' }, quadlets: { key: 'name', direction: 'asc' } } };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function setNotice(message) {
  const node = $('#notice');
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

function setConnection(connected) {
  $('#connection-dot').classList.toggle('connected', connected);
  $('#connection-label').textContent = connected ? 'Connected to Podman' : 'Podman unavailable';
}

function stateClass(value) {
  if (value === 'running') return 'running';
  if (['exited', 'stopped', 'created'].includes(value)) return 'stopped';
  return 'other';
}

function sortRows(rows, sort, valueFor) {
  return rows.sort((a, b) => {
    const left = String(valueFor(a, sort.key) || '').trim();
    const right = String(valueFor(b, sort.key) || '').trim();
    if (!left && right) return 1;
    if (left && !right) return -1;
    const comparison = collator.compare(left, right);
    if (comparison) return sort.direction === 'asc' ? comparison : -comparison;
    return collator.compare(String(valueFor(a, 'name') || ''), String(valueFor(b, 'name') || ''));
  });
}

function containerSortValue(item, key) {
  if (key === 'ports') return item.ports?.length ? formatPorts(item.ports) : '';
  if (key === 'source') return 'Podman';
  if (key === 'status') return item.state;
  return item[key];
}

function updateSortHeaders(table) {
  const sort = state.sort[table];
  for (const header of document.querySelectorAll(`#${table} th.sortable`)) {
    const active = header.dataset.sortKey === sort.key;
    header.setAttribute('aria-sort', active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none');
    header.querySelector('.sort-indicator').textContent = active ? sort.direction === 'asc' ? '↑' : '↓' : '';
    const button = header.querySelector('button');
    button.title = `Sort by ${button.firstChild.textContent.trim()} ${active && sort.direction === 'asc' ? 'descending' : 'ascending'}`;
  }
}

function render() {
  const containers = state.containers.filter(item => !item.systemdUnit);
  const running = containers.filter(item => item.state === 'running').length;
  $('#total-count').textContent = containers.length;
  $('#running-count').textContent = running;
  $('#stopped-count').textContent = containers.length - running;
  $('#quadlet-count').textContent = state.quadletConfigured === null && !state.containers.length ? '—' : state.quadletRows.length;
  const filtered = sortRows(containers.filter(item => {
    if (state.filter === 'running' && item.state !== 'running') return false;
    if (state.filter === 'stopped' && item.state === 'running') return false;
    const search = `${item.name} ${item.image} ${item.id}`.toLowerCase();
    return search.includes(state.query);
  }), state.sort.containers, containerSortValue);
  $('#result-count').textContent = `Showing ${filtered.length} of ${containers.length} containers`;
  const body = $('#container-list');
  body.replaceChildren();
  renderQuadlets();
  if (!filtered.length) {
    const row = element('tr');
    const cell = element('td', 'empty', containers.length ? 'No containers match your filters.' : 'No containers found. Create one with Podman and refresh.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of filtered) {
    const row = element('tr');
    const nameCell = element('td');
    const name = element('button', 'name-button', item.name || item.id.slice(0, 12));
    name.type = 'button';
    name.addEventListener('click', () => openDetails(item.id));
    nameCell.append(name, element('span', 'container-id', item.id.slice(0, 12)));
    const image = element('td', 'image-cell', item.image || '—');
    image.title = item.image || '';
    const statusCell = element('td');
    const badge = element('span', `badge ${stateClass(item.state)}`, item.state || 'unknown');
    statusCell.append(badge);
    const source = element('td', 'source', 'Podman');
    const ports = element('td', '', formatPorts(item.ports));
    const viewCell = element('td');
    const view = element('button', 'view-button', 'View →');
    view.type = 'button';
    view.addEventListener('click', () => openDetails(item.id));
    viewCell.append(view);
    row.append(nameCell, image, statusCell, source, ports, viewCell);
    body.append(row);
  }
}

function buildQuadletRows(definitions, containers) {
  const items = [...definitions];
  const known = new Set(definitions.map(item => item.service));
  const linkedByUnit = new Map();
  for (const container of containers) {
    const unit = container.systemdUnit;
    if (!unit) continue;
    if (!linkedByUnit.has(unit)) linkedByUnit.set(unit, []);
    linkedByUnit.get(unit).push(container);
    if (known.has(unit)) continue;
    items.push({
      id: `runtime:${unit}`,
      name: unit,
      kind: 'container',
      path: '',
      service: unit,
      description: 'Detected from a systemd managed container',
      fields: [
        { label: 'ContainerName', value: container.name },
        { label: 'Image', value: container.image }
      ],
      runtimeOnly: true
    });
    known.add(unit);
  }
  return items.map(item => {
    const linked = linkedByUnit.get(item.service) || [];
    const name = linked.length === 1 ? linked[0].name : item.name;
    const secondaryName = linked.length === 1 ? item.name : item.runtimeOnly ? 'Source file not mounted' : item.description || item.path;
    const image = ['container', 'image', 'build'].includes(item.kind)
      ? linked[0]?.image || item.fields.find(field => field.label === 'Image' || field.label === 'ImageTag')?.value || ''
      : '';
    const status = linked.length === 1 ? linked[0].state : linked.length ? `${linked.length} linked` : ['container', 'kube'].includes(item.kind) ? 'No container' : '—';
    return {
      item, linked, name, secondaryName, image, status,
      statusClass: linked.some(container => container.state === 'running') ? 'running' : 'stopped',
      searchText: `${item.name} ${item.kind} ${item.service} ${item.description} ${linked.map(container => container.name).join(' ')}`.toLowerCase()
    };
  });
}

function quadletSortValue(row, key) {
  if (key === 'type') return row.item.kind;
  if (key === 'service') return row.item.service;
  if (key === 'status') return row.status === '—' ? '' : row.status;
  return row[key];
}

function renderQuadlets() {
  const body = $('#quadlet-list');
  body.replaceChildren();
  const items = state.quadletRows;
  if (state.quadletConfigured === null && !items.length) {
    const row = element('tr');
    const cell = element('td', 'empty', 'Quadlet inventory unavailable.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    $('#quadlet-result-count').textContent = 'Inventory unavailable';
    return;
  }
  if (!state.quadletConfigured && !items.length) {
    const row = element('tr');
    const cell = element('td', 'empty', 'Mount a Quadlet directory to /quadlets to display definitions and resources.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    $('#quadlet-result-count').textContent = 'No Quadlet directory mounted';
    return;
  }
  const filtered = sortRows(items.filter(item => item.searchText.includes(state.quadletQuery)), state.sort.quadlets, quadletSortValue);
  $('#quadlet-result-count').textContent = `Showing ${filtered.length} of ${items.length} resources`;
  if (!filtered.length) {
    const row = element('tr');
    const cell = element('td', 'empty', items.length ? 'No Quadlet resources match your search.' : 'No Quadlet definitions found in the mounted directories.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const entry of filtered) {
    const row = element('tr');
    const nameCell = element('td');
    const name = element('button', 'name-button', entry.name);
    name.type = 'button';
    name.addEventListener('click', () => openQuadletDetails(entry));
    nameCell.append(name, element('span', 'container-id', entry.secondaryName));
    const kind = element('td');
    kind.append(element('span', 'kind-badge', entry.item.kind));
    const service = element('td', 'mono-cell', entry.item.service);
    const imageCell = element('td', 'image-cell', entry.image || '—');
    imageCell.title = entry.image;
    const container = element('td');
    if (entry.linked.length) {
      container.append(element('span', `badge ${entry.statusClass}`, entry.status));
    } else {
      container.textContent = entry.status;
    }
    const viewCell = element('td');
    const view = element('button', 'view-button', 'View →');
    view.type = 'button';
    view.addEventListener('click', () => openQuadletDetails(entry));
    viewCell.append(view);
    row.append(nameCell, kind, service, imageCell, container, viewCell);
    body.append(row);
  }
}

function formatPorts(ports) {
  if (!Array.isArray(ports) || !ports.length) return '—';
  return ports.map(port => port.host_port ? `${port.host_port}:${port.container_port}` : `${port.container_port}/${port.protocol || 'tcp'}`).join(', ');
}

async function refresh(silent = false) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').disabled = true;
  try {
    const [containers, quadlets] = await Promise.allSettled([request('/api/containers'), request('/api/quadlets')]);
    const errors = [];
    if (containers.status === 'fulfilled') {
      state.containers = containers.value.containers;
      setConnection(true);
    } else {
      setConnection(false);
      errors.push(`Containers: ${containers.reason.message}`);
    }
    if (quadlets.status === 'fulfilled') {
      state.quadlets = quadlets.value.definitions;
      state.quadletConfigured = quadlets.value.configured;
    } else {
      state.quadletConfigured = null;
      errors.push(`Quadlets: ${quadlets.reason.message}`);
    }
    state.quadletRows = buildQuadletRows(state.quadlets, state.containers);
    if (!silent || errors.length === 0) setNotice(errors.join(' '));
    render();
  } finally {
    state.loading = false;
    $('#refresh').disabled = false;
  }
}

function detailRow(grid, label, value) {
  grid.append(element('dt', '', label), element('dd', '', value == null || value === '' ? '—' : value));
}

function section(body, title) {
  const node = element('section', 'detail-section');
  node.append(element('h3', '', title));
  body.append(node);
  return node;
}

function closeDetails() {
  state.selected = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

async function openDetails(id) {
  state.selected = id;
  $('#drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#detail-name').textContent = 'Loading…';
  $('#detail-body').replaceChildren(element('p', 'muted', 'Loading container details…'));
  try {
    const [details, logs] = await Promise.all([
      request(`/api/containers/${id}`),
      request(`/api/containers/${id}/logs`).catch(error => ({ logs: `Logs unavailable: ${error.message}` }))
    ]);
    if (state.selected !== id) return;
    renderDetails(id, details.container, logs.logs);
  } catch (error) {
    if (state.selected === id) $('#detail-body').replaceChildren(element('p', 'notice', error.message));
  }
}

function renderDetails(id, data, logs) {
  const summary = state.containers.find(item => item.id === id);
  const name = data.Name?.replace(/^\//, '') || summary?.name || id.slice(0, 12);
  const stateName = data.State?.Status || summary?.state || 'unknown';
  const labels = data.Config?.Labels || data.Labels || {};
  const unit = labels.PODMAN_SYSTEMD_UNIT || labels['io.containers.systemd.unit'] || summary?.systemdUnit;
  $('#detail-name').textContent = name;
  const body = $('#detail-body');
  body.replaceChildren();
  const status = element('div', 'detail-status');
  status.append(element('span', `badge ${stateClass(stateName)}`, stateName), element('span', 'muted', unit ? 'systemd managed' : 'Podman CLI'));
  body.append(status);
  const overview = section(body, 'Overview');
  const grid = element('dl', 'detail-grid');
  detailRow(grid, 'ID', id);
  detailRow(grid, 'Image', data.ImageName || data.Config?.Image || summary?.image);
  detailRow(grid, 'Created', data.Created ? new Date(data.Created).toLocaleString() : '—');
  detailRow(grid, 'Started', data.State?.StartedAt && !data.State.StartedAt.startsWith('0001') ? new Date(data.State.StartedAt).toLocaleString() : '—');
  detailRow(grid, 'Exit code', data.State?.ExitCode == null ? '—' : data.State.ExitCode);
  detailRow(grid, 'Ports', formatPorts(summary?.ports));
  if (unit) detailRow(grid, 'Unit', unit);
  overview.append(grid);
  const control = section(body, 'Actions');
  if (unit) {
    control.append(element('p', 'info', `This container belongs to ${unit}. Manage its lifecycle with systemctl so systemd stays in sync.`));
  } else {
    const actions = element('div', 'actions');
    const choices = stateName === 'running' ? ['stop', 'restart'] : ['start'];
    for (const action of choices) {
      const button = element('button', `action ${action === 'start' ? 'primary' : ''}`, action[0].toUpperCase() + action.slice(1));
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await request(`/api/containers/${id}/${action}`, { method: 'POST' });
          await refresh();
          await openDetails(id);
        } catch (error) {
          setNotice(error.message);
          button.disabled = false;
        }
      });
      actions.append(button);
    }
    control.append(actions);
  }
  const logSection = section(body, 'Recent logs');
  logSection.append(element('pre', 'logs', logs || 'No recent logs.'));
}

function openQuadletDetails(entry) {
  const { item, linked } = entry;
  state.selected = `quadlet:${item.id}`;
  $('#drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#detail-name').textContent = entry.name;
  const body = $('#detail-body');
  body.replaceChildren();
  const status = element('div', 'detail-status');
  status.append(element('span', 'kind-badge', item.kind), element('span', 'muted', item.runtimeOnly ? 'systemd managed container' : 'Quadlet definition'));
  body.append(status);
  const overview = section(body, item.runtimeOnly ? 'Service' : 'Definition');
  const grid = element('dl', 'detail-grid');
  detailRow(grid, 'Definition', item.runtimeOnly ? '' : item.name);
  detailRow(grid, 'Description', item.description);
  detailRow(grid, 'Service', item.service);
  detailRow(grid, 'Source file', item.path);
  overview.append(grid);
  if (item.fields.length) {
    const configuration = section(body, item.runtimeOnly ? 'Podman details' : 'Declared fields');
    const values = element('dl', 'detail-grid');
    for (const field of item.fields) detailRow(values, field.label, field.value);
    configuration.append(values);
  }
  const linkedSection = section(body, 'Linked containers');
  if (!linked.length) linkedSection.append(element('p', 'muted', 'No current container is linked to this service. The definition remains available here.'));
  for (const container of linked) {
    const button = element('button', 'action linked-action', `${container.name} · ${container.state} →`);
    button.type = 'button';
    button.addEventListener('click', () => openDetails(container.id));
    linkedSection.append(button);
  }
  const note = section(body, 'Service lifecycle');
  note.append(element('p', 'info', item.runtimeOnly ? 'Podman reports this container as systemd managed. Mount its Quadlet directory to show the source definition. The unit state is not available here.' : 'Quadlet services are managed by systemd. This view shows the mounted definition and any containers reported by Podman; it does not report systemd unit state.'));
}

$('#refresh').addEventListener('click', () => refresh());
for (const table of ['containers', 'quadlets']) {
  updateSortHeaders(table);
  document.querySelectorAll(`#${table} th.sortable`).forEach(header => header.querySelector('button').addEventListener('click', () => {
    const sort = state.sort[table];
    const key = header.dataset.sortKey;
    sort.direction = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
    sort.key = key;
    updateSortHeaders(table);
    if (table === 'containers') render();
    else renderQuadlets();
  }));
}
$('#search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); render(); });
$('#quadlet-search').addEventListener('input', event => { state.quadletQuery = event.target.value.trim().toLowerCase(); renderQuadlets(); });
function showView(view, updateHash = false) {
  const selected = view === 'quadlets' ? 'quadlets' : 'containers';
  for (const tab of document.querySelectorAll('.view-tab')) {
    const active = tab.dataset.view === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.dataset.view).hidden = !active;
  }
  if (updateHash) history.replaceState(null, '', `#${selected}`);
}
document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view, true)));
$('.view-tabs').addEventListener('keydown', event => {
  const views = ['containers', 'quadlets'];
  const current = views.findIndex(view => $(`#${view}-tab`).getAttribute('aria-selected') === 'true');
  let next = current;
  if (event.key === 'ArrowRight') next = (current + 1) % views.length;
  else if (event.key === 'ArrowLeft') next = (current + views.length - 1) % views.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = views.length - 1;
  else return;
  event.preventDefault();
  showView(views[next], true);
  $(`#${views[next]}-tab`).focus();
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  state.filter = button.dataset.filter;
  render();
}));
$('#close-drawer').addEventListener('click', closeDetails);
$('#drawer-backdrop').addEventListener('click', closeDetails);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDetails(); });
refresh();
setInterval(() => refresh(true), 15000);
