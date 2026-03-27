# Tests

El proyecto incluye 23 tests unitarios usando [vitest](https://vitest.dev/). Los tests cubren los componentes puros que no dependen de servicios externos (Matrix, Claude, Groq).

## Ejecutar tests

```bash
# Ejecutar una vez
npm test

# Modo watch (re-ejecuta al modificar ficheros)
npm run test:watch
```

## Suites de test

### `tests/split-message.test.ts` (7 tests)

Cubre la funcion `splitMessage` que divide mensajes largos:

- Texto que cabe en un solo chunk
- String vacio
- Split por saltos de linea
- Split por espacios cuando no hay newlines
- Corte duro cuando no hay puntos de quiebre
- Texto con longitud exacta al limite
- Verificacion de que todos los chunks respetan el limite

### `tests/serial-queue.test.ts` (5 tests)

Cubre la clase `SerialQueue`:

- Estado inicial (no busy, length 0)
- Ejecucion de una tarea simple
- Ejecucion serial (orden preservado)
- Manejo de errores sin bloquear la cola
- Longitud de cola correcta con multiples tareas

### `tests/session.test.ts` (6 tests)

Cubre la clase `SessionStore`:

- Retorna null para rooms desconocidos
- Almacena y recupera datos de sesion
- Persistencia entre instancias (escribe/lee de disco)
- Limpieza de sesion
- Merge de actualizaciones parciales
- Manejo de fichero corrupto (graceful degradation)

### `tests/config-loader.test.ts` (5 tests)

Cubre la funcion `loadConfig`:

- Carga todas las variables requeridas
- Usa defaults sensatos para opcionales
- Parsea multiples proyectos
- Default al primer proyecto
- Respeta override de `DEFAULT_PROJECT`

## Que no se testea (y por que)

| Componente | Razon |
|-----------|-------|
| `ClaudeRunner` | Depende de spawn de un proceso externo (claude). Necesitaria mocks del sistema de ficheros y child_process. |
| `GroqTranscriber` | Depende de la API de Groq. Se podria testear con mocks de fetch, pero el valor es bajo para un wrapper tan fino. |
| `MatrixClientWrapper` | Depende de matrix-bot-sdk y un homeserver real. Se podria testear con mocks pero agrega complejidad sin mucho beneficio. |
| `index.ts` (event handlers) | Integracion completa. Requeriria simular eventos Matrix end-to-end. |

Para estos componentes, la validacion principal es el typecheck de TypeScript (`npm run typecheck`) y las pruebas manuales descritas en la guia de inicio rapido.

## Agregar tests

Los tests se colocan en `tests/` con extension `.test.ts`. Vitest los descubre automaticamente.

```typescript
import { describe, it, expect } from "vitest";

describe("MiComponente", () => {
  it("hace algo esperado", () => {
    expect(1 + 1).toBe(2);
  });
});
```

La configuracion de vitest esta en `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 10_000,
  },
});
```
