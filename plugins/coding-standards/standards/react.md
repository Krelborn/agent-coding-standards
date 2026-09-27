# React

Standards for React and component CSS. (The base TypeScript standards are applied by the `typescript` rule, which also matches this file.)

## React Patterns

- Sort props alphabetically in interfaces/types and JSX
- JSX props: alphabetical, then `aria-*`, then `data-*` (each group sorted)
- Sort hook dependency arrays alphabetically
- Destructure React types on import (not `React.ChangeEvent`)
- Use the module pattern: `ComponentName/` folder with `.tsx`, `.module.{css|scss}`, `.test.tsx`.
- Always explicitly pass boolean values: `disabled={true}` instead of shorthand `disabled`
- Avoid unnecessary re-renders — memoize expensive computations and stable callbacks/props where they measurably affect render cost.

## CSS Class Names

- Projects may use either `classnames` or `clsx` packages for a utility function for conditional class composition (Never both).
- Prefer `clsx` in new projects
- Projects using "classnames" should `import classNames from "classnames'`
- Projects using "clsx" should `import { clsx } from "clsx";`
- Use class composition utility function for conditional class composition — never ternaries
- Static classes as a single string, conditional classes as an object e.g. `classNames("d-flex flex-grow-1", { "d-none": isHidden })`
- Don't use composition utility when mixing classes without conditionals: `d-flex flext-grow-1 ${styles.fromModule}`
