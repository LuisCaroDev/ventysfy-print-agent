const net = require('net');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { parseUsbIdsFromText } = require('./usb-ids');
const { resolveWindowsPrinterName, resolveWindowsPrinterNameByUsbIds } = require('./windows-spooler');

function execFileJson(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 4 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

function buildHostRange(address, netmask) {
  if (!address || !netmask) return [];
  const network = ipToInt(address) & ipToInt(netmask);
  const broadcast = network | (~ipToInt(netmask) >>> 0);
  const first = network + 1;
  const last = broadcast - 1;
  const hosts = [];

  for (let current = first; current <= last && hosts.length < 254; current += 1) {
    const host = intToIp(current);
    if (host !== address) hosts.push(host);
  }

  return hosts;
}

function getIPv4Interfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];

  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items || []) {
      if (item.internal || item.family !== 'IPv4') continue;
      result.push({
        name,
        address: item.address,
        netmask: item.netmask,
      });
    }
  }

  return result;
}

function checkTcpPort(host, port, timeoutMs = 350) {
  return checkTcpPortDetailed(host, port, timeoutMs).then((result) => result.ok);
}

function checkTcpPortDetailed(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ok,
        errorCode: error?.code,
        errorMessage: error?.message,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, { code: 'TIMEOUT', message: 'Connection timed out' }));
    socket.once('error', (error) => finish(false, error));
    socket.connect(port, host);
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;
  const size = Math.max(1, limit);

  async function next() {
    while (index < items.length) {
      const current = index;
      index += 1;
      const result = await worker(items[current], current);
      if (result) results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, next));
  return results;
}

async function discoverNetworkPrinters() {
  const interfaces = getIPv4Interfaces();
  const candidates = interfaces.flatMap((item) => buildHostRange(item.address, item.netmask).map((host) => ({
    interfaceName: item.name,
    host,
    port: 9100,
  })));
  const errorCounts = new Map();

  const discovered = await runWithConcurrency(candidates, 50, async (candidate) => {
    const result = await checkTcpPortDetailed(candidate.host, candidate.port, 250);
    if (!result.ok) {
      const key = result.errorCode || 'UNKNOWN';
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
      return null;
    }
    return {
      tipo: 'network',
      nombre: `Impresora ${candidate.host}`,
      anchoMm: 80,
      codepage: 'CP850',
      abreCajon: false,
      enabled: true,
      connection: {
        host: candidate.host,
        port: candidate.port,
      },
      discoveredFrom: candidate.interfaceName,
    };
  });

  const interfaceSummary = interfaces.length
    ? interfaces.map((item) => `${item.name} ${item.address}/${item.netmask}`).join(', ')
    : 'ninguna interfaz IPv4 activa';
  const errorSummary = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, count]) => `${code}: ${count}`)
    .join(', ');

  const notes = [
    `Interfaces IPv4: ${interfaceSummary}.`,
    `Hosts escaneados en puerto 9100: ${candidates.length}.`,
  ];

  if (candidates.length > 0 && errorCounts.get('EHOSTUNREACH') === candidates.length) {
    notes.push('La app no pudo alcanzar ningun host de la LAN. En macOS esto suele indicar permiso de Red local bloqueado para la app instalada o una ruta/firewall que bloquea el proceso empaquetado.');
  }

  if (errorCounts.has('EACCES') || errorCounts.has('EPERM')) {
    notes.push('macOS rechazo conexiones de red desde la app. Revisa Privacy & Security > Local Network para Ventysfy Print Agent.');
  }

  if (errorSummary) {
    notes.push(`Resultados sin conexion: ${errorSummary}.`);
  }

  return {
    items: discovered.sort((a, b) => a.connection.host.localeCompare(b.connection.host)),
    notes,
  };
}

async function discoverUsbPrinters() {
  try {
    const USBAdapter = require('@node-escpos/usb-adapter');
    const devices = typeof USBAdapter.findPrinter === 'function' ? USBAdapter.findPrinter() : [];
    const items = await Promise.all(devices.map(async (device, index) => {
      const vendorId = `0x${device.deviceDescriptor.idVendor.toString(16)}`;
      const productId = `0x${device.deviceDescriptor.idProduct.toString(16)}`;
      let systemPrinter;
      if (process.platform === 'win32') {
        try {
          systemPrinter = await resolveWindowsPrinterNameByUsbIds(vendorId, productId);
        } catch (_) {
          systemPrinter = undefined;
        }
      }

      return {
        tipo: 'usb',
        nombre: device.deviceDescriptor?.iProduct ? `USB Printer ${index + 1}` : `USB Printer ${index + 1}`,
        anchoMm: 80,
        codepage: 'CP850',
        abreCajon: false,
        enabled: true,
        connection: {
          vendorId,
          productId,
          productName: `USB ${device.deviceDescriptor.idVendor.toString(16)}:${device.deviceDescriptor.idProduct.toString(16)}`,
          systemPrinter,
        },
        notes: process.platform === 'win32'
          ? [systemPrinter
            ? `Se usara la impresora de Windows: ${systemPrinter}`
            : 'En Windows puede requerir WinUSB/Zadig para acceso directo.']
          : [],
      };
    }));

    return {
      supported: true,
      items,
      notes: [],
    };
  } catch (error) {
    return discoverUsbPrintersFromSystem(error);
  }
}

function looksLikePrinter(value) {
  return /printer|epson|xprinter|bixolon|star|pos|thermal|receipt|tm-t/i.test(String(value || ''));
}

async function discoverUsbPrintersFromSystem(originalError) {
  try {
    if (process.platform === 'darwin') {
      const raw = await execFileJson('system_profiler', ['SPUSBDataType', '-json']);
      const parsed = JSON.parse(raw);
      const stack = [];
      const items = [];

      function walk(nodes) {
        for (const node of nodes || []) {
          stack.push(node);
          const name = node._name || node.product_name || '';
          const vendorId = node.vendor_id ? `0x${String(node.vendor_id).replace(/^0x/i, '')}` : undefined;
          const productId = node.product_id ? `0x${String(node.product_id).replace(/^0x/i, '')}` : undefined;
          if (looksLikePrinter(name)) {
            items.push({
              tipo: 'usb',
              nombre: name,
              anchoMm: 80,
              codepage: 'CP850',
              abreCajon: false,
              enabled: true,
              connection: {
                vendorId,
                productId,
                serialNumber: node.serial_num,
                productName: name,
                manufacturer: node.manufacturer,
              },
              notes: ['Deteccion basada en system_profiler; valida con ticket de prueba.'],
            });
          }
          walk(node._items);
          stack.pop();
        }
      }

      walk(parsed.SPUSBDataType || []);
      return {
        supported: true,
        items,
        notes: originalError ? [originalError.message, 'Se uso deteccion por sistema operativo como fallback.'] : [],
      };
    }

    if (process.platform === 'linux') {
      const raw = await execFileJson('lsusb', []);
      const items = raw
        .split('\n')
        .filter(Boolean)
        .filter((line) => looksLikePrinter(line))
        .map((line, index) => {
          const match = line.match(/ID\s+([0-9a-f]{4}):([0-9a-f]{4})/i);
          return {
            tipo: 'usb',
            nombre: line.split('ID')[1]?.trim() || `USB Printer ${index + 1}`,
            anchoMm: 80,
            codepage: 'CP850',
            abreCajon: false,
            enabled: true,
            connection: {
              vendorId: match ? `0x${match[1]}` : undefined,
              productId: match ? `0x${match[2]}` : undefined,
              productName: line,
            },
            notes: ['Deteccion basada en lsusb; valida con ticket de prueba.'],
          };
        });
      return {
        supported: true,
        items,
        notes: originalError ? [originalError.message, 'Se uso deteccion por sistema operativo como fallback.'] : [],
      };
    }

    if (process.platform === 'win32') {
      const raw = await execFileJson('powershell', [
        '-NoProfile',
        '-Command',
        "Get-PnpDevice -PresentOnly | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress",
      ]);
      const parsed = JSON.parse(raw || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const items = list
        .filter((item) => looksLikePrinter(item.FriendlyName))
        .map((item, index) => {
          const ids = parseUsbIdsFromText(item.InstanceId);
          return {
            tipo: 'usb',
            nombre: item.FriendlyName || `USB Printer ${index + 1}`,
            anchoMm: 80,
            codepage: 'CP850',
            abreCajon: false,
            enabled: true,
            connection: {
              vendorId: ids.vendorId,
              productId: ids.productId,
              productName: item.FriendlyName,
              systemPrinter: item.InstanceId,
            },
            notes: ids.vendorId && ids.productId
              ? ['En Windows puede ser necesario instalar WinUSB/Zadig para acceso directo.']
              : [
                'No se pudo extraer vendorId/productId desde Windows; completa esos campos antes de probar impresion USB.',
                'En Windows puede ser necesario instalar WinUSB/Zadig para acceso directo.',
              ],
          };
        });
      return {
        supported: true,
        items,
        notes: originalError ? [originalError.message, 'Se uso deteccion por sistema operativo como fallback.'] : [],
      };
    }
  } catch (fallbackError) {
    return {
      supported: false,
      items: [],
      notes: [
        originalError?.message || 'USB no disponible en esta plataforma',
        fallbackError.message,
      ].filter(Boolean),
    };
  }

  return {
    supported: false,
    items: [],
    notes: [originalError?.message || 'USB no disponible en esta plataforma'],
  };
}

async function discoverBluetoothPrinters() {
  try {
    const SerialAdapter = require('@node-escpos/serialport-adapter');
    const ports = await SerialAdapter.list();
    const items = ports.map((port) => {
      const resolvedPath = resolveSerialPath(port.path);
      const displayName = port.friendlyName || port.manufacturer || resolvedPath;
      const isBluetooth = /bluetooth|rfcomm|bth|wireless/i.test(
        `${resolvedPath} ${port.friendlyName || ''} ${port.manufacturer || ''}`,
      );

      return {
        tipo: 'bluetooth',
        nombre: isBluetooth ? displayName : `${displayName} (serial)`,
        anchoMm: 80,
        codepage: 'CP850',
        abreCajon: false,
        enabled: true,
        connection: {
          path: resolvedPath,
          baudRate: 9600,
          displayName,
        },
        paired: Boolean(resolvedPath),
        likelyBluetooth: isBluetooth,
      };
    });

    return {
      supported: true,
      items
    };
  } catch (error) {
    return {
      supported: false,
      items: [],
      notes: [error.message || 'Bluetooth/serial no disponible en esta plataforma'],
    };
  }
}

async function checkPrinterConnection(printer) {
  if (!printer || printer.enabled === false) {
    return { ok: false, message: 'Impresora deshabilitada' };
  }

  if (printer.tipo === 'network') {
    const ok = await checkTcpPort(printer.connection.host, printer.connection.port, 800);
    return {
      ok,
      state: ok ? 'ready' : 'offline',
      message: ok
        ? `Conectada a ${printer.connection.host}:${printer.connection.port}`
        : `No responde ${printer.connection.host}:${printer.connection.port}`,
    };
  }

  if (printer.tipo === 'usb') {
    const windowsPrinter = printer.connection.systemPrinter
      || (process.platform === 'win32' && /^USBPRINT\\/i.test(String(printer.connection.serialNumber || ''))
        ? printer.connection.serialNumber
        : null);
    if (process.platform === 'win32' && windowsPrinter) {
      try {
        const resolvedName = await resolveWindowsPrinterName(windowsPrinter);
        return {
          ok: true,
          state: 'ready',
          message: `Impresora de Windows detectada: ${resolvedName}`,
        };
      } catch (error) {
        return {
          ok: false,
          state: 'offline',
          message: error.message,
        };
      }
    }

    if (process.platform === 'win32' && printer.connection.vendorId && printer.connection.productId) {
      try {
        const resolvedName = await resolveWindowsPrinterNameByUsbIds(
          printer.connection.vendorId,
          printer.connection.productId,
        );
        return {
          ok: true,
          state: 'ready',
          message: `Impresora de Windows detectada: ${resolvedName}`,
        };
      } catch (_) {
        // Continua con la deteccion USB directa.
      }
    }

    const result = await discoverUsbPrinters();
    if (!result.supported) {
      return { ok: false, message: result.notes[0] || 'USB no soportado' };
    }
    const match = result.items.find((item) =>
      (printer.connection.serialNumber && item.connection.serialNumber === printer.connection.serialNumber)
      || (
        printer.connection.vendorId
        && printer.connection.productId
        && item.connection.vendorId === printer.connection.vendorId
        && item.connection.productId === printer.connection.productId
      )
      || (printer.connection.systemPrinter && item.connection.productName === printer.connection.systemPrinter));
    return {
      ok: Boolean(match),
      state: match ? 'ready' : 'offline',
      message: match ? 'Dispositivo USB detectado' : 'No se detecta el dispositivo USB configurado',
    };
  }

  if (printer.tipo === 'bluetooth') {
    const result = await discoverBluetoothPrinters();
    if (!result.supported) {
      return { ok: false, message: result.notes[0] || 'Bluetooth no soportado' };
    }
    const expectedPath = resolveSerialPath(printer.connection.path);
    const match = result.items.find((item) => item.connection.path === expectedPath);
    if (!match) {
      return { ok: false, state: 'offline', message: 'No se detecta el puerto serial/Bluetooth configurado' };
    }
    return {
      ok: true,
      state: 'detected',
      message: match.likelyBluetooth
        ? 'Puerto Bluetooth detectado. Falta validar con ticket de prueba.'
        : 'Puerto serial detectado. Falta validar con ticket de prueba.',
    };
  }

  return { ok: false, state: 'offline', message: 'Tipo de impresora no soportado' };
}

function resolveSerialPath(inputPath) {
  const value = String(inputPath || '').trim();
  if (!value) return value;

  if (process.platform === 'darwin' && value.startsWith('/dev/tty.')) {
    const calloutPath = value.replace('/dev/tty.', '/dev/cu.');
    if (fs.existsSync(calloutPath)) return calloutPath;
  }

  return value;
}

module.exports = {
  checkPrinterConnection,
  discoverBluetoothPrinters,
  discoverNetworkPrinters,
  discoverUsbPrinters,
  getIPv4Interfaces,
};
