# coding-standards

A Claude Code plugin that puts coding standards into an agent's context when it reads, writes or edits a matching file, and keeps them there across compaction. It ships Matt Styles' standards for comments, TypeScript, React and Vitest unit tests, and each project can add its own standards or turn off shipped ones.

The plugin is published through the `krelborn-standards` marketplace in this repository.

## Requirements

`node` (version 22 or later) must be on the `PATH` that Claude Code runs hooks with. The hook has no other dependencies.

## Install

In Claude Code:

```
/plugin marketplace add Krelborn/agent-coding-standards
/plugin install coding-standards@krelborn-standards
```

### For a whole team

Commit this to the project's `.claude/settings.json`. Anyone who trusts the project is then prompted to add the marketplace and install the plugin:

```json
{
  "extraKnownMarketplaces": {
    "krelborn-standards": {
      "source": {
        "source": "github",
        "repo": "Krelborn/agent-coding-standards"
      }
    }
  },
  "enabledPlugins": {
    "coding-standards@krelborn-standards": true
  }
}
```

## Shipped standards

| ID | Applies to |
| --- | --- |
| `coding-standards:comments.md` | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.css` |
| `coding-standards:typescript.md` | `.ts` `.tsx` |
| `coding-standards:react.md` | `.tsx` `.jsx` `.module.css` |
| `coding-standards:vitest-unit-testing.md` | `.test.ts` `.test.tsx` |

Files under a `node_modules` or `dist` directory, and files outside the project, get no standards.

## Project configuration

A project can add to the shipped configuration with an optional `.claude/standards.json`:

```json
{
  "rules": [
    {
      "document": "docs/standards/storybook.md",
      "suffixes": [".stories.tsx"]
    }
  ],
  "disabled": ["coding-standards:react.md"],
  "excludedDirectories": ["storybook-static"]
}
```

- `rules` are added after the shipped rules. `document` is relative to the project root, and the document is named by that path in the agent's context. A file gets every rule whose suffix its path ends with.
- `disabled` lists the IDs of shipped standards to turn off.
- `excludedDirectories` are added to the shipped list. A file with any path segment equal to one of them gets no standards.

Every key is optional. `slotCount` belongs to the plugin, because it has to equal the number of hook handlers, so a project value is ignored. If the file is not valid JSON or has the wrong shape, the hook logs the problem to stderr, which shows in Claude Code's debug output, and applies only the shipped standards.

## How it works

- **Read, Write or Edit.** The first time an agent touches a file of a given type, the matching standards are added to its context in full. A Write or Edit made before those standards were in context is denied, with the standards attached, and the agent redoes it following them. A Write or Edit issued in the same step as the call that loaded its standards is denied for the same reason.
- **Diffs.** After `git diff`, `git show`, `git log` or `gh pr diff`, the standards for the project files named in the output are added, so reviews get them too.
- **Per agent.** Each subagent is tracked separately. A forked subagent starts with the main agent's standards.
- **Compaction.** After the main agent's context is compacted, the standards it had are sent again straight away. A subagent gets its standards again on its next matching tool call. `/clear` resets tracking.
- **Size.** Claude Code truncates any single piece of hook context over 10,000 characters, so the standards are split across six parallel hook handlers. When they do not all fit, whole documents are sent in order, followed by a note giving the paths of the rest. The rest are sent on the agent's next matching tool call.

State is kept in `$TMPDIR/claude-standards/<session_id>/`. [AGENTS.md](AGENTS.md#standards-hook) describes the behaviour in detail.

## Migrating from an in-repo copy of the hook

If a project has its own `.claude/hooks/standards.mjs` registered in `.claude/settings.json`, the plugin stays silent there, so standards are not injected twice. It logs the reason to stderr. To switch to the plugin:

1. Remove the `standards.mjs` hook entries from `.claude/settings.json` (and `settings.local.json`), and delete `.claude/hooks/standards.mjs` and its test.
2. Delete the project's copies of the shipped documents.
3. Rewrite `.claude/standards.json` to hold only what differs from the shipped configuration: extra `rules`, `disabled` IDs and extra `excludedDirectories`. Drop `slotCount`.

## Adding a shipped standard

1. Add the document to `plugins/coding-standards/standards/`.
2. Add a rule to `plugins/coding-standards/standards.json`, with `document` set to the file name and the `suffixes` it applies to. Its ID becomes `coding-standards:<file name>`.
3. Bump `version` in `plugins/coding-standards/.claude-plugin/plugin.json`.
4. Run `npm test`.

## Development

```
npm test
claude plugin validate .
```

See [AGENTS.md](AGENTS.md) for the repository layout and conventions.
