const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { normalizeHexId, parseUsbIdsFromText } = require('./usb-ids');

const CONFIG_VERSION = 2;
const APP_STORAGE_DIR = 'Ventysfy Print Agent';
const APP_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'https://ventysfypos.lovable.app',
  'https://*.lovable.app',
  'https://*.restaurant.ventysfy.com',
  'https://restaurant.ventysfy.com',
  'https://*.devrestaurant.ventysfy.com',
  'https://devrestaurant.ventysfy.com'
];

const widthSchema = z.union([z.literal(58), z.literal(80)]);

const basePrinterSchema = {
  id: z.string().min(1),
  nombre: z.string().min(1),
  anchoMm: widthSchema.default(80),
  codepage: z.string().default('CP850'),
  abreCajon: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const printerSchema = z.discriminatedUnion('tipo', [
  z.object({
    ...basePrinterSchema,
    tipo: z.literal('network'),
    connection: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(9100),
    }),
  }),
  z.object({
    ...basePrinterSchema,
    tipo: z.literal('usb'),
    connection: z.object({
      vendorId: z.string().optional(),
      productId: z.string().optional(),
      serialNumber: z.string().optional(),
      productName: z.string().optional(),
      manufacturer: z.string().optional(),
      systemPrinter: z.string().optional(),
    }).superRefine((value, ctx) => {
      if (!value.vendorId && !value.serialNumber && !value.systemPrinter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vendorId'],
          message: 'USB requiere vendorId, serialNumber o systemPrinter',
        });
      }
    }),
  }),
  z.object({
    ...basePrinterSchema,
    tipo: z.literal('bluetooth'),
    connection: z.object({
      path: z.string().min(1),
      baudRate: z.number().int().min(1200).max(115200).default(9600),
      channel: z.string().optional(),
      displayName: z.string().optional(),
    }),
  }),
]);

const configSchema = z.object({
  version: z.number().int().default(CONFIG_VERSION),
  port: z.number().int().min(1).max(65535).default(9977),
  token: z.string().min(1),
  printers: z.array(printerSchema).default([]),
});

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function slugifyPrinterId(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `printer-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeCodepage(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || 'CP850';
}

function charsToWidthMm(value) {
  if (Number(value) <= 32) return 58;
  return 80;
}

function parseNetworkInterface(value) {
  const raw = String(value || '').trim();
  if (!raw) return { host: '', port: 9100 };
  const withoutProto = raw.replace(/^tcp:\/\//i, '');
  const [host, port] = withoutProto.split(':');
  return {
    host: host || '',
    port: Number(port) || 9100,
  };
}

function normalizeLegacyPrinter(printer) {
  if (!printer || typeof printer !== 'object') return null;
  if (printer.connection) {
    return normalizePrinterInput(printer);
  }

  const tipo = printer.tipo || 'network';
  const common = {
    id: printer.id || slugifyPrinterId(printer.nombre || tipo),
    nombre: printer.nombre || printer.id || 'Impresora',
    tipo,
    anchoMm: printer.anchoMm || charsToWidthMm(printer.ancho),
    codepage: normalizeCodepage(printer.codepage),
    abreCajon: Boolean(printer.abreCajon),
    enabled: printer.enabled !== false,
  };

  if (tipo === 'network') {
    const parsed = parseNetworkInterface(printer.interface);
    return {
      ...common,
      tipo: 'network',
      connection: {
        host: printer.host || parsed.host,
        port: Number(printer.port) || parsed.port || 9100,
      },
    };
  }

  if (tipo === 'usb') {
    return {
      ...common,
      tipo: 'usb',
      connection: {
        vendorId: normalizeHexId(printer.vendorId),
        productId: normalizeHexId(printer.productId),
        serialNumber: printer.serialNumber,
        productName: printer.productName || printer.nombre,
        manufacturer: printer.manufacturer,
        systemPrinter: printer.systemPrinter,
      },
    };
  }

  if (tipo === 'bluetooth') {
    return {
      ...common,
      tipo: 'bluetooth',
      connection: {
        path: printer.path || printer.serialPath || printer.comPath || '',
        baudRate: Number(printer.baudRate) || 9600,
        channel: printer.channel,
        displayName: printer.displayName || printer.nombre,
      },
    };
  }

  return null;
}

function normalizePrinterInput(input) {
  if (!input || typeof input !== 'object') return input;

  const normalized = {
    ...input,
    id: input.id ? slugifyPrinterId(input.id) : slugifyPrinterId(input.nombre),
    nombre: String(input.nombre || '').trim(),
    anchoMm: Number(input.anchoMm || input.ancho) === 58 ? 58 : 80,
    codepage: normalizeCodepage(input.codepage),
    abreCajon: Boolean(input.abreCajon),
    enabled: input.enabled !== false,
  };

  if (normalized.tipo === 'network') {
    normalized.connection = {
      host: String(input.connection?.host || input.host || '').trim(),
      port: Number(input.connection?.port || input.port) || 9100,
    };
  } else if (normalized.tipo === 'usb') {
    const serialNumber = input.connection?.serialNumber || input.serialNumber;
    const systemPrinter = input.connection?.systemPrinter || input.systemPrinter;
    const parsedIds = parseUsbIdsFromText(serialNumber);
    const serialIsWindowsPrinter = process.platform === 'win32' && /^USBPRINT\\/i.test(String(serialNumber || ''));
    normalized.connection = {
      vendorId: normalizeHexId(input.connection?.vendorId || input.vendorId) || parsedIds.vendorId,
      productId: normalizeHexId(input.connection?.productId || input.productId) || parsedIds.productId,
      serialNumber,
      productName: input.connection?.productName || input.productName || input.nombre,
      manufacturer: input.connection?.manufacturer || input.manufacturer,
      systemPrinter: systemPrinter || (serialIsWindowsPrinter ? serialNumber : undefined),
    };
  } else if (normalized.tipo === 'bluetooth') {
    normalized.connection = {
      path: String(input.connection?.path || input.path || '').trim(),
      baudRate: Number(input.connection?.baudRate || input.baudRate) || 9600,
      channel: input.connection?.channel || input.channel,
      displayName: input.connection?.displayName || input.displayName || input.nombre,
    };
  }

  return normalized;
}

function ensureUniquePrinterId(printers, id, skipId) {
  let nextId = slugifyPrinterId(id);
  let counter = 2;
  while (printers.some((printer) => printer.id === nextId && printer.id !== skipId)) {
    nextId = `${slugifyPrinterId(id)}-${counter++}`;
  }
  return nextId;
}

function buildDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    port: 9977,
    token: generateToken(),
    printers: [],
  };
}

function getDefaultStorageDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_STORAGE_DIR);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_STORAGE_DIR);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ventysfy-print-agent');
}

function resolveConfigPath(inputPath) {
  if (inputPath) return inputPath;
  return path.join(getDefaultStorageDir(), 'config.json');
}

function migrateConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const printers = Array.isArray(source.printers)
    ? source.printers.map(normalizeLegacyPrinter).filter(Boolean)
    : [];

  const migrated = {
    version: CONFIG_VERSION,
    port: Number(source.port) || 9977,
    token: source.token || generateToken(),
    printers,
  };

  return configSchema.parse(migrated);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function classifyIpv4(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  if (/^169\.254\./.test(address)) return 4;
  if (/^127\./.test(address)) return 5;
  return 3;
}

function getSuggestedHosts(port) {
  const values = [];
  const interfaces = os.networkInterfaces();

  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (item.internal || item.family !== 'IPv4') continue;
      values.push(item.address);
    }
  }

  const unique = Array.from(new Set(values))
    .sort((left, right) => {
      const scoreDiff = classifyIpv4(left) - classifyIpv4(right);
      if (scoreDiff !== 0) return scoreDiff;
      return left.localeCompare(right, undefined, { numeric: true });
    })
    .map((address) => `http://${address}:${port}`);

  unique.push(`http://127.0.0.1:${port}`);
  return unique;
}

class ConfigStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.path = resolveConfigPath(options.configPath);
    this.config = this.#load();
  }

  #ensureDirectory() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
  }

  #load() {
    this.#ensureDirectory();

    if (!fs.existsSync(this.path)) {
      const defaults = buildDefaultConfig();
      fs.writeFileSync(this.path, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
      return defaults;
    }

    const raw = fs.readFileSync(this.path, 'utf8');
    const parsed = JSON.parse(raw);
    const migrated = migrateConfig(parsed);
    fs.writeFileSync(this.path, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
    return migrated;
  }

  #save(nextConfig) {
    this.config = configSchema.parse(nextConfig);
    fs.writeFileSync(this.path, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
    this.emit('change', clone(this.config));
    return this.getConfig();
  }

  getConfig() {
    return clone(this.config);
  }

  getConfigPath() {
    return this.path;
  }

  isConfigured() {
    return this.config.printers.some((printer) => printer.enabled !== false);
  }

  getPublicConfig() {
    return {
      ...this.getConfig(),
      __path: this.path,
      suggestedHosts: getSuggestedHosts(this.config.port),
    };
  }

  updateMeta(input) {
    const next = {
      ...this.config,
      port: Number(input.port) || this.config.port,
    };
    return this.#save(next);
  }

  createPrinter(input) {
    const candidate = normalizePrinterInput(input);
    candidate.id = ensureUniquePrinterId(this.config.printers, candidate.id || candidate.nombre);
    const printer = printerSchema.parse(candidate);
    return this.#save({
      ...this.config,
      printers: [...this.config.printers, printer],
    });
  }

  updatePrinter(id, input) {
    const index = this.config.printers.findIndex((printer) => printer.id === id);
    if (index === -1) throw new Error(`Impresora ${id} no configurada`);

    const merged = normalizePrinterInput({
      ...this.config.printers[index],
      ...input,
      connection: {
        ...this.config.printers[index].connection,
        ...(input.connection || {}),
      },
    });
    merged.id = ensureUniquePrinterId(this.config.printers, merged.id || id, id);
    const printer = printerSchema.parse(merged);
    const printers = [...this.config.printers];
    printers[index] = printer;
    return this.#save({ ...this.config, printers });
  }

  deletePrinter(id) {
    const printer = this.getPrinter(id);
    return {
      config: this.#save({
        ...this.config,
        printers: this.config.printers.filter((item) => item.id !== id),
      }),
      deleted: printer,
    };
  }

  duplicatePrinter(id) {
    const printer = this.getPrinter(id);
    const duplicate = {
      ...clone(printer),
      id: ensureUniquePrinterId(this.config.printers, `${printer.id}-copy`),
      nombre: `${printer.nombre} copia`,
    };
    return this.#save({
      ...this.config,
      printers: [...this.config.printers, duplicate],
    });
  }

  getPrinter(id) {
    const printer = this.config.printers.find((item) => item.id === id);
    if (!printer) throw new Error(`Impresora ${id} no configurada`);
    return clone(printer);
  }
}

function createConfigStore(options) {
  return new ConfigStore(options);
}

module.exports = {
  APP_STORAGE_DIR,
  APP_ALLOWED_ORIGINS,
  CONFIG_VERSION,
  ConfigStore,
  createConfigStore,
  generateToken,
  getDefaultStorageDir,
  getSuggestedHosts,
  normalizePrinterInput,
  printerSchema,
  slugifyPrinterId,
};
