# Ventysfy Print Agent

Agente local de impresion ESC/POS para Ventysfy POS con dos capas:

- `agent core`: servidor HTTP local para `/health`, `/print`, `/open-drawer` y ticket de prueba.
- `desktop shell`: ventana de configuracion + tray para usuarios finales.

La ruta tecnica `http://127.0.0.1:9977/app` sigue existiendo, pero el flujo esperado para cliente final es abrir la app de escritorio.

## Desarrollo

```bash
npm install
npm start
```

Esto abre la app de escritorio con Electron y levanta el agente local.
Antes de abrir la ventana compila la UI con Tailwind CSS 4 + daisyUI a `src/public/app.generated.css`.

Si vas a iterar sobre la UI:

```bash
npm run dev
```

Eso deja corriendo el watcher de CSS y Electron en paralelo.

Si necesitas solo el servidor HTTP sin shell:

```bash
npm run start:agent
```

Si solo quieres regenerar estilos:

```bash
npm run build:css
```

## Empaquetado

En Windows el instalador recompila dependencias nativas usadas por impresoras seriales/USB,
por ejemplo `serialport`. Para que `npm run dist:win` funcione necesitas tener disponible
la toolchain de `node-gyp` en la misma terminal:

- Python 3 instalado y visible como `python` o `py`.
- Visual Studio Build Tools o Visual Studio Community con la carga "Desktop development with C++".
- Node/npm disponibles en el `PATH`.

Importante: Visual Studio Code no alcanza para este paso. Debes instalar "Visual Studio Build Tools"
o Visual Studio Community y seleccionar estos componentes:

- MSVC C++ x64/x86 build tools.
- Windows 10/11 SDK.
- C++ CMake tools for Windows.

Comprobacion rapida:

```powershell
python --version
npm config get python
npm run dist:win
```

Si Python esta instalado pero `node-gyp` no lo encuentra, configura la ruta explicitamente:

```powershell
npm config set python "C:\Users\TU_USUARIO\AppData\Local\Programs\Python\Python312\python.exe"
```

Si `npm run dev` falla con `Electron failed to install correctly`, el paquete `electron`
quedo instalado sin descargar el binario de Windows. Reinstala solo Electron:

```powershell
npm config get ignore-scripts
npm run repair:electron
npm run dev
```

Si `ignore-scripts` devuelve `true`, activalo y reinstala:

```powershell
npm config set ignore-scripts false
npm run repair:electron
```

Si el problema persiste, revisa que no tengas desactivada la descarga del binario:

```powershell
echo $env:ELECTRON_SKIP_BINARY_DOWNLOAD
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD
npm run repair:electron
```

En Git Bash:

```bash
echo "$ELECTRON_SKIP_BINARY_DOWNLOAD"
unset ELECTRON_SKIP_BINARY_DOWNLOAD
npm run repair:electron
```

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

### Distribucion real en macOS

Para que otra gente pueda descargar la app desde GitHub Releases e instalarla sin el error
`"...app" is damaged and can't be opened`, el build de macOS debe salir firmado y notarizado.
Abrir el `.dmg` en la misma maquina donde compilaste no valida ese escenario: Gatekeeper se pone
serio cuando el archivo viene descargado de internet.

Este repo ya incluye:

- `mac.hardenedRuntime`, `entitlements` y `notarize` en `package.json`.
- `build/entitlements.mac.plist` y `build/entitlements.mac.inherit.plist`.
- `npm run verify:mac` para validar el `.dmg` con `spctl` y `stapler`.
- `.github/workflows/release-macos.yml` para firmar, notarizar y adjuntar artefactos al Release.

Secrets requeridos en GitHub Actions:

- `MAC_CSC_LINK`: certificado `Developer ID Application` exportado a `.p12` y codificado en base64.
- `MAC_CSC_KEY_PASSWORD`: password del `.p12`.
- `APPLE_API_KEY`: contenido del archivo `.p8` de App Store Connect codificado en base64.
- `APPLE_API_KEY_ID`: Key ID del API key.
- `APPLE_API_ISSUER`: Issuer ID del API key.
- `APPLE_TEAM_ID`: Apple Team ID.

Ejemplo para generar el secret del certificado:

```bash
base64 -i developer-id-application.p12 | pbcopy
```

Ejemplo para generar el secret del API key:

```bash
base64 -i AuthKey_ABC123XYZ.p8 | pbcopy
```

Flujo recomendado:

1. Crear el Release en GitHub.
2. Publicarlo.
3. Dejar que corra `Release macOS`.
4. Descargar el `.dmg` generado por ese workflow, no uno construido manualmente sin firma.

Comprobacion local del artefacto final:

```bash
npm run verify:mac
```

## Flujo para el usuario

1. Abrir `Ventysfy Print Agent`.
2. Revisar el token y el host sugerido.
3. Agregar impresoras por red, USB o Bluetooth desde la UI.
4. Ejecutar ticket de prueba.
5. Pegar host/token en la configuracion del POS.
6. Cerrar la ventana: la app sigue viva en bandeja.

## Tipos de impresora

### Red / Ethernet / Wi-Fi

- Permite alta manual por `host:puerto`.
- Incluye escaneo LAN al puerto `9100`.

### USB

- Intenta detectar dispositivos USB tipo impresora.
- Si la deteccion es parcial, la UI permite fallback manual.
- En Windows puede requerir WinUSB/Zadig para acceso directo.

### Bluetooth / Serial

- La impresora debe estar emparejada con el sistema operativo primero.
- La UI lista puertos seriales detectables y permite fallback manual.

## Configuracion persistida

El archivo `config.json` se guarda en una ruta estable del sistema:

- macOS: `~/Library/Application Support/Ventysfy Print Agent/config.json`
- Windows: `%APPDATA%/Ventysfy Print Agent/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/ventysfy-print-agent/config.json`

Ese archivo se crea automaticamente si no existe y se valida contra el schema actual:

```json
{
  "version": 2,
  "port": 9977,
  "token": "token-generado",
  "printers": []
}
```

Los dominios permitidos por CORS no se editan en `config.json`. Salen del codigo del agente y se definen en `APP_ALLOWED_ORIGINS` dentro de `src/config.js`.

## Endpoints estables para el POS

- `GET /health`
- `POST /print`
- `POST /open-drawer`
- `POST /test/:printerId`

Todos requieren `x-agent-token` excepto `/health`.

`POST /print` recibe un envelope con la impresora destino y un trabajo lógico en inglés:

```json
{
  "printerId": "kitchen-printer-1",
  "job": {
    "version": 1,
    "widthMm": 80,
    "reason": "kitchen-order",
    "jobId": "unique-job-id",
    "blocks": [
      {
        "type": "text",
        "content": "KITCHEN",
        "align": "center",
        "bold": true,
        "size": 2
      },
      { "type": "separator", "style": "solid" },
      { "type": "cut" }
    ]
  }
}
```

Tipos de bloque soportados: `logo`, `text`, `table-row`, `separator`, `feed`, `qr`, `barcode`, `cut` y `open-drawer`.

## API local de configuracion

Usada por la app local:

- `GET /api/status`
- `GET /api/config`
- `PUT /api/config`
- `POST /api/printers`
- `PUT /api/printers/:id`
- `DELETE /api/printers/:id`
- `POST /api/printers/:id/duplicate`
- `POST /api/printers/:id/test`
- `POST /api/printers/:id/open-drawer`
- `POST /api/printers/discover/network`
- `POST /api/printers/discover/usb`
- `POST /api/printers/discover/bluetooth`

## Notas

- La UI de configuracion esta pensada para correr localmente dentro de la app de escritorio.
- El agente sigue escuchando en `0.0.0.0` para que otras PCs del local puedan apuntar al host LAN correcto.
- `127.0.0.1` sigue siendo el host recomendado cuando el POS y el agente corren en la misma PC.
