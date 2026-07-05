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

function setTextStyle(printer, block) {
  const size = Number(block.size) || 1;
  printer.style(Boolean(block.bold), false, block.underline ? 1 : 0);
  printer.size(size, size);
}

function resetTextStyle(printer) {
  printer.style(false, false, 0);
  printer.size(1, 1);
}

async function loadRemoteImage(url) {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error('Formato data URL no soportado');
    return escpos.Image.load(Buffer.from(match[2], 'base64'), match[1]);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar el logo: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || undefined;
  return escpos.Image.load(new Uint8Array(await response.arrayBuffer()), contentType);
}

function resizeImageToMaxWidth(image, maxWidth) {
  const targetWidth = Math.floor(Number(maxWidth) || 0);
  if (!targetWidth || image.size.width <= targetWidth) return image;

  const { width, height, colors } = image.size;
  const targetHeight = Math.max(1, Math.round((height * targetWidth) / width));
  const output = new Uint8Array(targetWidth * targetHeight * colors);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / targetWidth));
      const sourceIndex = (sourceY * width + sourceX) * colors;
      const targetIndex = (y * targetWidth + x) * colors;
      for (let channel = 0; channel < colors; channel += 1) {
        output[targetIndex + channel] = image.pixels.data[sourceIndex + channel];
      }
    }
  }

  return new escpos.Image({
    data: output,
    shape: [targetWidth, targetHeight, colors],
  });
}

async function renderJob(printer, job, hooks) {
  const blocks = Array.isArray(job.blocks) ? job.blocks : [];
  emitEvent(hooks, 'job_render_start', {
    blockCount: blocks.length,
  });

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        setAlign(printer, block.align);
        setTextStyle(printer, block);
        printer.println(block.content);
        resetTextStyle(printer);
        break;
      }
      case 'table-row': {
        setAlign(printer, 'left');
        printer.tableCustom([
          {
            text: block.left,
            width: 0.65,
            align: block.align || 'left',
            style: block.bold ? 'b' : 'normal',
          },
          {
            text: block.right,
            width: 0.35,
            align: 'right',
            style: block.bold ? 'b' : 'normal',
          },
        ]);
        break;
      }
      case 'separator':
        setAlign(printer, 'left');
        printer.drawLine(block.style === 'dotted' ? '.' : '-');
        break;
      case 'feed':
        printer.feed(block.lines || 1);
        break;
      case 'cut':
        printer.cut(Boolean(block.partial));
        break;
      case 'qr':
        setAlign(printer, 'center');
        printer.qrcode(block.content, undefined, undefined, block.size || 6);
        break;
      case 'barcode':
        setAlign(printer, 'center');
        printer.barcode(block.content, block.format || 'CODE128', {
          width: 2,
          height: 80,
          position: 'blw',
        });
        break;
      case 'open-drawer':
        emitEvent(hooks, 'drawer_pulse');
        printer.cashdraw(2);
        break;
      case 'image':
        try {
          const loadedImage = await loadRemoteImage(block.url);
          const image = resizeImageToMaxWidth(loadedImage, block.maxWidth);
          setAlign(printer, 'center');
          await printer.image(image);
        } catch (error) {
          emitEvent(hooks, 'image_omitted', { type: block.type, error: error.message });
          printer.println('[Imagen omitida]');
        }
        break;
      default:
        throw new Error(`Unsupported print block: ${block.type}`);
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
    version: 1,
    widthMm: printerDef.anchoMm === 58 ? 58 : 80,
    reason: 'test',
    blocks: [
      { type: 'text', content: 'VENTYSFY PRINT AGENT', align: 'center', bold: true, size: 2 },
      { type: 'text', content: 'Prueba de impresion', align: 'center' },
      { type: 'separator', style: 'solid' },
      { type: 'text', content: `Impresora: ${printerDef.nombre || printerDef.id}` },
      { type: 'text', content: `Tipo:      ${printerDef.tipo}` },
      { type: 'text', content: `Fecha:     ${now}` },
      { type: 'separator', style: 'solid' },
      { type: 'text', content: 'Si lees esto, todo OK.', align: 'center' },
      { type: 'feed', lines: 3 },
      { type: 'cut' },
    ],
  }, hooks);
}

module.exports = {
  openDrawer,
  printJob,
  testPrint,
};
