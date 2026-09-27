# TypeScript

Core coding standards for typescript code. These principles MUST be followed when writing or reviewing typescript code.

## Core Principles

1. **Type Safety is Non-Negotiable**: Use TypeScript's type system to its fullest. Prefer strict types over `any` or `unknown` unless `unknown` is genuinely the correct type. Use discriminated unions, generics, mapped types, and conditional types where they add clarity. Every function signature should be an accurate contract.

2. **Performance by Default**: Choose efficient data structures and algorithms. Avoid unnecessary work in hot paths and UI re-renders. Be conscious of bundle size implications. Prefer lazy evaluation and deferred loading where appropriate.

3. **Security-First Mindset**: Sanitize inputs. Validate data at boundaries (especially API responses — use Zod or similar runtime validation). Never trust external data. Avoid XSS vectors. Handle secrets and sensitive data carefully. Use parameterized queries. Escape user content before rendering.

4. **Clarity Over Cleverness**: Write code that a senior developer can understand on first read. Use descriptive variable and function names. Avoid overly terse or "clever" one-liners when a clearer multi-line approach communicates intent better. Code should read like well-written prose.

## Code Style & Standards

### TypeScript Conventions

- Always use curly braces for if/for/while statements, even single-line bodies
- Use camelCase for constants — never SCREAMING_SNAKE_CASE
- Always declare explicit accessibility modifiers (`public`, `private`, `protected`) on class members
- Prefer `interface` over `type` for component props (use `type` only when unions/intersections are needed)
- Member ordering: public fields → private fields → constructor → public methods → protected → private
- Use `readonly` for properties that should not be reassigned after construction
- Prefer `interface` for object shapes that may be extended; use `type` for unions, intersections, and computed types
- Use `const` assertions and `as const` for literal types where appropriate
- Never use `@ts-ignore` — use `@ts-expect-error` with a comment explaining why, only as a last resort
- Prefer `unknown` over `any` when the type is truly not known, and narrow it with type guards
- Always use curly braces for if/for/while statements, even single-line bodies
- Exported functions must have explicit return types (e.g., `: JSX.Element`). Exception: when a function's return type from a generic library (e.g., TanStack Router's `createRouter()`) would require overly complex type expressions, omit the return type and let TypeScript infer it. Prefer inferred types over using `any`, as `any` disables type checking entirely.

### Modules

- Always 1 class per module
- Avoid big types.ts files. Break up interfaces and type definitions into multiple modules while keeping small, tightly coupled types together. Prefer a primary interface/type with supporting types.

```
// Bar is small and only used by Foo so it shares its module
export type Bar = "one" | "two" | "three";

export interface Foo {
  foo: Bar;
  // Other stuff below...
}
```

- Comments like `// --- Column configuration ---` are a smell. If code is partitioned with markers consider whether to break up the module.
- Barrel imports: External consumers must import from the module barrel (`../ReactComponent`), not from internal files (`../ReactComponent/InternalType`). Internal files within a module may import siblings directly.

### Naming Things

- Use full words in all identifiers. Never abbreviate, truncate, or shorten words — even when the short form is conventional or unambiguous.

  This applies to variables, parameters, functions, types, interfaces, properties, and file names. It applies to both prefixes and suffixes.

  Examples of disallowed shortenings:
  - `col` → use `column` (or `color` — pick the actual word)
  - `idx` → use `index`
  - `def` → use `definition` (e.g. `ColumnDefinition`, not `ColumnDef`)
  - `ctx` → use `context`
  - `cfg` → use `configuration`
  - `btn` → use `button`
  - `msg` → use `message`
  - `req` / `res` → use `request` / `response`
  - `arr`, `obj`, `str`, `num` → use `array`, `object`, `string`, `number`

  Permitted exceptions:
  - **Established acronyms and initialisms**: `URL`, `HTTP`, `HTTPS`, `API`, `ID`, `UUID`, `DOM`, `JSON`, `XML`, `CSS`, `HTML`, `SQL`, `JWT`, `CLI`.

  - **Loop counters in tight scopes**: `i`, `j`, `k`.

  - **Names you don't own**: identifiers whose exact spelling is determined by something outside your code. Use them as-is — do not alias or rename them to satisfy this rule. This includes:
    - Names imported from third-party libraries (e.g. TanStack Table's `ColumnDef`)
    - File extensions (`.tsx`, `.md`, `.cjs`, `.yml`) and variables holding them
    - Environment variable names following platform conventions (`NODE_ENV`, `CI`)
    - HTTP header names, MIME types, and protocol-level strings
    - Database column names, API field names, and other wire-format identifiers from systems you don't control
    - CLI flag names matching a tool's documented interface

    The test: if renaming the identifier would break interop with an external system, or if the short form _is_ the canonical spelling in a specification or standard, use the short form.

  - **Ecosystem-standard convention names**: a small, closed set of terms that are universally understood in their ecosystem and where the long form would look wrong to other developers. Specifically:
    - `Props` (React component props types) — not `Properties`
    - `Ref` / `ref` (React refs, `forwardRef`) — not `Reference`
    - `params` (route/function parameters in framework conventions like Next.js, React Router) — not `parameters`
    - `args` (when matching a framework's documented API, e.g. Storybook `args`) — not `arguments`
    - `env` (environment variables, `process.env`) — not `environment`

    This list is exhaustive. If a shortening isn't on it, expand it. "It's conventional in my codebase" is not sufficient — the test is whether the short form is the documented, canonical name in widely-used framework or language conventions.

- **Files with a clear primary export** are named character-for-character identically to that export's identifier, including casing. The extension is `.tsx` if the file contains JSX, otherwise `.ts`.
  - `class Foo` → `Foo.ts`
  - `interface UserProfile` → `UserProfile.ts`
  - `function MyButton(): JSX.Element` → `MyButton.tsx`
  - `function useDebounce()` → `useDebounce.ts`
  - `function formatDate()` → `formatDate.ts`
  - `const httpStatus = { ... }` → `httpStatus.ts`

  Because the filename mirrors the identifier exactly, casing is determined by how the export itself is named — PascalCase identifiers produce PascalCase filenames, camelCase produces camelCase, and so on. There is no separate casing rule to remember.

  A "primary export" means one of: the sole export from the module, or the export the module clearly exists to provide (e.g. a component file that also exports its `Props` type — the component is primary, the `Props` type is incidental).

- **Files without a clear primary export** — utility modules, collections of related helpers, mixed-purpose modules — use a descriptive camelCase name that summarises the contents.
  - `dateTimeFormatters.ts`
  - `stringHelpers.ts`
  - `validationRules.ts`

  If you find yourself struggling to pick a descriptive name, that's usually a signal the module is doing too much and should be split.

- **Barrel files** that exist only to re-export from sibling modules are named `index.ts` (or `index.tsx` if any re-exported module's types require JSX in the barrel itself, which is rare).

### Function Design

- Functions should do one thing well. If a function exceeds ~30 lines, consider decomposing it
- Prefer pure functions where possible. Isolate side effects
- Use early returns to reduce nesting
- Handle all error paths — never swallow errors silently
- Don't use `async` without `await` — return the promise directly instead

### Error Handling

- Always handle promises — no floating promises
- Use structured error types (custom error classes or discriminated unions) rather than throwing generic `Error` objects
- Catch at appropriate boundaries, not everywhere
- Provide meaningful error messages that aid debugging

### Import Ordering

- Import ordering: external → `../` internal → `./` local (alphabetical within each group); blank line between each group; type imports before value imports from same module
- Type imports before value imports from the same module

## What You Never Do

- Never use `any` without exhausting all typed alternatives first
- Never leave TODO comments without an explanation of what needs to be done and why it's deferred
- Never ignore error cases or assume happy paths
- Never use `console.log` for error handling in production code
