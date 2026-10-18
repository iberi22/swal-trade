# Proceso de Release

Lista de comprobación para marcar un nuevo tag estable en el proyecto.
Sigue este orden estrictamente para garantizar que radar, MCP, extensión, guardián y sitio web están alineados, probados, son honestos, y listos para su uso público.

## Checklist

- [ ] 1. **Verificación de versiones, licencia y limpieza:** Ejecuta en la raíz:
      `node scripts/release-check.mjs --version X.Y.Z`
      *Esto asegura que los 4 campos de versión coinciden, que las licencias son `AGPL-3.0-only`, y que el árbol de Git está limpio.*
- [ ] 2. **CI Verde:** Verifica que todos los flujos de integración continua pasaron para la rama actual.
- [ ] 3. **Verificación MCP:**
      `cd packages/mcp && node scripts/verify-pack.mjs`
- [ ] 4. **Empaquetar Extensión:**
      Ejecutar `npm run zip` dentro de `apps/extension` para empaquetarla.
- [ ] 5. **Actualizar CHANGELOG:** Asegúrate de que `CHANGELOG.md` tenga la sección `## [X.Y.Z]` actualizada con fecha (cambiar `unreleased` por la fecha real `YYYY-MM-DD`).
- [ ] **Requiere Owner** 6. **Crear Tag de Git:** Crear tag anotado y firmado con los cambios.
      `git tag -s vX.Y.Z -m "Release vX.Y.Z"`
- [ ] **Requiere Owner** 7. **Crear Release en GitHub:**
      `gh release create vX.Y.Z` utilizando las notas de la sección correspondiente del `CHANGELOG.md`.
- [ ] **Requiere Owner** 8. **Despliegue Manual del Sitio:**
      `cd workers/public-site && npx wrangler@4.149.0 deploy`
