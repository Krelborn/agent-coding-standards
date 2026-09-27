# Vitest Unit Testing

Standards for Vitest unit tests using `@testing-library/react` and `@testing-library/user-event`. (The base TypeScript standards — and, for `.test.tsx`, the React standards — are applied by the `typescript` and `react` rules, which also match this file.)

## Core Principle

> The more your tests resemble the way your software is used, the more confidence they can give you.

Test user behavior, not implementation details. If a user can't observe it, don't test it. A good litmus test: if refactoring the component without changing its behavior breaks your test, the test was testing implementation details.

## Scenario Identification

| Scenario             | Signals                              | setUpTest variation | Key tools                                 |
| -------------------- | ------------------------------------ | ------------------- | ----------------------------------------- |
| **React component**  | `.tsx` file, JSX, renders UI         | Deferred render     | `renderBase()`, `userEvent`, role queries |
| **Utility function** | Pure function, no React imports      | None                | Direct calls, no rendering                |
| **Async/data layer** | API calls, fetch/axios, cancellation | Pre-loaded state    | Mocked module boundaries, `waitFor`       |

## Query Priority

Use queries in this order (most preferred first):

1. `getByRole` — accessible roles (button, textbox, heading, dialog, etc.)
2. `getByLabelText` — form fields
3. `getByPlaceholderText` — when label unavailable
4. `getByText` — non-interactive elements
5. `getByDisplayValue` — filled form elements
6. `getByAltText` — images
7. `getByTitle` — rarely needed
8. `getByTestId` — only when no other query applies; indicates test-only attribute in code, which is a smell but sometimes necessary for hard-to-query elements
9. **Never**: class selectors, DOM structure queries

Always use `screen` for queries — don't destructure from `render()`:

```typescript
// Good
render(<MyComponent />);
screen.getByRole("button", { name: "Save" });

// Bad — destructuring from render couples tests to render's return API
const { getByRole } = render(<MyComponent />);
```

Use `name` option with `getByRole` for specificity:

```typescript
screen.getByRole("button", { name: "Save" });
screen.getByRole("textbox", { name: "Email" });
screen.getByRole("dialog", { name: "Confirm Delete" });
```

## Interaction

Always prefer `@testing-library/user-event` over `fireEvent`. Use `userEvent.setup()` to create a user instance — this enables proper event sequencing:

```typescript
import userEvent from "@testing-library/user-event";

// Good — setup creates a user instance with proper event interleaving
const user = userEvent.setup();
await user.click(button);
await user.type(input, "text");
await user.clear(input);
await user.selectOptions(select, "option");
await user.keyboard("{Enter}");

// Bad — fireEvent doesn't simulate real user behavior
fireEvent.click(button);
fireEvent.change(input, { target: { value: "text" } });
```

Only use `fireEvent` where `userEvent` doesn't support the interaction you need (e.g., `fireEvent.focus(input)` to trigger focus styles without user interaction). For all user interactions, prefer `userEvent` for more realistic simulation.

## Async Patterns

Prefer `findBy*` queries for elements that appear asynchronously — they combine `getBy` + `waitFor` in one call. Only use `waitFor` when you need to assert on something more complex than element presence, and only wrap assertions that genuinely need to wait — don't wrap single synchronous assertions in `waitFor`. Let Testing Library handle `act()` through proper queries rather than wrapping everything in `act()` manually.

```typescript
// Best — findBy for async element appearance
expect(await screen.findByText("Loaded")).toBeInTheDocument();

// Good — waitFor for complex async assertions
await waitFor(() => {
  expect(screen.getByRole("list")).toHaveTextContent("item 1");
});

// Good — wait for element to disappear
await waitFor(() => {
  expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
});

// Bad — wrapping a synchronous assertion in waitFor
await waitFor(() => {
  expect(screen.getByText("Already Here")).toBeInTheDocument();
});

// Bad — manual act() when a proper query would handle it
act(() => {
  fireEvent.click(button);
});

// Controlled async with manual promises
const { promise, resolver } = createManualPromise<string>();
mockFn.mockReturnValueOnce(promise);
// ... trigger action ...
await act(async () => {
  resolver("result");
  await promise;
});
```

## Test Structure & Naming

Flat structure, no nesting beyond one `describe`:

Separate each test case with a single blank line — just as `describe` blocks are separated from each other. A blank line _within_ a test delimits its Arrange/Act/Assert sections; a blank line _between_ tests delimits the cases. Never pack consecutive `test`/`it`/`test.each` cases together with no blank line between them.

```typescript
// Good — flat, one blank line between cases
describe("LoginForm", () => {
  test("must show error when email is empty", async () => { ... });

  test("must submit when form is valid", async () => { ... });

  test("must disable button while submitting", async () => { ... });
});

// Bad — cases packed with no blank line between them
describe("LoginForm", () => {
  test("must show error when email is empty", async () => { ... });
  test("must submit when form is valid", async () => { ... });
  test("must disable button while submitting", async () => { ... });
});

// Bad — nested describes
describe("LoginForm", () => {
  describe("validation", () => {
    describe("email", () => {
      test("shows error", () => { ... });
    });
  });
});
```

Use `test.each` for similar scenarios with different inputs instead of loops or nested describes:

```typescript
test.each([
  { input: "", expected: "Required" },
  { input: "bad", expected: "Invalid email" },
  { input: "a@b", expected: "Invalid email" },
])("must show '$expected' when email is '$input'", async ({ input, expected }) => {
  const { render } = setUpTest();
  await render(<LoginForm />);
  await user.type(screen.getByRole("textbox", { name: "Email" }), input);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  expect(screen.getByRole("alert")).toHaveTextContent(expected);
});
```

Use `must [behavior] when [condition]` pattern:

```typescript
test("must show error message when email is invalid", ...);

test("must disable submit button while request is pending", ...);

test("must call onSave with updated values when form is submitted", ...);

test("must render empty state when no items exist", ...);
```

## Arrange-Act-Assert Pattern

- Organize individual tests with AAA pattern using vertical whitespace to separate sections
- Also separate each test case from the next with a single blank line — the blank line _between_ tests is as important as the blank lines _within_ a test. Do not pack cases together (see Test Structure & Naming)
- NO section comments needed - the whitespace structure is self-evident
- Pattern:
  - Setup (arrange)
  - Execute action (act)
  - Verify result (assert)
- Improves test readability and maintainability

Example shows AAA structure with a single blank line between test cases, and no section comments:

```typescript
test("must show error message when email is invalid", async () => {
  const { render } = setUpTest();
  await render(<LoginForm />);

  await user.type(screen.getByRole("textbox", { name: "Email" }), "invalid-email");
  await user.click(screen.getByRole("button", { name: "Submit" }));

  expect(screen.getByRole("alert")).toHaveTextContent("Invalid email");
});
```

## setUpTest Pattern

A test setup helper that prepares mocks, stores, and a render function. **It does NOT call render itself.** Tests control rendering explicitly.

### setUpTest Decision Guide

**Simple/Presentational components** - Call render(<Component ... />) directly in each
test so the props under test are visible at the call site. Reserve setUpTest for tests
that need real setup work — fixture construction, context providers, or complex mock  
wiring. Wrapping render in setUpTest just to pass props through adds indirection
without value.

```typescript
// Bad: Don't do this
function setUpTest({ prop1, prop2 } = {}) {
  const render = () => renderBase(<MyComponent prop1={prop1} prop2={prop2} />);
  return render;
}
```

Note: `renderBase` is Testing Library's `render`, renamed to avoid collision with the local `render` function.

**Deferred render** (most common for components) — Returns async `render()`. Tests call it when ready.

```typescript
function setUpTest({ theme = "light" } = {}) {
  const onSave = vi.fn();

  const render = async (ui: ReactNode) => {
    renderBase(
      <ThemeContext.Provider value={{ theme }}>
        {ui}
      </ThemeContext.Provider>
    );

    await screen.findByRole("region", { name: "Editor" });
  };

  return { onSave, render };
}

test("must render editor", async () => {
  const { render } = setUpTest();

  await render(<MyComponent />);

  expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();
});
```

**Hierarchical** (`setUpTestWith[Feature]`) — Complex domains with shared base setup and feature-specific extensions.

```typescript
function setUpTest() { ... }

function setUpTestWithUser() { return { ...setUpTest(), user }; }

function setUpTestWithDocument() { return { ...setUpTestWithUser(), document }; }
```

Tests pick the level of setup they need.

**Pre-loaded state** — Pair sync `setUpTest` + async `setUpLoadedTest` when tests need data already loaded.

### Key Conventions

- **Naming**: `setUpTest`, `setUpTestWith[Feature]`, `setUpLoadedTest`
- **Parameters**: single options object with defaults: `{ item = null, isReadOnly = false } = {}`
- **Return**: always a named object — `return { render, onSave }`
- **Render control**: tests call `render()` — setup never renders
- **Async pairing**: for pre-loaded state, pair sync `setUpTest` with async `setUpLoadedTest` that awaits loading before returning
- **Async waits**: return `waitFor*` helpers built on Testing Library's `waitFor()` or `findBy*` queries
- **Mock reset**: `vi.resetAllMocks()` at start when needed

## File Structure Template

```typescript
// Imports

// Mocks (vi.mock calls — hoisted, declare before imports)

// Types/interfaces if needed

// Tests
describe("ComponentName", () => {
  test("must [expected behavior] when [condition]", async () => {
    // Arrange
    // Act
    // Assert
  });
});

// Setup helper — deferred render variation (most common for components)
function setUpTest({/* option = default */} = {}) {
  // Create mocks, test data, and any context values
  const onSave = vi.fn();

  const render = async (ui: ReactNode) => {
    renderBase(/* <SomeContext.Provider value={...}>{ui}</SomeContext.Provider> */);
    await screen.findByRole("region", { name: "..." });
  };

  return { onSave, render };
}

// Element selectors (for component tests)
const elements = {
  get submitButton() {
    return screen.getByRole("button", { name: "Submit" });
  },
};
```

## What to Test

**Do test:**

- User-visible output (text, elements appearing/disappearing)
- User interactions (click, type, select)
- Accessibility (elements findable by role)
- Error states users can see
- Loading/disabled states
- Callback invocations with correct args

**Don't test:**

- Internal state values directly
- Implementation methods
- CSS classes or styling
- Component lifecycle
- Things the framework guarantees

## Anti-Patterns

1. **No snapshot tests** — brittle, low signal, hard to review
2. **No implementation testing** — don't check internal state, `wrapper.instance()`, or private fields
3. **No manual DOM traversal** — never use `container.querySelector(".my-class")`
4. **No excessive mocking** — mock at boundaries (APIs, modules, network), not internals
5. **No copy-paste tests** — extract `setUpTest()` helpers instead
6. **No testing library code** — don't test framework internals or React rendering itself
7. **No asserting on mock call counts** — prefer asserting on visible outcomes
8. **No regex for known strings** — use exact string matches when the value is hardcoded in the component; regex like `/success/i` would still pass if casing changed unexpectedly
9. **No manual cleanup** — React Testing Library handles cleanup automatically between tests
10. **No unnecessary `act()` wrappers** — let Testing Library handle `act()` through proper queries; manual `act()` is only needed for direct state updates outside RTL's control

## Checklist

- [ ] Query by role, label, placeholder, text, test-id — never by class/id
- [ ] Test user-visible behavior, not implementation details
- [ ] Use `screen` for all queries — never destructure from `render()`
- [ ] Use `userEvent.setup()` and call methods on the returned user instance
- [ ] Use `findBy*` for async element appearance, `waitFor` only for complex assertions
- [ ] One assertion concept per test (multiple `expect` OK if testing one behavior)
- [ ] Flat test structure — one `describe` per suite max, no nesting
- [ ] Single blank line between consecutive test cases — never pack them together
- [ ] Name tests `must [behavior] when [condition]`
- [ ] Use `setUpTest()` pattern for shared setup
- [ ] Use element selector objects for repeated queries
- [ ] Use exact string matches, not regex, for known hardcoded values
- [ ] Use `test.each` for similar scenarios with different inputs
- [ ] Follow existing project conventions from nearby test files
