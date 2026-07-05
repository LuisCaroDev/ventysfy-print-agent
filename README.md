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
