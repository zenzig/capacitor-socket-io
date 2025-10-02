# Capacitor Socket.IO Plugin Style Guide

This guide defines the canonical conventions for the Capacitor Socket.IO plugin project. Every
contributor—including automated tooling and AI coding assistants—must follow these rules when adding
or refactoring code. When in doubt, prefer clarity, explicit typing, and consistency with the
existing codebase.

## 1. Formatting & Syntax Rules

### 1.1 Indentation
- **TypeScript / JavaScript / JSON / YAML:** 2 spaces per indent level. This is enforced by Prettier
  (`@ionic/prettier-config`).
- **Swift / Java / Kotlin / Objective-C:** 4 spaces per indent level. Xcode and Android Studio should
  be configured accordingly.
- **Markdown:** 2 spaces for nested lists; otherwise follow Prettier defaults.

### 1.2 Line Length
- Target a soft limit of **120 characters** per line. Allow Prettier to decide final wrapping, but
  break long expressions manually when they hinder readability.
- For Markdown and documentation comments, keep lines under 100 characters when practical to ease
  diffs.

### 1.3 Semicolons
- **Always terminate statements with semicolons** in TypeScript/JavaScript. Let Prettier handle
  placement.

### 1.4 String Style
- Prefer **single quotes** for string literals in TypeScript/JavaScript.
- Use **template literals** when interpolation or multi-line strings are required.
- Reserve double quotes for JSON, HTML attributes, and platform files where they are idiomatic.

### 1.5 Braces and Brackets
- Adopt **K&R style** with opening braces on the same line as the declaration.
- Closing braces align with the matching declaration and are followed by a blank line when another
  top-level declaration follows.

### 1.6 Spacing and Blank Lines
- Leave a blank line between third-party imports and local imports.
- Group related constant declarations together and separate them from functions with a blank line.
- Use trailing commas in multi-line literals/arrays/objects where supported.
- Avoid multiple consecutive blank lines—one blank line is sufficient for separation.

### 1.7 Import Ordering and Grouping
1. Node/JS platform imports (e.g. `fs`, `path`).
2. External packages (alphabetical by module specifier).
3. Internal aliases or local files (alphabetical), using relative paths kept as short as possible.
4. Keep `import type` statements adjacent to their runtime counterparts to reduce duplication.

### 1.8 File Ending Rules
- Every file must end with a **single newline** (LF). The repository is configured for Unix line
  endings.

## 2. Naming Conventions

### 2.1 Variables, Constants, Functions, Methods
- **Variables & functions:** lower camelCase (`requestedEvents`, `buildOptions`).
- **Boolean variables:** prefix with verbs like `is`, `has`, `should`, or `can` when it aids clarity
  (`isSecure`, `hasArgs`).
- **Constants:** screaming snake case (`CORE_EVENTS`, `LOG_TAG`), even in TypeScript.

### 2.2 Classes, Interfaces, Types
- **Classes / Enums / Interfaces / Types:** PascalCase (`CapacitorSocketIOWeb`,
  `SocketEventPayload`).
- **Generics:** single uppercase letters or descriptive PascalCase (`T`, `SocketPayload`).

### 2.3 File and Folder Naming
- **TypeScript modules:** kebab-case or descriptive lower-case filenames (e.g. `web.ts`,
  `definitions.ts`). Prefer folder names that mirror module names when splitting functionality.
- **Swift / Objective-C / Java:** file names must match the primary type defined within.
- **Node scripts:** kebab-case with `.js` or `.mjs` extensions.
- **Configuration files:** use conventional names (`tsconfig.json`, `rollup.config.mjs`).

### 2.4 Test Files
- **Android (JUnit):** suffix with `Test.java` (`CapacitorSocketIOTest.java`).
- **iOS (XCTest):** suffix with `Tests.swift` (`CapacitorSocketIOPluginTests.swift`).
- **Future TypeScript tests:** place under `src/__tests__/` or `tests/` and suffix with `.spec.ts` or
  `.test.ts`.

## 3. Project Architecture & Structure

```
root
├── android/                     # Native Android implementation, tests, and build scripts
├── docs/                        # Markdown guides (e.g., TLS proxy setup)
├── docker/                      # Docker Compose stack for the TLS proxy test harness
├── example-app/                 # Vite playground demonstrating plugin usage
├── ios/                         # Native iOS implementation and XCTest suite
├── scripts/                     # Node-based helper utilities (socket test scripts, git helpers)
├── src/                         # TypeScript bridge for Capacitor (definitions + web adapter)
├── dist/                        # Generated build artifacts (gitignored, rebuilt via npm scripts)
└── STYLE_GUIDE.md               # This document
```

### 3.1 Module Layout Patterns
- `src/definitions.ts` exposes the public TypeScript surface area. Keep it declarative and free of
  side effects.
- `src/index.ts` registers the plugin with Capacitor and re-exports definitions.
- `src/web.ts` hosts the web implementation that mirrors native platform capabilities.
- Native layers (`android/src/main/...`, `ios/Sources/...`) provide platform-specific logic that the
  TypeScript bridge calls into.

### 3.2 Adding New Modules or Utilities
- Keep new modules cohesive: one file per responsibility.
- Place shared TypeScript utilities under `src/` in a flat structure; introduce subfolders only when
  naming collisions arise.
- Node helper scripts belong in `scripts/` and must be executable via `npm run` entries.
- Document new tooling in `docs/` and reference it from the main `README.md`.

## 4. Tooling & Configurations

- **TypeScript (`tsconfig.json`):** strict mode enabled, declaration output, ES2017 target, and
  `noUnusedLocals/Parameters` enforced.
- **Rollup (`rollup.config.mjs`):** bundles TypeScript output into CommonJS and ESM artifacts.
- **ESLint (`@ionic/eslint-config`):** enforces linting rules for TypeScript.
- **Prettier (`@ionic/prettier-config`):** formats code automatically; run via `npm run prettier` or
  `npm run fmt`.
- **SwiftLint (`@ionic/swiftlint-config`):** enforces Swift style conventions.
- **Docgen (`npm run docgen`):** regenerates documentation for the plugin API before each build.
- **Scripts in `package.json`:**
  - `npm run build` – clean, docgen, TypeScript compile, Rollup bundle.
  - `npm run verify` – runs iOS, Android, and web verification targets.
  - `npm run fmt` – ESLint, Prettier write, SwiftLint formatting.
  - `npm run proxy:*` – manages the Docker-based TLS proxy stack used for integration testing.

## 5. Preferred Patterns & Practices

- **Async Style:** Prefer `async`/`await` with `try/catch`. Avoid `.then()` chains unless interacting
  with libraries that expect them.
- **Error Handling:** Validate inputs early and throw descriptive `Error`/`Exception` instances
  (`throw new Error('Event name is required')`). Propagate errors to the Capacitor layer using
  `PluginCall.reject` or platform equivalents.
- **Logging:** Android code uses `Logger` for warnings and debug information; iOS may use
  `print`/`os_log` sparingly. Node scripts use `console.log` with clear prefixes (e.g.
  `[test-socket]`). Avoid noisy logging in production paths.
during release builds—never attempt to bypass them. For production, prefer CA-issued certificates or
- **TLS behaviour:** `allowSelfSigned` is **debug-only**. Runtime guards prevent it from being
  enabled in release builds—never attempt to bypass them. For production, prefer CA-issued
  certificates or platform-level certificate/public-key pinning.
- **Testing:** Android tests rely on JUnit 4, iOS tests on XCTest. When adding tests, use descriptive
  method names (`testConnectsAndReceivesPong`). Keep tests deterministic and gate network-dependent
  tests behind environment variables as shown in `CapacitorSocketIOTest`.
- **Code Organization:**
  - Keep functions focused and under ~40 lines when possible.
  - Extract helper methods (e.g., `buildOptions`, `dispatchEvent`) to encapsulate behaviour.
  - Maintain strong typing—never use `any` unless absolutely unavoidable; prefer specific interfaces
    or union types.
  - For native code, centralize socket lifecycle management in dedicated helpers and keep Capacitor
    plugin classes thin.

## 6. Documentation Rules (Docgen / JSDoc)

- **All public or exported symbols must include JSDoc/TSDoc comments.** This ensures `npm run docgen`
  produces accurate API reference material.
- Required tags:
  - `@param` for each parameter (including destructured options objects).
  - `@returns` summarizing the resolved value.
  - `@throws` for any intentionally thrown errors.
  - `@example` when usage is not obvious.
- Use Markdown features inside comments (`
` for lists, backticks for code).
- Keep the first sentence short—it becomes the summary in generated docs.

**Example (TypeScript):**

```ts
/**
 * Connect to a Socket.IO endpoint and begin streaming events.
 *
 * @param options - Optional connection configuration including URL and socket options.
 * @returns A status object describing the connection state.
 * @throws {Error} If the event name is missing or malformed.
 * @example
 * ```ts
 * await CapacitorSocketIO.connect({
 *   url: 'https://socket-proxy.local',
 *   options: { transports: ['websocket'] }
 * });
 * ```
 */
export async function connect(options?: ConnectOptions): Promise<ConnectResult> {
  // ...implementation...
}
```

For Swift/Java code:
- Use triple-slash documentation (`///`) in Swift and Javadoc (`/** ... */`) in Java for public APIs.
- Mirror the same tag usage where possible (`@param`, `@return`, `@throws`).

## 7. Examples

### 7.1 Formatted TypeScript Module

```ts
import { WebPlugin } from '@capacitor/core';
import type { ConnectOptions, ConnectResult } from './definitions';

const CORE_EVENTS = ['connect', 'disconnect'] as const;

/**
 * Manage the web Socket.IO connection lifecycle.
 *
 * @param options - Connection configuration supplied by callers.
 * @returns Connection status information.
 */
export class ExampleSocketManager extends WebPlugin {
  private socketId?: string;

  async connect(options?: ConnectOptions): Promise<ConnectResult> {
    const url = options?.url ?? 'https://socket-proxy.local/';
    // ...existing code...
    return { status: 'connecting', url };
  }
}
```

### 7.2 Java Listener Helper

```java
/**
 * Helper that attaches a Socket.IO listener exactly once.
 *
 * @param eventName Name of the event to subscribe to.
 */
private void attachListener(String eventName) {
    Socket socket = socketManager.getSocket();
    if (socket == null || attachedEvents.contains(eventName)) {
        return;
    }

    socket.on(eventName, args -> dispatch(eventName, args));
    attachedEvents.add(eventName);
}
```

### 7.3 Swift Lifecycle Snippet

```swift
/// Reset the socket connection and clear any registered listeners.
func destroy() {
    queue.sync {
        requestedEvents.removeAll()
        disconnectInternal()
        eventListener = nil
    }
}
```

## 8. Rules for AI Assistants

- AI-generated code **must adhere to every rule** in this guide—formatting, naming, architecture,
  and documentation requirements.
- Always add or update JSDoc/TSDoc (or platform-specific doc comments) for any public symbol you
  touch. Failure to do so breaks docgen.
- Use the established module structure: definitions in `src/definitions.ts`, entry points in
  `src/index.ts`, platform-specific logic in `src/web.ts` or native directories.
- Do not introduce new dependencies without explicit approval in `package.json`. Prefer existing
  tooling.
- Run applicable npm scripts (`npm run build`, `npm run fmt`, `npm run verify`) before declaring work
  complete, and report their status in summaries.
- Keep changes minimal and focused; avoid sweeping refactors unless the task demands it.

---

Adhering to this guide keeps the Capacitor Socket.IO plugin consistent, maintainable, and
well-documented. When proposing deviations, document the rationale in a pull request and update this
guide accordingly.
