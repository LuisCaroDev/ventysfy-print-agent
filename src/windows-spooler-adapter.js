const { Adapter } = require('@node-escpos/adapter');
const { printRawToWindowsPrinter, resolveWindowsPrinterName } = require('./windows-spooler');

class WindowsSpoolerAdapter extends Adapter {
  constructor(printerNameOrId, options = {}) {
    super();
    this.printerNameOrId = printerNameOrId;
    this.documentName = options.documentName || 'Ventysfy ESC/POS';
    this.resolvedPrinterName = null;
  }

  async open(callback) {
    try {
      this.resolvedPrinterName = await resolveWindowsPrinterName(this.printerNameOrId);
      this.emit('connect', this.resolvedPrinterName);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
    return this;
  }

  write(data, callback) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length === 0) {
      callback?.(null);
      return this;
    }

    printRawToWindowsPrinter(this.resolvedPrinterName || this.printerNameOrId, buffer, this.documentName)
      .then((printerName) => {
        this.resolvedPrinterName = printerName;
        this.emit('data', buffer);
        callback?.(null);
      })
      .catch((error) => callback?.(error));

    return this;
  }

  close(callback) {
    this.emit('close', this.resolvedPrinterName || this.printerNameOrId);
    callback?.(null);
    return this;
  }
}

module.exports = WindowsSpoolerAdapter;
