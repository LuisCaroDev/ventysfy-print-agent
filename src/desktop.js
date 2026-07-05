const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  nativeImage,
} = require('electron');
const { createAgentServer } = require('./server');

let tray = null;
let mainWindow = null;
let agent = null;
let quitting = false;

function getBuildAssetPath(fileName) {
  return path.join(__dirname, '..', 'build', fileName);
}

function createAppIcon() {
  if (process.platform === 'darwin') {
    return nativeImage.createFromPath(getBuildAssetPath('icon.mac-source.png'));
  }
  return nativeImage.createFromPath(getBuildAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
}

function createWindowIcon() {
  return createAppIcon();
}

function getDesktopConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function createTrayIcon() {
  const image = createAppIcon();
  return process.platform === 'win32' ? image.resize({ width: 16, height: 16 }) : image;
}

function ensureWindow() {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Ventysfy Print Agent',
    icon: createWindowIcon(),
    backgroundColor: '#f3efe4',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  return mainWindow;
}

async function showWindow() {
  const window = ensureWindow();
  await window.loadURL(agent.getAppUrl());
  window.show();
  window.focus();
}

async function restartAgent() {
  if (agent) {
    await agent.stop();
  }
  agent = createAgentServer({
    configPath: getDesktopConfigPath(),
  });
  await agent.start();
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(agent.getAppUrl());
  }
  buildTray();
}

function buildTray() {
  if (!tray) {
    tray = new Tray(createTrayIcon());
  }

  const config = agent.store.getConfig();
  const printers = config.printers;

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir Ventysfy Print Agent',
      click: () => showWindow(),
    },
    {
      label: 'Copiar token',
      click: () => {
        clipboard.writeText(config.token);
        dialog.showMessageBox({ message: 'Token copiado al portapapeles.' });
      },
    },
    {
      label: 'Mostrar host/IP',
      click: () => {
        dialog.showMessageBox({
          title: 'Hosts del agente',
          message: agent.getHostSummary().join('\n'),
        });
      },
    },
    {
      label: 'Imprimir ticket de prueba',
      enabled: printers.length > 0,
      click: async () => {
        const firstPrinter = printers[0];
        if (!firstPrinter) return;
        try {
          await fetch(`${agent.getAppUrl().replace('/app', '')}/api/printers/${firstPrinter.id}/test`, {
            method: 'POST',
          });
        } catch (error) {
          dialog.showErrorBox('No se pudo imprimir', error.message);
        }
      },
    },
    {
      label: 'Reiniciar agente',
      click: () => restartAgent(),
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: async () => {
        quitting = true;
        if (tray) tray.destroy();
        if (agent) await agent.stop();
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Ventysfy Print Agent');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

async function bootstrap() {
  app.setName('Ventysfy Print Agent');
  app.setAppUserModelId('com.ventysfy.printagent');
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(createAppIcon());
  }
  agent = createAgentServer({
    configPath: getDesktopConfigPath(),
  });
  await agent.start();
  buildTray();

  const shouldOpenWindow = !agent.store.isConfigured();
  if (shouldOpenWindow) {
    await showWindow();
  } else {
    ensureWindow();
    await mainWindow.loadURL(agent.getAppUrl());
  }

  app.on('activate', () => showWindow());
}

app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox('Ventysfy Print Agent', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (!quitting) {
    ensureWindow().hide();
  }
});
