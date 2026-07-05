const state = {
  status: null,
  editingPrinterId: null,
};

const statusGrid = document.getElementById('status-grid');
const printerList = document.getElementById('printer-list');
const discoveryResults = document.getElementById('discovery-results');
const dialog = document.getElementById('printer-dialog');
const form = document.getElementById('printer-form');
const typeField = document.getElementById('field-tipo');
const toast = document.getElementById('toast');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, kind = 'ok') {
  const klass = kind === 'error' ? 'alert-error' : 'alert-success';
  toast.innerHTML = `<div class="toast-shell__message alert ${klass}"><span>${escapeHtml(message)}</span></div>`;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add('hidden');
    toast.innerHTML = '';
  }, 2600);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(path, {
    headers,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function statusBadge(runtime) {
  if (!runtime) return '<span class="badge badge-warning badge-outline">Sin verificacion</span>';
  if (runtime.state === 'detected') {
    return '<span class="badge badge-warning badge-outline">Puerto detectado</span>';
  }
  return runtime.ok
    ? '<span class="badge badge-success badge-outline">Disponible</span>'
    : '<span class="badge badge-error badge-outline">Sin conexion</span>';
}

function getPrimaryHost() {
  const hosts = state.status?.suggestedHosts || [];
  return hosts[0] || 'http://127.0.0.1:9977';
}

function renderStatus() {
  if (!state.status) return;
  const primaryHost = getPrimaryHost();

  statusGrid.innerHTML = `
    <article class="status-card">
      <div class="status-card__body">
        <strong>Host del agente</strong>
        <div class="status-card__value">
          <code class="code-block">${escapeHtml(primaryHost)}</code>
          <button class="btn btn-outline btn-sm" data-copy="${escapeHtml(primaryHost)}">Copiar</button>
        </div>
        <p class="muted">Pega este host en la configuracion de impresion del POS.</p>
      </div>
    </article>
    <article class="status-card">
      <div class="status-card__body">
        <strong>Token del agente</strong>
        <div class="status-card__value">
          <code class="code-block">${escapeHtml(state.status.token)}</code>
          <button class="btn btn-outline btn-sm" data-copy="${escapeHtml(state.status.token)}">Copiar</button>
        </div>
        <p class="muted">Usa este token en el POS para autorizar la conexion.</p>
      </div>
    </article>
  `;

  statusGrid.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      showToast('Copiado al portapapeles');
    });
  });
}

function bluetoothHint(kind) {
  if (kind !== 'bluetooth') return '';
  return `
    <article class="alert alert-warning shadow-sm">
      <span>Antes de buscar o agregar impresoras Bluetooth, empareja la impresora en el sistema operativo.</span>
    </article>
  `;
}

function discoveryEmptyState(kind, notes) {
  return `
    ${bluetoothHint(kind)}
    <article class="empty-state">
      <span>No se encontraron dispositivos ${escapeHtml(kind)}.</span>
    </article>
    ${notes}
  `;
}

function discoveryResultLayout(kind, items, notes) {
  return `
    ${bluetoothHint(kind)}
    ${items}
    ${notes}
  `;
}

function printerMeta(printer) {
  const meta = [
    `<span class="badge badge-neutral badge-outline">${escapeHtml(printer.tipo)}</span>`,
    `<span class="badge badge-outline">${escapeHtml(printer.anchoMm)} mm</span>`,
    printer.abreCajon ? '<span class="badge badge-success badge-outline">Cajon</span>' : '',
    printer.enabled ? '<span class="badge badge-success badge-outline">Habilitada</span>' : '<span class="badge badge-warning badge-outline">Deshabilitada</span>',
  ].filter(Boolean);
  return meta.join('');
}

function printerConnectionLabel(printer) {
  if (printer.tipo === 'network') {
    return `${printer.connection.host}:${printer.connection.port}`;
  }
  if (printer.tipo === 'usb') {
    const usbIds = [
      printer.connection.vendorId,
      printer.connection.productId,
      printer.connection.serialNumber,
    ].filter(Boolean).join(' · ');
    const windowsPrinter = printer.connection.systemPrinter
      ? `Windows: ${printer.connection.systemPrinter}`
      : '';
    return [usbIds, windowsPrinter].filter(Boolean).join(' · ') || 'USB manual';
  }
  return `${printer.connection.path}${printer.connection.channel ? ` · ${printer.connection.channel}` : ''}`;
}

function formatDiagnosticStep(step) {
  const detail = { ...step };
  delete detail.at;
  delete detail.stage;
  const extras = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return `${step.at}  ${step.stage}${extras ? `  ${extras}` : ''}`;
}

function renderDiagnosticSummary(diagnostic) {
  if (!diagnostic) return '<p class="muted">Sin diagnostico reciente.</p>';

  return `
    <div class="diagnostic-inline">
      <p class="muted"><strong>Diagnostico:</strong> ${escapeHtml(diagnostic.message || 'Sin mensaje')}</p>
      <p class="muted">${escapeHtml(`${diagnostic.operation} · ${diagnostic.durationMs ?? 0} ms`)}</p>
      <details class="diagnostic-details">
        <summary class="diagnostic-details__summary">Ver detalle tecnico</summary>
        <pre class="diagnostic-log">${escapeHtml((diagnostic.steps || []).map(formatDiagnosticStep).join('\n') || 'Sin pasos registrados')}</pre>
      </details>
    </div>
  `;
}

function renderPrinters() {
  const printers = state.status?.printers || [];
  if (!printers.length) {
    printerList.innerHTML = `
      <article class="empty-state">
        <span>No hay impresoras configuradas. Usa "Agregar impresora" o corre una deteccion abajo.</span>
      </article>
    `;
    return;
  }

  printerList.innerHTML = printers.map((printer) => `
    <article class="printer-card">
      <div class="printer-card__body">
        <div class="printer-card__head">
          <div>
            <strong class="text-lg">${escapeHtml(printer.nombre)}</strong>
            <p class="muted text-sm">${escapeHtml(printer.id)}</p>
          </div>
          ${statusBadge(printer.runtime?.connection)}
        </div>
        <div class="printer-card__meta">${printerMeta(printer)}</div>
        <p><strong>Conexion:</strong> ${escapeHtml(printerConnectionLabel(printer))}</p>
        <p class="muted">${escapeHtml(printer.runtime?.connection?.message || 'Sin verificacion reciente')}</p>
        <p class="muted">${escapeHtml(printer.runtime?.lastTest ? `Ultima prueba: ${new Date(printer.runtime.lastTest.at).toLocaleString()} · ${printer.runtime.lastTest.message}` : 'Aun no se ha enviado ticket de prueba.')}</p>
        ${renderDiagnosticSummary(printer.runtime?.lastDiagnostic)}
        <div class="printer-card__actions">
          <button class="btn btn-outline btn-sm" data-action="test" data-id="${escapeHtml(printer.id)}">Ticket de prueba</button>
          <button class="btn btn-outline btn-sm" data-action="drawer" data-id="${escapeHtml(printer.id)}">Abrir cajon</button>
          <button class="btn btn-outline btn-sm" data-action="edit" data-id="${escapeHtml(printer.id)}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="duplicate" data-id="${escapeHtml(printer.id)}">Duplicar</button>
          <button class="btn btn-error btn-outline btn-sm" data-action="delete" data-id="${escapeHtml(printer.id)}">Eliminar</button>
        </div>
      </div>
    </article>
  `).join('');

  printerList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handlePrinterAction(button.dataset.action, button.dataset.id));
  });
}

function setTypeFields(value) {
  document.getElementById('network-fields').classList.toggle('hidden', value !== 'network');
  document.getElementById('usb-fields').classList.toggle('hidden', value !== 'usb');
  document.getElementById('bluetooth-fields').classList.toggle('hidden', value !== 'bluetooth');
}

function resetForm() {
  form.reset();
  form.enabled.checked = true;
  form.codepage.value = 'CP850';
  form.anchoMm.value = '80';
  form.port.value = '9100';
  form.baudRate.value = '9600';
  state.editingPrinterId = null;
  document.getElementById('dialog-title').textContent = 'Agregar impresora';
  setTypeFields('network');
}

function fillForm(printer) {
  resetForm();
  state.editingPrinterId = printer.id;
  document.getElementById('dialog-title').textContent = `Editar ${printer.nombre}`;
  form.nombre.value = printer.nombre;
  form.tipo.value = printer.tipo;
  form.anchoMm.value = String(printer.anchoMm);
  form.codepage.value = printer.codepage || 'CP850';
  form.abreCajon.checked = Boolean(printer.abreCajon);
  form.enabled.checked = printer.enabled !== false;
  setTypeFields(printer.tipo);

  if (printer.tipo === 'network') {
    form.host.value = printer.connection.host || '';
    form.port.value = printer.connection.port || 9100;
  } else if (printer.tipo === 'usb') {
    form.vendorId.value = printer.connection.vendorId || '';
    form.productId.value = printer.connection.productId || '';
    form.serialNumber.value = printer.connection.serialNumber || '';
    form.systemPrinter.value = printer.connection.systemPrinter || '';
  } else if (printer.tipo === 'bluetooth') {
    form.path.value = printer.connection.path || '';
    form.baudRate.value = printer.connection.baudRate || 9600;
    form.channel.value = printer.connection.channel || '';
  }
}

function collectFormPayload() {
  const payload = {
    nombre: form.nombre.value.trim(),
    tipo: form.tipo.value,
    anchoMm: Number(form.anchoMm.value) || 80,
    codepage: form.codepage.value.trim() || 'CP850',
    abreCajon: form.abreCajon.checked,
    enabled: form.enabled.checked,
  };

  if (payload.tipo === 'network') {
    payload.connection = {
      host: form.host.value.trim(),
      port: Number(form.port.value) || 9100,
    };
  } else if (payload.tipo === 'usb') {
    payload.connection = {
      vendorId: form.vendorId.value.trim(),
      productId: form.productId.value.trim(),
      serialNumber: form.serialNumber.value.trim(),
      systemPrinter: form.systemPrinter.value.trim(),
    };
  } else {
    payload.connection = {
      path: form.path.value.trim(),
      baudRate: Number(form.baudRate.value) || 9600,
      channel: form.channel.value.trim(),
    };
  }

  return payload;
}

async function savePrinter(event) {
  event.preventDefault();
  const payload = collectFormPayload();

  if (state.editingPrinterId) {
    await api(`/api/printers/${state.editingPrinterId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    showToast('Impresora actualizada');
  } else {
    await api('/api/printers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast('Impresora creada');
  }

  dialog.close();
  await refresh();
}

async function handlePrinterAction(action, id) {
  const printer = state.status.printers.find((item) => item.id === id);
  if (!printer) return;

  if (action === 'edit') {
    fillForm(printer);
    dialog.showModal();
    return;
  }

  if (action === 'delete') {
    if (!window.confirm(`Eliminar ${printer.nombre}?`)) return;
    await api(`/api/printers/${id}`, { method: 'DELETE' });
    showToast('Impresora eliminada');
    return refresh();
  }

  if (action === 'duplicate') {
    await api(`/api/printers/${id}/duplicate`, { method: 'POST' });
    showToast('Impresora duplicada');
    return refresh();
  }

  if (action === 'test') {
    try {
      await api(`/api/printers/${id}/test`, { method: 'POST' });
      showToast('Ticket de prueba enviado');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return refresh();
  }

  if (action === 'drawer') {
    try {
      await api(`/api/printers/${id}/open-drawer`, { method: 'POST' });
      showToast('Pulso de cajon enviado');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
}

function discoveryCard(item) {
  const connection = item.tipo === 'network'
    ? `${item.connection.host}:${item.connection.port}`
    : item.tipo === 'usb'
      ? [
        [item.connection.vendorId, item.connection.productId, item.connection.serialNumber].filter(Boolean).join(' · '),
        item.connection.systemPrinter ? `Windows: ${item.connection.systemPrinter}` : '',
      ].filter(Boolean).join(' · ') || 'USB'
      : `${item.connection.path}${item.likelyBluetooth ? ' · Bluetooth' : ''}`;
  const notes = (item.notes || []).map((note) => `<p class="muted text-sm">${escapeHtml(note)}</p>`).join('');
  return `
    <article class="discovery-card">
      <div class="discovery-card__body">
        <div class="discovery-card__head">
          <div>
            <strong class="text-lg">${escapeHtml(item.nombre)}</strong>
            <p class="muted text-sm">${escapeHtml(connection)}</p>
            ${notes}
          </div>
          <span class="badge badge-neutral badge-outline">${escapeHtml(item.tipo)}</span>
        </div>
        <div class="discovery-card__actions">
          <button class="btn btn-primary btn-sm" data-discovery-add='${JSON.stringify(item).replace(/'/g, '&#39;')}'>Agregar</button>
        </div>
      </div>
    </article>
  `;
}

function renderDiscovery(payload, kind) {
  const notes = (payload.notes || []).map((note) => `<p class="muted text-sm">${escapeHtml(note)}</p>`).join('');
  const items = (payload.items || []).length
    ? discoveryResultLayout(kind, payload.items.map((item) => discoveryCard(item)).join(''), notes)
    : discoveryEmptyState(kind, notes);

  discoveryResults.innerHTML = items;
  discoveryResults.querySelectorAll('[data-discovery-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const payloadItem = JSON.parse(button.dataset.discoveryAdd);
      fillForm(payloadItem);
      state.editingPrinterId = null;
      document.getElementById('dialog-title').textContent = `Agregar ${payloadItem.nombre}`;
      dialog.showModal();
    });
  });
}

async function runDiscovery(kind) {
  discoveryResults.innerHTML = `
    ${bluetoothHint(kind)}
    <article class="empty-state">
      <div class="discovery-loading">
        <span class="loading loading-spinner loading-sm"></span>
        <span>Buscando ${escapeHtml(kind)}...</span>
      </div>
    </article>
  `;
  try {
    const payload = await api(`/api/printers/discover/${kind}`, { method: 'POST' });
    renderDiscovery(payload, kind);
  } catch (error) {
    discoveryResults.innerHTML = `
      <article class="alert alert-error shadow-sm">
        <span>Error detectando ${escapeHtml(kind)}: ${escapeHtml(error.message)}</span>
      </article>
    `;
  }
}

async function refresh() {
  state.status = await api('/api/status');
  renderStatus();
  renderPrinters();
}

document.getElementById('refresh-status').addEventListener('click', refresh);
document.getElementById('add-printer').addEventListener('click', () => {
  resetForm();
  dialog.showModal();
});
document.getElementById('close-dialog').addEventListener('click', () => dialog.close());
document.getElementById('cancel-dialog').addEventListener('click', () => dialog.close());
typeField.addEventListener('change', () => setTypeFields(typeField.value));
form.addEventListener('submit', savePrinter);
document.querySelectorAll('[data-discovery]').forEach((button) => {
  button.addEventListener('click', () => runDiscovery(button.dataset.discovery));
});

refresh().catch((error) => {
  showToast(error.message, 'error');
});
