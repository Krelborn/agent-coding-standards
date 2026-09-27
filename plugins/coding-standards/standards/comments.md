# Writing comments

These standards take precedence over any other guidance on code comments, including a general
rule that complex logic should carry explanatory comments.

**The default is no comment.** Most code needs none. Every comment is a cost paid
by every future reader — one more thing to read, to keep true, and to distrust
once it has drifted. A file with few comments is the normal outcome of this
document, not a failure to explain.

So the bar is not whether a fact is true and worth knowing; it will always feel so
to whoever has just worked it out. The bar is whether **a competent stranger would
be blocked without it**. That reader is fluent in the language and its libraries —
they know what `afterEach`, `restoreAllMocks`, or a `map` does, so a comment naming
the call adds nothing and ages badly.

A short list clears that bar: why a non-obvious choice was made, why an apparently
redundant line is load-bearing, a constraint imposed from outside the file, a
subtlety that would otherwise look like a mistake. Matching one of these is
necessary, not sufficient — they are the exceptions, not an invitation.

**A function's doc comment is its contract with callers**: what it does, its
parameters, what it returns. Not how it does it — that is the body's job, and
prose describing the implementation goes stale the moment the implementation
changes. If a caller does not need to know it, leave it out.

```ts
// ❌ Restates the code, and documents internals a caller cannot use
/**
 * Formats the time left, switching from minutes to seconds for the final
 * minute, then pluralizes by comparing the count to 1.
 */
function formatTimeLeft(msLeft: number): string { ... }

// ✅ States the contract.
/**
 * Formats the time remaining before sign-out for display
 *
 * @param msLeft the time remaining in milliseconds
 * @returns the time remaining, e.g. "30 seconds" or "5 minutes"
 */
function formatTimeLeft(msLeft: number): string { ... }
```

**The test**: cover the body with your hand. Can a caller still act on what the doc comment
says? If a sentence only makes sense with the body in view, it belongs in the body.

The trap is the plausible middle paragraph — the one explaining what the mechanism does not
handle. Split it. The _effect on the caller_ is contract; the mechanism producing that effect
is not.

```ts
// ❌ Explains the mechanism and its limits
/**
 * Splits a command line into its separate commands
 *
 * Only the operators that separate one command from the next, with no attempt to understand
 * quoting, so a quoted string that looks like a command produces a false match.
 */

// ✅ States what the caller has to handle
/**
 * Splits a command line into its separate commands
 *
 * @param command the raw command line
 * @returns the separate commands; may over-report when the line quotes something that reads
 *   like one
 */
```

A paragraph opening "Uses", "Reads", "Only", "Iterates" or "Matched" is describing the body.
Move it down — it is usually worth keeping, just in the wrong place.

## One fact, one place

Prefer deleting a comment over updating it when the code below it already says
the same thing. Two things claiming the same fact is one of them waiting to lie,
and that holds however the two are spelled:

- The code says it → delete the comment.
- A doc page says it → link to the page; do not restate its argument.
- Another comment says it → the second one is a deletion, not a repetition.

## State it, do not argue it

Comments record a decision. They do not defend it. Cut the scaffolding a defence
brings with it — "deliberately, and the reasoning matters", "two things make this
safe", "one might think" — along with pre-emptive answers to objections nobody has
raised.

A decision needing more than a few lines to justify is a decision needing a doc
page. Leave the rule and its consequence in the code, and link to the rest.

**A comment longer than the code it explains is a doc page trying to escape.**

## Never date the code

A comment states what is true of the code, not what was true when it was written.
Anything that could quietly stop being true belongs in the commit, where it stays
accurate because nobody edits it.

No ticket key or tracker URL, of any project, in a comment, a doc comment, a TODO or
an assertion message. The line has to state its reason regardless, so the reference
adds nothing; provenance lives in the commit and the PR. Remove any you come across.

```java
// ❌ A calculated value's digits are only how it was formatted (ISSUE-99)
// ✅ A calculated value's digits are only how it was formatted
```

Every other way of dating a line goes the same way, and these are the ones that
actually rot:

```ts
// ❌ That has bitten twice: it made an unchanged edit look changed
// ❌ This used to round on one branch while rounding first on the other
// ❌ Not reachable today, since every scale factor is exact
// ❌ Currently the only caller
```

The first two describe a defect that no longer exists, so they describe code the
reader cannot see. The last two are claims about the rest of the codebase that the
next commit falsifies silently — and if the constraint is load-bearing, enforce it
in code, where it cannot go stale. Moving a file to another repository turns every
one of these into a lie at a stroke.

## Formatting

- Comments go on their own line — never inline at the end of a code line.
- JSDoc always spans multiple lines. The opening `/**`, each line of text, and the
  closing `*/` each go on their own line, even for a one-word comment. On interface
  and type fields, leave a blank line after each documented field except the last.

```ts
// ❌
/** The destination cell */
position: CellPosition;

// ✅
/**
 * The destination cell
 */
position: CellPosition;
```
