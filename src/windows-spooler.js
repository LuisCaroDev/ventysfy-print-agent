const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { normalizeHexId } = require('./usb-ids');

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function getPortNameFromUsbPrint(value) {
  const text = String(value || '');
  const match = text.match(/(?:\\|&)(USB\d+)$/i);
  if (!match) return null;
  return match[1];
}

async function resolveWindowsPrinterName(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Falta el nombre de impresora de Windows');
  if (!/^USBPRINT\\/i.test(raw)) return raw;

  const portName = getPortNameFromUsbPrint(raw);
  if (!portName) {
    throw new Error(`No se pudo extraer el puerto USB de ${raw}`);
  }

  const command = [
    `$printer = Get-Printer | Where-Object { $_.PortName -eq '${portName.replace(/'/g, "''")}' } | Select-Object -First 1 -ExpandProperty Name`,
    'if (-not $printer) { exit 2 }',
    '$printer',
  ].join('; ');

  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command]);
    const printerName = stdout.trim();
    if (!printerName) throw new Error(`No se encontro impresora en el puerto ${portName}`);
    return printerName;
  } catch (error) {
    const detail = String(error.stderr || error.message || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    throw new Error(`No se pudo resolver ${portName} a una impresora de Windows${detail ? `: ${detail}` : ''}`);
  }
}

function normalizePnpList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => item && typeof item === 'object');
}

function sameFriendlyName(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

async function resolveWindowsPrinterNameByUsbIds(vendorId, productId) {
  const vid = normalizeHexId(vendorId)?.replace(/^0x/i, '').toUpperCase();
  const pid = normalizeHexId(productId)?.replace(/^0x/i, '').toUpperCase();
  if (!vid || !pid) {
    throw new Error('Faltan vendorId/productId para resolver la impresora de Windows');
  }

  const escapedPattern = `VID_${vid}.*PID_${pid}`;
  const command = [
    '$devices = Get-PnpDevice -PresentOnly | Select-Object FriendlyName,InstanceId',
    `$matches = $devices | Where-Object { $_.InstanceId -match '${escapedPattern}' -or $_.InstanceId -like 'USBPRINT\\*' }`,
    '$matches | ConvertTo-Json -Compress',
  ].join('; ');

  let devices;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command]);
    devices = normalizePnpList(JSON.parse(stdout || '[]'));
  } catch (error) {
    const detail = String(error.stderr || error.message || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    throw new Error(`No se pudo consultar dispositivos PnP de Windows${detail ? `: ${detail}` : ''}`);
  }

  const usbDevice = devices.find((item) => new RegExp(escapedPattern, 'i').test(String(item.InstanceId || '')));
  const printerCandidates = devices.filter((item) => /^USBPRINT\\/i.test(String(item.InstanceId || '')));
  const matchedPrinter = printerCandidates.find((item) => sameFriendlyName(item.FriendlyName, usbDevice?.FriendlyName))
    || (printerCandidates.length === 1 ? printerCandidates[0] : null);

  if (!matchedPrinter) {
    throw new Error(`No se encontro impresora Windows asociada a VID/PID 0x${vid}:0x${pid}`);
  }

  return resolveWindowsPrinterName(matchedPrinter.InstanceId);
}

function buildRawPrintScript() {
  return `
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$DataPath,
  [string]$DocumentName = "Ventysfy ESC/POS"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);

  public static void SendBytes(string printerName, string dataPath, string documentName) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = documentName;
      di.pDataType = "RAW";
      byte[] bytes = System.IO.File.ReadAllBytes(dataPath);
      int written;

      if (!StartDocPrinter(hPrinter, 1, di)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (!StartPagePrinter(hPrinter)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (!WritePrinter(hPrinter, bytes, bytes.Length, out written)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (written != bytes.Length) throw new Exception("No se escribieron todos los bytes al spooler.");
      EndPagePrinter(hPrinter);
      EndDocPrinter(hPrinter);
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
"@

[RawPrinterHelper]::SendBytes($PrinterName, $DataPath, $DocumentName)
`;
}

async function printRawToWindowsPrinter(printerNameOrId, data, documentName = 'Ventysfy ESC/POS') {
  if (process.platform !== 'win32') {
    throw new Error('La impresion por spooler solo esta disponible en Windows');
  }

  const printerName = await resolveWindowsPrinterName(printerNameOrId);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ventysfy-print-'));
  const dataPath = path.join(dir, 'job.bin');
  const scriptPath = path.join(dir, 'print-raw.ps1');

  try {
    await fs.writeFile(dataPath, data);
    await fs.writeFile(scriptPath, buildRawPrintScript(), 'utf8');
    await execFileAsync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-PrinterName',
      printerName,
      '-DataPath',
      dataPath,
      '-DocumentName',
      documentName,
    ]);
    return printerName;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = {
  printRawToWindowsPrinter,
  resolveWindowsPrinterName,
  resolveWindowsPrinterNameByUsbIds,
};
