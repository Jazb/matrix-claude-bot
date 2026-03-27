# Tests

The project includes 23 unit tests using [vitest](https://vitest.dev/). The tests cover pure components that do not depend on external services (Matrix, Claude, Groq).

## Running tests

```bash
# Run once
npm test

# Watch mode (re-runs when files change)
npm run test:watch
```

## Test suites

### `tests/split-message.test.ts` (7 tests)

Covers the `splitMessage` function that splits long messages:

- Text that fits in a single chunk
- Empty string
- Split by line breaks
- Split by spaces when there are no newlines
- Hard cut when there are no break points
- Text with length exactly at the limit
- Verification that all chunks respect the limit

### `tests/serial-queue.test.ts` (5 tests)

Covers the `SerialQueue` class:

- Initial state (not busy, length 0)
- Execution of a simple task
- Serial execution (order preserved)
- Error handling without blocking the queue
- Correct queue length with multiple tasks

### `tests/session.test.ts` (6 tests)

Covers the `SessionStore` class:

- Returns null for unknown rooms
- Stores and retrieves session data
- Persistence between instances (writes/reads from disk)
- Session cleanup
- Merge of partial updates
- Handling of corrupt file (graceful degradation)

### `tests/config-loader.test.ts` (5 tests)

Covers the `loadConfig` function:

- Loads all required variables
- Uses sensible defaults for optional ones
- Parses multiple projects
- Defaults to the first project
- Respects `DEFAULT_PROJECT` override

## What is not tested (and why)

| Component | Reason |
|-----------|--------|
| `ClaudeRunner` | Depends on spawning an external process (claude). Would require mocking the file system and child_process. |
| `GroqTranscriber` | Depends on the Groq API. Could be tested with fetch mocks, but the value is low for such a thin wrapper. |
| `MatrixClientWrapper` | Depends on matrix-bot-sdk and a real homeserver. Could be tested with mocks but adds complexity without much benefit. |
| `index.ts` (event handlers) | Full integration. Would require simulating Matrix events end-to-end. |

For these components, the primary validation is TypeScript's type checking (`npm run typecheck`) and the manual tests described in the quick start guide.

## Adding tests

Tests are placed in `tests/` with a `.test.ts` extension. Vitest discovers them automatically.

```typescript
import { describe, it, expect } from "vitest";

describe("MyComponent", () => {
  it("does something expected", () => {
    expect(1 + 1).toBe(2);
  });
});
```

The vitest configuration is in `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 10_000,
  },
});
```
