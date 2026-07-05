const escpos = require('@node-escpos/core');
const NetworkAdapter = require('@node-escpos/network-adapter');
const USBAdapter = require('@node-escpos/usb-adapter');
const SerialAdapter = require('@node-escpos/serialport-adapter');
const fs = require('fs');
const { parseUsbIdsFromText } = require('./usb-ids');
const WindowsSpoolerAdapter = require('./windows-spooler-adapter');
const { resolveWindowsPrinterNameByUsbIds } = require('./windows-spooler');

function parseHexToInt(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number.parseInt(String(value).replace(/^0x/i, ''), 16);
}

function emitEvent(hooks, stage, detail = {}) {
  if (typeof hooks?.onEvent === 'function') {
    hooks.onEvent(stage, detail);
  }
}

function isWindowsUsbPrintInstanceId(value) {
  return process.platform === 'win32' && /^USBPRINT\\/i.test(String(value || ''));
}

async function createAdapter(printer, hooks) {
  if (printer.tipo === 'network') {
    emitEvent(hooks, 'adapter_prepare', {
      transport: 'network',
      host: printer.connection.host,
      port: Number(printer.connection.port) || 9100,
    });
    return new NetworkAdapter(
      printer.connection.host,
      Number(printer.connection.port) || 9100,
      5000,
    );
  }

  if (printer.tipo === 'usb') {
    const idsFromSerial = parseUsbIdsFromText(printer.connection.serialNumber);
    const vendorId = printer.connection.vendorId || idsFromSerial.vendorId;
    const productId = printer.connection.productId || idsFromSerial.productId;
    let spoolerPrinter = printer.connection.systemPrinter
      || (isWindowsUsbPrintInstanceId(printer.connection.serialNumber) ? printer.connection.serialNumber : null);
    if (process.platform === 'win32' && !spoolerPrinter && vendorId && productId) {
      try {
        spoolerPrinter = await resolveWindowsPrinterNameByUsbIds(vendorId, productId);
      } catch (error) {
        emitEvent(hooks, 'windows_spooler_lookup_miss', { error: error.message });
      }
    }
    if (process.platform === 'win32' && spoolerPrinter) {
      emitEvent(hooks, 'adapter_prepare', {
        transport: 'windows-spooler',
        printer: spoolerPrinter,
      });
      return new WindowsSpoolerAdapter(spoolerPrinter, {
        documentName: `Ventysfy ${printer.nombre || printer.id}`,
      });
    }

    const vid = parseHexToInt(vendorId);
    const pid = parseHexToInt(productId);
    if (vid && pid) {
      emitEvent(hooks, 'adapter_prepare', {
        transport: 'usb',
        vendorId,
        productId,
      });
      return new USBAdapter(vid, pid);
    }

    if (printer.connection.serialNumber) {
      emitEvent(hooks, 'adapter_prepare', {
        transport: 'usb',
        serialNumber: printer.connection.serialNumber,
      });
      const device = await USBAdapter.getDeviceBySerial(printer.connection.serialNumber);
      return new USBAdapter(device);
    }

    throw new Error(`Impresora USB ${printer.id}: falta vendorId/productId o serialNumber`);
  }

  if (printer.tipo === 'bluetooth') {
    const resolvedPath = resolveSerialPath(printer.connection.path);
    const baudRate = Number(printer.connection.baudRate) || 9600;
    emitEvent(hooks, 'adapter_prepare', {
      transport: 'bluetooth',
      path: printer.connection.path,
      resolvedPath,
      baudRate,
    });
    return new SerialAdapter(resolvedPath, {
      baudRate,
    });
  }

  throw new Error(`Impresora ${printer.id}: tipo no soportado ${printer.tipo}`);
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

function openAdapter(adapter, hooks) {
  return new Promise((resolve, reject) => {
    emitEvent(hooks, 'adapter_open_start');
    adapter.open((error) => (error ? reject(error) : resolve()));
  });
}

async function closePrinter(printer, hooks) {
  try {
    emitEvent(hooks, 'printer_close_start');
    await printer.close();
    emitEvent(hooks, 'printer_close_ok');
  } catch (_) {
    // Ignora fallos de cierre para no ocultar el error principal.
    emitEvent(hooks, 'printer_close_error', { error: _.message });
  }
}

function setAlign(printer, value) {
  if (value === 'center') printer.align('ct');
  else if (value === 'right') printer.align('rt');
  else printer.align('lt');
}

async function renderJob(printer, job, hooks) {
  const blocks = Array.isArray(job.bloques) ? job.bloques : [];
  emitEvent(hooks, 'job_render_start', {
    blockCount: blocks.length,
  });

  for (const block of blocks) {
    switch (block.tipo) {
      case 'align':
        setAlign(printer, block.valor);
        break;
      case 'texto': {
        const style = block.estilo || {};
        if (style.bold) printer.emphasize();
        if (style.size === 'double') printer.size(2, 2);
        else if (style.size === 'tall') printer.size(1, 2);
        else printer.size(1, 1);
        printer.println(String(block.valor ?? ''));
        if (style.bold) printer.cancelEmphasize();
        printer.size(1, 1);
        break;
      }
      case 'separador':
        printer.drawLine();
        break;
      case 'feed':
        printer.feed(Number(block.valor) || 1);
        break;
      case 'cut':
        printer.cut();
        break;
      case 'qr':
        printer.qrcode(String(block.valor || ''), undefined, undefined, 6);
        break;
      case 'abrir-cajon':
        emitEvent(hooks, 'drawer_pulse');
        printer.cashdraw(2);
        break;
      case 'imagen':
        if (block.valor) {
          try {
            const image = await escpos.Image.load(Buffer.from(block.valor, 'base64'), 'image/png');
            await printer.image(image);
          } catch (_) {
            emitEvent(hooks, 'image_omitted', { error: _.message });
            printer.println('[Imagen omitida]');
          }
        }
        break;
      default:
        break;
    }
  }

  emitEvent(hooks, 'job_render_ok');
}

async function withPrinter(printerDef, work, hooks = {}) {
  const adapter = await createAdapter(printerDef, hooks);
  const printer = new escpos.Printer(adapter, {
    encoding: printerDef.codepage || 'CP850',
  });

  try {
    await openAdapter(adapter, hooks);
    emitEvent(hooks, 'adapter_open_ok');
  } catch (error) {
    const message = process.platform === 'win32' && error.message === 'LIBUSB_ERROR_NOT_SUPPORTED'
      ? `${error.message}. Windows esta usando el driver de impresora; configura el campo systemPrinter/nombre del sistema o instala WinUSB con Zadig para acceso USB directo.`
      : error.message;
    emitEvent(hooks, 'adapter_open_error', { error: message });
    error.message = message;
    throw error;
  }

  try {
    await work(printer);
    emitEvent(hooks, 'printer_flush_start');
    await printer.flush();
    emitEvent(hooks, 'printer_flush_ok');
  } finally {
    await closePrinter(printer, hooks);
  }
}

async function printJob(printerDef, job, hooks) {
  await withPrinter(printerDef, async (printer) => {
    await renderJob(printer, job, hooks);
  }, hooks);
}

async function openDrawer(printerDef, hooks) {
  await withPrinter(printerDef, async (printer) => {
    emitEvent(hooks, 'drawer_pulse');
    printer.cashdraw(2);
  }, hooks);
}

async function testPrint(printerDef, hooks) {
  const now = new Date().toLocaleString();
  await printJob(printerDef, {
    ancho: printerDef.anchoMm === 58 ? 58 : 80,
    bloques: [
      { tipo: 'align', valor: 'center' },
      { tipo: 'texto', valor: 'VENTYSFY PRINT AGENT', estilo: { bold: true, size: 'double' } },
      { tipo: 'texto', valor: 'Prueba de impresion' },
      { tipo: 'separador' },
      { tipo: 'align', valor: 'left' },
      { tipo: 'texto', valor: `Impresora: ${printerDef.nombre || printerDef.id}` },
      { tipo: 'texto', valor: `Tipo:      ${printerDef.tipo}` },
      { tipo: 'texto', valor: `Fecha:     ${now}` },
      { tipo: 'separador' },
      { tipo: 'align', valor: 'center' },
      { tipo: 'texto', valor: 'Si lees esto, todo OK.' },
      { tipo: 'feed', valor: 3 },
      { tipo: 'cut' },
    ],
  }, hooks);
}

module.exports = {
  openDrawer,
  printJob,
  testPrint,
};
