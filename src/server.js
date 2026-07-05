const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const { z } = require('zod');
const pkg = require('../package.json');
const {
  APP_ALLOWED_ORIGINS,
  createConfigStore,
  getSuggestedHosts,
  normalizePrinterInput,
} = require('./config');
const {
  checkPrinterConnection,
  discoverBluetoothPrinters,
  discoverNetworkPrinters,
  discoverUsbPrinters,
} = require('./discovery');
const { openDrawer, printJob, testPrint } = require('./printer');

const printSchema = z.object({
  printerId: z.string().min(1),
  job: z.object({
    ancho: z.number().optional(),
    bloques: z.array(z.record(z.any())),
  }),
});

function wildcardToRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

function isTrustedAppOrigin(origin, port) {
  if (!origin) return true;
  const trusted = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return trusted.has(origin);
}

function sanitizePrinterForUi(printer) {
  return {
    id: printer.id,
    nombre: printer.nombre,
    tipo: printer.tipo,
    anchoMm: printer.anchoMm,
    codepage: printer.codepage,
    abreCajon: printer.abreCajon,
    enabled: printer.enabled,
    connection: printer.connection,
  };
}

function sanitizeConnection(connection) {
  if (!connection) return null;
  return {
    host: connection.host,
    port: connection.port,
    path: connection.path,
    baudRate: connection.baudRate,
    vendorId: connection.vendorId,
    productId: connection.productId,
    serialNumber: connection.serialNumber,
    displayName: connection.displayName,
  };
}

function createDiagnosticEntry(printer, operation) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    printerId: printer.id,
    printerName: printer.nombre,
    transport: printer.tipo,
    operation,
    connection: sanitizeConnection(printer.connection),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    ok: false,
    message: null,
    steps: [],
  };
}

function createAgentServer(options = {}) {
  const store = options.store || createConfigStore({
    configPath: options.configPath,
  });
  const fastify = Fastify({ logger: { level: options.logLevel || 'info' } });
  const runtime = {
    lastTestByPrinter: new Map(),
    lastDiagnosticByPrinter: new Map(),
    recentDiagnostics: [],
  };

  function getConfig() {
    return store.getConfig();
  }

  function getPort() {
    return Number(getConfig().port) || 9977;
  }

  function findPrinter(id) {
    return store.getPrinter(id);
  }

  async function getPrinterRuntimeStatus(printer) {
    const connection = await checkPrinterConnection(printer);
    return {
      connection,
      lastTest: runtime.lastTestByPrinter.get(printer.id) || null,
      lastDiagnostic: runtime.lastDiagnosticByPrinter.get(printer.id) || null,
    };
  }

  async function getStatusPayload() {
    const config = store.getConfig();
    const printers = await Promise.all(config.printers.map(async (printer) => ({
      ...sanitizePrinterForUi(printer),
      runtime: await getPrinterRuntimeStatus(printer),
    })));

    return {
      ok: true,
      version: pkg.version,
      port: config.port,
      configPath: store.getConfigPath(),
      token: config.token,
      suggestedHosts: getSuggestedHosts(config.port),
      configured: store.isConfigured(),
      diagnostics: runtime.recentDiagnostics.slice(0, 20),
      printers,
    };
  }

  function pushDiagnostic(entry) {
    runtime.lastDiagnosticByPrinter.set(entry.printerId, entry);
    runtime.recentDiagnostics.unshift(entry);
    runtime.recentDiagnostics = runtime.recentDiagnostics.slice(0, 50);
  }

  async function runPrinterOperation(printer, operation, action) {
    const startedAtMs = Date.now();
    const diagnostic = createDiagnosticEntry(printer, operation);
    const hooks = {
      onEvent(stage, detail = {}) {
        diagnostic.steps.push({
          at: new Date().toISOString(),
          stage,
          ...detail,
        });
      },
    };

    hooks.onEvent('operation_start');

    try {
      const result = await action(hooks);
      diagnostic.ok = true;
      diagnostic.message = 'Operacion completada sin error del sistema';
      hooks.onEvent('operation_ok');
      return { diagnostic, result };
    } catch (error) {
      diagnostic.ok = false;
      diagnostic.message = error.message;
      hooks.onEvent('operation_error', { error: error.message });
      throw error;
    } finally {
      diagnostic.finishedAt = new Date().toISOString();
      diagnostic.durationMs = Date.now() - startedAtMs;
      pushDiagnostic(diagnostic);
    }
  }

  fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isTrustedAppOrigin(origin, getPort())) return cb(null, true);
      const patterns = APP_ALLOWED_ORIGINS.map((item) => (item === '*' ? () => true : wildcardToRegex(item)));
      const ok = patterns.some((pattern) => (typeof pattern === 'function' ? pattern() : pattern.test(origin)));
      if (ok) return cb(null, true);
      cb(new Error(`Origen no permitido: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-agent-token'],
  });

  fastify.addHook('onSend', async (req, reply, payload) => {
    if (req.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
    return payload;
  });

  fastify.addHook('onRequest', async (req, reply) => {
    const port = getPort();

    if (req.url.startsWith('/api/')) {
      if (!isTrustedAppOrigin(req.headers.origin, port)) {
        return reply.code(403).send({ ok: false, error: 'Solo la app local puede usar la API de configuracion' });
      }
      return;
    }

    if (
      req.url === '/health'
      || req.url === '/app'
      || req.url === '/setup'
      || req.url.startsWith('/assets/')
      || req.method === 'OPTIONS'
    ) {
      return;
    }

    const token = req.headers['x-agent-token'];
    if (!getConfig().token || token !== getConfig().token) {
      return reply.code(401).send({ ok: false, error: 'token invalido' });
    }
  });

  fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/assets/',
  });

  fastify.get('/app', async (req, reply) => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.get('/setup', async (req, reply) => {
    return reply.redirect('/app');
  });

  fastify.get('/health', async () => {
    const config = getConfig();
    return {
      ok: true,
      version: pkg.version,
      suggestedHosts: getSuggestedHosts(config.port),
      setupUrl: '/app',
      printers: config.printers.map((printer) => ({
        id: printer.id,
        nombre: printer.nombre,
        tipo: printer.tipo,
      })),
    };
  });

  fastify.get('/api/status', async () => getStatusPayload());

  fastify.get('/api/config', async () => ({
    ok: true,
    config: store.getPublicConfig(),
  }));

  fastify.get('/api/diagnostics/recent', async () => ({
    ok: true,
    items: runtime.recentDiagnostics,
  }));

  fastify.put('/api/config', async (req, reply) => {
    try {
      const next = store.updateMeta(req.body || {});
      return reply.send({ ok: true, config: next });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/api/printers', async (req, reply) => {
    try {
      const config = store.createPrinter(normalizePrinterInput(req.body || {}));
      return reply.send({ ok: true, config });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  fastify.put('/api/printers/:id', async (req, reply) => {
    try {
      const config = store.updatePrinter(req.params.id, normalizePrinterInput(req.body || {}));
      return reply.send({ ok: true, config });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  fastify.delete('/api/printers/:id', async (req, reply) => {
    try {
      const result = store.deletePrinter(req.params.id);
      runtime.lastTestByPrinter.delete(req.params.id);
      runtime.lastDiagnosticByPrinter.delete(req.params.id);
      runtime.recentDiagnostics = runtime.recentDiagnostics.filter((item) => item.printerId !== req.params.id);
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/api/printers/:id/duplicate', async (req, reply) => {
    try {
      const config = store.duplicatePrinter(req.params.id);
      return reply.send({ ok: true, config });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/api/printers/discover/network', async () => ({
    ok: true,
    items: await discoverNetworkPrinters(),
  }));

  fastify.post('/api/printers/discover/usb', async () => ({
    ok: true,
    ...(await discoverUsbPrinters()),
  }));

  fastify.post('/api/printers/discover/bluetooth', async () => ({
    ok: true,
    ...(await discoverBluetoothPrinters()),
  }));

  fastify.post('/api/printers/:id/test', async (req, reply) => {
    try {
      const printer = findPrinter(req.params.id);
      await runPrinterOperation(printer, 'test-print', (hooks) => testPrint(printer, hooks));
      runtime.lastTestByPrinter.set(printer.id, {
        ok: true,
        at: new Date().toISOString(),
        message: 'Prueba enviada correctamente',
      });
      return reply.send({ ok: true });
    } catch (error) {
      runtime.lastTestByPrinter.set(req.params.id, {
        ok: false,
        at: new Date().toISOString(),
        message: error.message,
      });
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/api/printers/:id/open-drawer', async (req, reply) => {
    try {
      const printer = findPrinter(req.params.id);
      await runPrinterOperation(printer, 'open-drawer', (hooks) => openDrawer(printer, hooks));
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/print', async (req, reply) => {
    const parsed = printSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message });
    }

    try {
      const printer = findPrinter(parsed.data.printerId);
      await runPrinterOperation(printer, 'print-job', (hooks) => printJob(printer, parsed.data.job, hooks));
      return reply.send({ ok: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/open-drawer', async (req, reply) => {
    try {
      const printer = findPrinter((req.body || {}).printerId);
      await runPrinterOperation(printer, 'open-drawer', (hooks) => openDrawer(printer, hooks));
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });

  fastify.post('/test/:printerId', async (req, reply) => {
    try {
      const printer = findPrinter(req.params.printerId);
      await runPrinterOperation(printer, 'test-print', (hooks) => testPrint(printer, hooks));
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });

  return {
    fastify,
    store,
    async start() {
      const port = getPort();
      await fastify.listen({ port, host: '0.0.0.0' });
      fastify.log.info(`Ventysfy Print Agent v${pkg.version} escuchando en http://localhost:${port}`);
      fastify.log.info(`Config: ${store.getConfigPath()}`);
      fastify.log.info(`App: http://127.0.0.1:${port}/app`);
      return this;
    },
    async stop() {
      await fastify.close();
    },
    getPort,
    getAppUrl() {
      return `http://127.0.0.1:${getPort()}/app`;
    },
    getHostSummary() {
      return getSuggestedHosts(getPort());
    },
  };
}

module.exports = {
  createAgentServer,
};
