const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { downloadArtifact } = require('@electron/get');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const electronExe = path.join(distDir, 'electron.exe');
const pathFile = path.join(electronDir, 'path.txt');
const installScript = path.join(electronDir, 'install.js');

function cleanIncompleteInstall () {
  if (fs.existsSync(pathFile)) {
    fs.rmSync(pathFile, { force: true });
  }

  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

function assertElectronPackage () {
  if (!fs.existsSync(installScript)) {
    console.error('No se encontro node_modules/electron/install.js. Ejecuta npm install primero.');
    process.exit(1);
  }
}

function isElectronInstalled () {
  return fs.existsSync(electronExe) && fs.existsSync(pathFile);
}

function printFailure () {
  const distEntries = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];

  console.error('Electron sigue incompleto.');
  console.error(`Esperado: ${electronExe}`);
  console.error(`Contenido de dist: ${distEntries.length ? distEntries.join(', ') : '(vacio o inexistente)'}`);
  console.error('Revisa si un proxy, antivirus o variable de Electron bloquea la descarga.');
}

function repairWithPostinstall () {
  const env = {
    ...process.env,
    force_no_cache: 'true',
    npm_config_platform: 'win32',
    npm_config_arch: process.arch === 'ia32' ? 'ia32' : 'x64'
  };

  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.npm_config_electron_skip_binary_download;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;

  return childProcess.spawnSync(process.execPath, [installScript], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit'
  });
}

async function repairWithDirectDownload () {
  const electronPackage = require(path.join(electronDir, 'package.json'));
  const checksums = require(path.join(electronDir, 'checksums.json'));
  const arch = process.arch === 'ia32' ? 'ia32' : 'x64';

  cleanIncompleteInstall();

  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    force: true,
    platform: 'win32',
    arch,
    checksums
  });

  console.log(`Zip descargado: ${zipPath}`);

  if (process.platform === 'win32') {
    const result = childProcess.spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force`
    ], {
      stdio: 'inherit'
    });

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } else {
    const extract = require('extract-zip');
    await extract(zipPath, { dir: distDir });
  }

  await fs.promises.writeFile(pathFile, 'electron.exe');
}

async function main () {
  assertElectronPackage();

  if (isElectronInstalled()) {
    console.log('Electron ya esta instalado correctamente.');
    return;
  }

  console.log('Reparando instalacion de Electron...');
  console.log(`Electron dir: ${electronDir}`);
  console.log(`Node arch: ${process.arch}`);

  cleanIncompleteInstall();

  const result = repairWithPostinstall();

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  if (!isElectronInstalled()) {
    console.log('El postinstall no dejo el binario. Intentando descarga directa...');
    await repairWithDirectDownload();
  }

  if (!isElectronInstalled()) {
    printFailure();
    process.exit(1);
  }

  console.log('Electron reparado correctamente.');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
