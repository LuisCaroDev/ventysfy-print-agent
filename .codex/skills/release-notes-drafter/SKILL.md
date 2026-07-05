---
name: release-notes-drafter
description: Draft ready-to-paste release notes or GitHub release bodies for Ventysfy Print Agent versions and tags. Use when the user asks for a new release text, changelog, version announcement, or release body for this repo, especially concise Markdown with Windows and macOS download notes.
---

# Release Notes Drafter

## Output Rules

- Produce the release text directly, with minimal preamble.
- Prefer ready-to-paste Markdown.
- Use the version or tag the user provided; if missing, infer it from `package.json` when available.
- Keep the tone concise and practical.
- Include platform-specific notes when relevant, especially Windows and macOS builds.
- Include the macOS quarantine command when the user asks for it or when the app is likely to trigger Gatekeeper warnings.

## Default Structure

Use this structure unless the user asks for something else:

```md
Ventysfy Print Agent v<version>

<short version summary>

### Descargar
- Windows: descarga el instalador `.exe` adjunto en esta release.
- macOS: descarga el instalador `.dmg` adjunto en esta release.

### Incluye
- Punto clave 1.
- Punto clave 2.
- Punto clave 3.

### Estado de la versión
Texto breve sobre estabilidad, pre-release o validación.

### Nota para macOS
Si macOS bloquea la app por advertencia de seguridad, ejecutar en Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Ventysfy Print Agent.app"
```
```

## Prompt Patterns

- "Genera la release de la versión `x.y.z`."
- "Dame el texto para publicar esta nueva versión."
- "Arma el release note para Windows y macOS."
- "Hazlo corto y listo para pegar en GitHub."
