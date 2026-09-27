# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project

A Claude Code plugin marketplace, `krelborn-standards`, holding one plugin, `coding-standards`. The plugin ships Matt Styles' coding standards and a hook that puts the standards matching a file into an agent's context when it reads, writes or edits that file. It is published from `Krelborn/agent-coding-standards` on GitHub.

- `.claude-plugin/marketplace.json`: the marketplace, listing `./plugins/coding-standards`
- `plugins/coding-standards/.claude-plugin/plugin.json`: the plugin manifest
- `plugins/coding-standards/hooks/hooks.json`: the hook registrations, which Claude Code discovers from this path
- `plugins/coding-standards/hooks/standards.mjs`: the hook, plain Node with no dependencies
- `plugins/coding-standards/hooks/standards.test.mjs`: its `node:test` tests
- `plugins/coding-standards/standards.json`: the shipped configuration (`slotCount`, `excludedDirectories`, `rules`)
- `plugins/coding-standards/standards/*.md`: the shipped standards documents

## Commands

- `npm test`: runs `node --test`, which finds `**/*.test.mjs`. CI (`.github/workflows/ci.yml`) runs it on Node 22 and 24.
- `claude plugin validate .` and `claude plugin validate plugins/coding-standards`: validate the marketplace and the plugin.
- Try a local change in a scratch project: `claude --plugin-dir <this repo>/plugins/coding-standards`, or `/plugin marketplace add <this repo>` then `/plugin install coding-standards@krelborn-standards`.

## Rules

- Bump `version` in `plugin.json` (semver) on every change to the plugin, including a standards document. Installed copies update only when the version changes.
- Keep `slotCount` in `standards.json` equal to the number of handlers per event in `hooks/hooks.json`. The "is registered with one handler per slot" test checks this.
- Hook commands in `hooks.json` use `"${CLAUDE_PLUGIN_ROOT}"`. The hook needs no dependencies beyond `node`.
- A shipped standard is added by putting its document in `standards/`, adding a rule with `document` set to its file name in `standards.json`, and bumping the version. Its ID is `coding-standards:<file name>`, and projects use that ID to disable it, so renaming a document breaks their `disabled` lists.
- The shipped standards apply to this repo's own code, `comments.md` in particular for `standards.mjs`.

## Standards hook

`hooks/hooks.json` runs `standards.mjs`, so matching standards are in an agent's context whenever it reads, writes or edits a file:

- **Two roots**: shipped documents and `standards.json` load from `CLAUDE_PLUGIN_ROOT`. Project files, the project's `.claude/standards.json` and project documents resolve against `CLAUDE_PROJECT_DIR`.
- **Stable IDs**: a shipped document is named `coding-standards:<file name>`, and a project document is named by its project-relative path. State, plan keys and message headers use these IDs and never the plugin's path, which changes with every installed version. So a plugin update mid-session does not inject the documents again. The note naming documents that did not fit gives their absolute paths, so the agent can Read them.
- **Merged configuration**: the plugin's `standards.json` is applied first, then the project's `.claude/standards.json` if it exists:
  - its `rules` are added after the shipped ones, with `document` relative to the project; a rule whose document is not a file is skipped and reported on stderr;
  - `disabled` lists shipped IDs to turn off;
  - `excludedDirectories` are added to the shipped list.

  `slotCount` comes from the plugin alone; a project value is ignored and reported on stderr. A malformed project config is reported on stderr, and the shipped defaults apply.
- **Double registration**: when the project's `.claude/settings.json` or `.claude/settings.local.json` registers a hook command containing `standards.mjs`, the plugin emits nothing and slot 0 logs to stderr. So a project mid-migration gets each standard once.
- **PreToolUse (`Read|Write|Edit`)**:
  - Adds any matching document not yet in that agent's context, in full.
  - A Write or Edit made before its standards were in context is denied, with the standards attached, so the change is redone following them.
  - A Write or Edit issued in the same assistant message as the tool call whose hook loaded its standards is also denied, without the standards attached, since that other call delivers them.
  - Messages are matched by `message.id` in the transcript. A Write that is not in the transcript yet belongs to the newest assistant message there. When that message is the loader's, or the loader is missing, the Write is denied only if the standards were loaded under 3 seconds ago.
- **PostToolUse (`Bash`)**: after `git diff`, `git show`, `git log` or `gh pr diff`, adds the standards for existing project files named in the output, so diff-based reviews get them too. It reads raw output, `--stat` output (including renames and `...`-shortened paths) and rtk-compacted output. Output cut short by a pipe such as `| head` may name no files.
- **Per-context tracking**: state lives in `$TMPDIR/claude-standards/<session_id>/<agent_id or main>.json`, so each subagent is tracked separately. A `compact_boundary` entry in the agent's transcript clears its state, so documents are sent again on its next matching tool call. The exception is the boundary of a compaction the `SessionStart` hook has already restored: Claude Code writes that boundary after running the hook, so the state records it as pending and it clears nothing when it arrives, provided its timestamp is within a minute of the restore.
- **SessionStart and SubagentStart**:
  - `SessionStart` with `compact` re-sends the loaded documents to the main agent straight after compaction, as far as the slots allow.
  - `SessionStart` with `clear` resets the main agent's state.
  - `SubagentStart` with `fork` gives the fork the main agent's loaded documents.
- **Size limit**: Claude Code moves any single `additionalContext` string over 10,000 characters to a file, and leaves only a 2,000-character preview in context. So each event has `slotCount` handlers (`standards.mjs <mode> <slot>`), and each handler emits one chunk.
  - Parallel slots share one plan per event through a lock in the state directory.
  - When the documents need more than `slotCount` chunks, whole documents are sent in order with a note naming the rest. Only the documents sent count as in context, so the rest follow on the next matching call, and a Write stays denied until they have arrived.
  - A single document longer than every slot is sent cut short and counts as in context.
