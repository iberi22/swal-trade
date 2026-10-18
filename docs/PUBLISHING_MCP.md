# Publicación del paquete MCP

Este documento detalla los pasos manuales que debe seguir el propietario del repositorio para publicar el paquete `@swal-trade/mcp` en npm usando GitHub Actions (con un dry run previo) o de forma local.

## Prerrequisitos

1. **Crear un token de npm:**
   Genera un *automation token* granular en tu cuenta de npm, limitando su alcance (`scope`) únicamente al paquete `@swal-trade/mcp`.

2. **Configurar el secreto en GitHub:**
   Añade el token creado como un secreto de repositorio (Repository Secret) con el nombre exacto `NPM_TOKEN`.

## Publicación vía GitHub Actions

El flujo de publicación está diseñado para ser manual y verificar la integridad del paquete antes de lanzarlo.

1. **Dry run (Modo de prueba):**
   - Ve a la pestaña **Actions** en GitHub.
   - Selecciona el flujo de trabajo **Publish MCP**.
   - Ejecútalo con la opción `dry_run` marcada como `true` (por defecto).
   - Inspecciona los logs para asegurarte de que el empaquetado, los tests y las comprobaciones estáticas se ejecutan correctamente.

2. **Publicación real:**
   - Si el *dry run* fue exitoso, vuelve a ejecutar el flujo.
   - Esta vez, desmarca la opción `dry_run` (estableciéndola a `false`).
   - El flujo empaquetará, verificará y finalmente publicará el paquete usando `--provenance`.

3. **Verificación final:**
   - Una vez que la tarea de publicación se haya fusionado y ejecutado, verifica que la instalación funcione correctamente con:
     ```bash
     npx -y @swal-trade/mcp doctor
     ```

## Publicación Local

Si necesitas publicar el paquete de forma manual desde tu máquina local (equivalente a lo que hace el flujo de trabajo), ejecuta los siguientes comandos:

```bash
cd packages/mcp
npm run build
node scripts/verify-pack.mjs
npm publish --access public
```
