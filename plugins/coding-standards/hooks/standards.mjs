import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code hook that adds the project's coding standards to an agent's context when it
 * reads, writes or edits a matching file, and restores them after compaction.
 *
 * Usage: node standards.mjs <pre|post|session|subagent> <slot>
 *
 * See the "Coding standards" section of AGENTS.md.
 */

// Below Claude Code's per-string additionalContext cap described in AGENTS.md
const messageCharacterLimit = 9500;
const lockTimeoutMilliseconds = 3000;
const staleFileMilliseconds = 10 * 60 * 1000;
const transcriptTailBytes = 1024 * 1024;
const sameStepWindowMilliseconds = 3000;
// Leaves slots waiting on the session lock time to read the plan
const gitTimeoutMilliseconds = 2000;
const writeTools = new Set(["Write", "Edit"]);
const gitGlobalOption = "(?:-P|-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?)";
const changeShowingCommand = new RegExp(
  `\\bgit\\s+(?:${gitGlobalOption}\\s+)*(?:diff|show|log)\\b|\\bgh\\s+pr\\s+diff\\b`
);

const projectDirectory = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
let configuration;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readStandardInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value));
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sessionDirectory(input) {
  const directory = path.join(os.tmpdir(), "claude-standards", input.session_id);
  fs.mkdirSync(path.join(directory, "plans"), { recursive: true });
  return directory;
}

function agentKey(input) {
  return input.agent_id ?? "main";
}

function statePath(input, key = agentKey(input)) {
  return path.join(sessionDirectory(input), `${key}.json`);
}

/**
 * Reads an agent's state
 *
 * @param input the hook input
 * @param key the agent's state key; defaults to the agent the input comes from
 * @returns the state, with every loaded entry in the { document, toolUseId, loadedAt } form;
 *   a document recorded as a bare path counts as loaded by no tool call, and an entry with no
 *   document is dropped
 */
function readState(input, key) {
  const state = readJson(statePath(input, key)) ?? { loaded: [], transcriptOffset: 0 };
  return { ...state, loaded: state.loaded.flatMap(normaliseLoadedEntry) };
}

function normaliseLoadedEntry(entry) {
  if (typeof entry === "string") {
    return [{ document: entry, toolUseId: null, loadedAt: 0 }];
  }
  return typeof entry?.document === "string" ? [entry] : [];
}

/**
 * Runs a callback while holding the session's lock, so parallel hook processes update state
 * one at a time
 *
 * @param input the hook input
 * @param callback the work to run under the lock
 * @returns the callback's result
 */
function withSessionLock(input, callback) {
  const lockPath = path.join(sessionDirectory(input), "lock");
  const deadline = Date.now() + lockTimeoutMilliseconds;
  while (!tryAcquireLock(lockPath)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${lockPath}`);
    }
    removeLockIfOwnerDead(lockPath);
    sleep(10);
  }
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function tryAcquireLock(lockPath) {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Removes the lock when the process holding it has exited without releasing it
 *
 * @param lockPath the lock file, which holds its owner's process ID
 */
function removeLockIfOwnerDead(lockPath) {
  const owner = readLockOwner(lockPath);
  if (owner === undefined || isProcessAlive(owner)) {
    return;
  }
  // Claiming by rename means only one waiter removes the dead lock. If the claimed file is not
  // the dead owner's, another waiter already replaced it, so it is put back.
  const claimPath = `${lockPath}.${process.pid}.claim`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (readLockOwner(claimPath) !== owner) {
    restoreLock(claimPath, lockPath);
  }
  fs.rmSync(claimPath, { force: true });
}

function readLockOwner(lockPath) {
  try {
    return Number(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function restoreLock(claimPath, lockPath) {
  try {
    fs.linkSync(claimPath, lockPath);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

function transcriptPath(input) {
  if (input.agent_id === undefined) {
    return input.transcript_path;
  }
  const agentFileName = input.agent_id.startsWith("agent-") ? input.agent_id : `agent-${input.agent_id}`;
  return path.join(input.transcript_path.replace(/\.jsonl$/, ""), "subagents", `${agentFileName}.jsonl`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isCompactBoundary(line) {
  if (!line.includes("compact_boundary")) {
    return false;
  }
  const entry = parseJsonLine(line);
  return entry?.type === "system" && entry.subtype === "compact_boundary";
}

function readFrom(filePath, offset) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (error) {
    if (error.code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw error;
  }
  try {
    const length = Math.max(0, fs.fstatSync(descriptor).size - offset);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, offset);
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Counts compactions recorded in a transcript after a byte offset
 *
 * @param filePath the transcript file; a missing file counts as empty
 * @param offset the byte offset to start from
 * @returns the number of compactions found and the offset of the end of the last complete line
 */
function scanTranscript(filePath, offset) {
  const contents = readFrom(filePath, offset);
  const lastNewline = contents.lastIndexOf(10);
  if (lastNewline === -1) {
    return { compactions: 0, offset };
  }
  const lines = contents.subarray(0, lastNewline).toString("utf8").split("\n");
  return {
    compactions: lines.filter(isCompactBoundary).length,
    offset: offset + lastNewline + 1,
  };
}

const compactBoundaryMarker = Buffer.from('"subtype":"compact_boundary"');

/**
 * Counts compactions recorded anywhere in a transcript file
 *
 * @param filePath the transcript file; a missing file counts as having none
 * @returns the number of compactions; may over-report when a transcript entry holds an
 *   unescaped copy of the marker
 */
function countCompactBoundaries(filePath) {
  const contents = readFrom(filePath, 0);
  let count = 0;
  for (
    let index = contents.indexOf(compactBoundaryMarker);
    index !== -1;
    index = contents.indexOf(compactBoundaryMarker, index + compactBoundaryMarker.length)
  ) {
    count += 1;
  }
  return count;
}

function transcriptTail(filePath) {
  const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
  return readFrom(filePath, Math.max(0, size - transcriptTailBytes))
    .toString("utf8")
    .split("\n");
}

function assistantMessage(line) {
  const entry = parseJsonLine(line);
  return entry?.type === "assistant" ? entry.message : undefined;
}

function assistantMessageId(line) {
  const id = line.includes('"assistant"') ? assistantMessage(line)?.id : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * Finds the assistant messages that issued some tool calls
 *
 * @param lines the transcript lines to search
 * @param toolUseIds the tool use IDs to look up
 * @returns a map from each tool use ID found to the ID of the assistant message holding it
 */
function assistantMessageIds(lines, toolUseIds) {
  const found = new Map();
  for (const line of lines.filter((candidate) => toolUseIds.some((toolUseId) => candidate.includes(toolUseId)))) {
    const message = assistantMessage(line);
    for (const item of message?.content ?? []) {
      if (item?.type === "tool_use" && toolUseIds.includes(item.id)) {
        found.set(item.id, message.id);
      }
    }
  }
  return found;
}

function lastAssistantMessageId(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const id = assistantMessageId(lines[index]);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

function loadedRecently(entry) {
  return Date.now() - entry.loadedAt < sameStepWindowMilliseconds;
}

/**
 * Tells whether a Write or Edit was composed before some of its standards reached context,
 * because another tool call in the same assistant message loaded them
 *
 * @param input the hook input for the Write or Edit
 * @param documents the standards documents the file requires
 * @returns true when any of the documents was loaded by a tool call in the same step, or was
 *   loaded under 3 seconds ago while it is unknown whether both calls share a step; may
 *   over-report
 */
function composedBeforeStandards(input, documents) {
  const entries = readState(input).loaded.filter(
    (entry) => documents.includes(entry.document) && entry.toolUseId !== null && entry.toolUseId !== input.tool_use_id
  );
  if (entries.length === 0) {
    return false;
  }
  const toolUseIds = [input.tool_use_id, ...entries.map((entry) => entry.toolUseId)];
  const lines = transcriptTail(transcriptPath(input));
  const found = assistantMessageIds(lines, toolUseIds);
  const writeMessageId = found.get(input.tool_use_id);
  // A Write not yet in the transcript belongs to the message being written, which is the last
  // one or a newer one
  const latestPossibleMessageId = writeMessageId ?? lastAssistantMessageId(lines);
  return entries.some((entry) => {
    const loaderMessageId = found.get(entry.toolUseId);
    if (loaderMessageId === undefined) {
      return loadedRecently(entry);
    }
    if (latestPossibleMessageId !== loaderMessageId) {
      return false;
    }
    return writeMessageId !== undefined || loadedRecently(entry);
  });
}

/**
 * Brings an agent's state up to date with its transcript
 *
 * @param state the stored state
 * @param input the hook input
 * @returns the state with a new offset, and with nothing loaded if the agent's context was
 *   compacted since the last scan
 */
function refreshForCompaction(state, input) {
  const scan = scanTranscript(transcriptPath(input), state.transcriptOffset);
  return { loaded: scan.compactions === 0 ? state.loaded : [], transcriptOffset: scan.offset };
}

function applicableRules(filePath) {
  const relativePath = path.relative(projectDirectory, path.resolve(projectDirectory, filePath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return [];
  }
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => configuration.excludedDirectories.includes(segment))) {
    return [];
  }
  return configuration.rules.filter((rule) => rule.suffixes.some((suffix) => relativePath.endsWith(suffix)));
}

/**
 * Splits markdown into pieces no longer than a limit, breaking at level-two headings outside
 * code fences where possible and between lines otherwise
 *
 * @param markdown the document text
 * @param limit the maximum piece length
 * @returns the pieces, which concatenate back to the original text
 */
function splitMarkdown(markdown, limit) {
  const sections = [];
  let current = "";
  let insideFence = false;
  for (const line of markdown.split(/(?<=\n)/)) {
    if (line.startsWith("```")) {
      insideFence = !insideFence;
    }
    if (!insideFence && line.startsWith("## ") && current !== "") {
      sections.push(current);
      current = "";
    }
    current += line;
  }
  sections.push(current);
  return packPieces(
    sections.flatMap((section) => splitByLines(section, limit)),
    limit,
    ""
  );
}

function splitByLines(text, limit) {
  if (text.length <= limit) {
    return [text];
  }
  return packPieces(text.split(/(?<=\n)/), limit, "");
}

function packPieces(pieces, limit, separator) {
  const packed = [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    if (last !== undefined && last.length + separator.length + piece.length <= limit) {
      packed[packed.length - 1] = last + separator + piece;
    } else {
      packed.push(piece);
    }
  }
  return packed;
}

function documentHeader(rule, part, partCount) {
  const partLabel = partCount > 1 ? ` (part ${part} of ${partCount})` : "";
  return `Project coding standard ${rule.document}${partLabel}, which applies to ${rule.suffixes.join(" ")} files. Its full text:\n\n`;
}

/**
 * Builds the context messages that carry a set of standards documents in full
 *
 * @param documents the document paths, relative to the project directory; any no longer
 *   configured or on disk are skipped
 * @returns one message per hook slot, each within the additionalContext limit, and the documents
 *   they deliver in full, apart from one too long for every slot, which is sent cut short
 */
function buildMessages(documents) {
  const headerAllowance = 300;
  const segments = documents.flatMap((document) => {
    const rule = configuration.rules.find((candidate) => candidate.document === document);
    if (rule === undefined) {
      return [];
    }
    const documentPath = path.join(projectDirectory, document);
    if (!fs.existsSync(documentPath)) {
      return [];
    }
    const parts = splitMarkdown(fs.readFileSync(documentPath, "utf8"), messageCharacterLimit - headerAllowance);
    return parts.map((part, index) => ({
      document,
      partCount: parts.length,
      text: documentHeader(rule, index + 1, parts.length) + part,
    }));
  });
  return fitToSlots(segments);
}

function packSegments(segments) {
  const separator = "\n\n";
  const messages = [];
  for (const segment of segments) {
    const last = messages.at(-1);
    if (last !== undefined && last.length + separator.length + segment.text.length <= messageCharacterLimit) {
      messages[messages.length - 1] = last + separator + segment.text;
    } else {
      messages.push(segment.text);
    }
  }
  return messages;
}

function omissionNote(documents) {
  return `These project coding standards did not fit in context automatically, in whole or in part, and are available to read in full: ${documents.join(", ")}`;
}

function wholeDocumentsThatFit(documentCount, packFirst) {
  // Leaving any document out takes one slot for the note naming it
  const slotsFor = (count) => (count === documentCount ? configuration.slotCount : configuration.slotCount - 1);
  let count = documentCount;
  while (count > 0 && packFirst(count).length > slotsFor(count)) {
    count -= 1;
  }
  return count;
}

/**
 * Packs document segments into the hook's slots, sending whole documents in order and leaving
 * the rest for a later call
 *
 * @param segments every part of every document, in document order
 * @returns the messages, and the documents they deliver; when the first document alone needs
 *   more than every slot, it is sent cut short and counts as delivered
 */
function fitToSlots(segments) {
  const documents = [...new Set(segments.map((segment) => segment.document))];
  const packFirst = (count) => packSegments(segments.filter((segment) => documents.indexOf(segment.document) < count));
  const count = wholeDocumentsThatFit(documents.length, packFirst);
  const delivered = documents.slice(0, Math.max(count, 1));
  const omitted = documents.slice(count);
  const messages = packFirst(delivered.length);
  if (omitted.length === 0 || messages.length === configuration.slotCount) {
    return { messages, delivered };
  }
  return { messages: [...messages.slice(0, configuration.slotCount - 1), omissionNote(omitted)], delivered };
}

function removeStalePlans(plansDirectory) {
  for (const fileName of fs.readdirSync(plansDirectory)) {
    const filePath = path.join(plansDirectory, fileName);
    if (Date.now() - fs.statSync(filePath).mtimeMs > staleFileMilliseconds) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

/**
 * Returns the messages every slot process for one hook event shares, creating them on first use
 *
 * @param input the hook input
 * @param key identifies the hook event across its parallel slot processes
 * @param createPlan builds the messages and updates state; runs at most once per key, under the
 *   session lock
 * @returns the messages for the event
 */
function sharedPlan(input, key, createPlan) {
  const plansDirectory = path.join(sessionDirectory(input), "plans");
  const planPath = path.join(plansDirectory, `${key}.json`);
  const existing = readJson(planPath);
  if (existing !== undefined) {
    return existing;
  }
  return withSessionLock(input, () => {
    const created = readJson(planPath);
    if (created !== undefined) {
      return created;
    }
    removeStalePlans(plansDirectory);
    const messages = createPlan();
    writeJsonAtomically(planPath, messages);
    return messages;
  });
}

function emit(hookEventName, fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...fields } }));
}

function requiredDocuments(filePaths) {
  const documents = new Set(filePaths.flatMap(applicableRules).map((rule) => rule.document));
  return configuration.rules.map((rule) => rule.document).filter((document) => documents.has(document));
}

function loadedEntries(documents, toolUseId) {
  const loadedAt = Date.now();
  return documents.map((document) => ({ document, toolUseId, loadedAt }));
}

/**
 * Returns this slot's share of some standards documents that the agent's context does not hold
 * yet, recording the ones delivered as held and loaded by the tool call
 *
 * @param input the hook input
 * @param key identifies the hook event across its parallel slot processes
 * @param slot the slot being run
 * @param findDocuments returns the standards documents the tool call concerns, in configuration
 *   order; runs at most once per key
 * @returns the slot's message, or undefined when it has nothing to add
 */
function messageForDocuments(input, key, slot, findDocuments) {
  const messages = sharedPlan(input, key, () => {
    const documents = findDocuments();
    const state = refreshForCompaction(readState(input), input);
    const missing = documents.filter((document) => !state.loaded.some((entry) => entry.document === document));
    const { messages, delivered } = buildMessages(missing);
    const loaded = [...state.loaded, ...loadedEntries(delivered, input.tool_use_id)];
    writeJsonAtomically(statePath(input), { ...state, loaded });
    return messages;
  });
  return messages[slot];
}

/**
 * Finds project files named in the output of a command that shows changes
 *
 * @param output the command's standard output
 * @returns the paths of existing project files that the output's file headers or stat lines
 *   name
 */
function filesInChangeOutput(output) {
  const candidates = new Set(output.split("\n").flatMap(pathsInChangeLine).flatMap(resolveShortenedPath));
  return [...candidates].filter((candidate) => {
    if (applicableRules(candidate).length === 0) {
      return false;
    }
    return fs.statSync(path.resolve(projectDirectory, candidate), { throwIfNoEntry: false })?.isFile() ?? false;
  });
}

function pathsInChangeLine(line) {
  const gitHeader = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (gitHeader !== null) {
    return [gitHeader[1], gitHeader[2]];
  }
  const fileMarker = /^(?:---|\+\+\+) [ab]\/(\S+)$/.exec(line);
  if (fileMarker !== null) {
    return [fileMarker[1]];
  }
  const statLine = /^\s*(\S.*?)\s+\|\s+(?:\d+|Bin)/.exec(line);
  if (statLine !== null) {
    return renamedPaths(statLine[1]);
  }
  const barePath = /^(\S+)$/.exec(line);
  return barePath === null ? [] : [barePath[1]];
}

/**
 * Expands a path from git's stat output that may record a rename
 *
 * @param statPath the path as printed, e.g. `src/{old => new}/x.ts` or `old.ts => new.ts`
 * @returns the path before and after the rename, or the path itself when it records none
 */
function renamedPaths(statPath) {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(statPath);
  if (braced !== null) {
    const [, prefix, before, after, suffix] = braced;
    return [before, after].map((middle) => `${prefix}${middle}${suffix}`.replace(/\/{2,}/g, "/"));
  }
  return statPath.split(" => ");
}

let projectFiles;

function listProjectFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: projectDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: gitTimeoutMilliseconds,
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolves a path git shortened to fit the terminal, such as `.../Button/Button.tsx` or
 * `...ton.tsx`
 *
 * @param candidate a path from change output
 * @returns the candidate itself when git did not shorten it; otherwise the one project file it
 *   ends, or nothing when it ends none or several
 */
function resolveShortenedPath(candidate) {
  if (!candidate.startsWith("...")) {
    return [candidate];
  }
  projectFiles ??= listProjectFiles();
  const ending = candidate.slice(3);
  const matches = projectFiles.filter((file) => file.endsWith(ending));
  return matches.length === 1 ? matches : [];
}

function handlePostToolUse(input, slot) {
  if (!changeShowingCommand.test(input.tool_input?.command ?? "")) {
    return;
  }
  const message = messageForDocuments(input, `post-${input.tool_use_id}`, slot, () =>
    requiredDocuments(filesInChangeOutput(input.tool_response?.stdout ?? ""))
  );
  if (message !== undefined) {
    emit("PostToolUse", { additionalContext: message });
  }
}

function handlePreToolUse(input, slot) {
  const documents = requiredDocuments([input.tool_input?.file_path ?? ""]);
  const message =
    documents.length === 0 ? undefined : messageForDocuments(input, input.tool_use_id, slot, () => documents);
  const decidesWrite = slot === 0 && writeTools.has(input.tool_name);
  if (message === undefined) {
    if (decidesWrite && documents.length > 0 && composedBeforeStandards(input, documents)) {
      emit("PreToolUse", {
        permissionDecision: "deny",
        permissionDecisionReason:
          "This change may have been written in the same step as the tool call that brought this file type's project coding standards into context, before they reached it, so it was not applied. They are in context now, and the change can be made again following them.",
      });
    }
    return;
  }
  const denial = decidesWrite
    ? {
        permissionDecision: "deny",
        permissionDecisionReason:
          "This file type's project coding standards were not in context when this change was written, so it was not applied. They are now in context alongside this result, and the change can be made again following them.",
      }
    : {};
  emit("PreToolUse", { ...denial, additionalContext: message });
}

function handleSessionStart(input, slot) {
  if (input.source === "clear") {
    if (slot === 0) {
      withSessionLock(input, () => fs.rmSync(statePath(input), { force: true }));
    }
    return;
  }
  if (input.source !== "compact") {
    return;
  }
  const compactions = countCompactBoundaries(input.transcript_path);
  const messages = sharedPlan(input, `compact-${compactions}`, () => {
    const state = readState(input);
    const scan = scanTranscript(input.transcript_path, state.transcriptOffset);
    const { messages, delivered } = buildMessages(state.loaded.map((entry) => entry.document));
    writeJsonAtomically(statePath(input), {
      loaded: loadedEntries(delivered, null),
      transcriptOffset: scan.offset,
    });
    return messages;
  });
  if (messages[slot] !== undefined) {
    emit("SessionStart", { additionalContext: messages[slot] });
  }
}

function handleSubagentStart(input, slot) {
  if (slot !== 0) {
    return;
  }
  withSessionLock(input, () => {
    // A fork's transcript starts with the parent's history, whose compactions are already
    // reflected in the parent's state
    const scan = scanTranscript(transcriptPath(input), 0);
    writeJsonAtomically(statePath(input), {
      loaded: readState(input, "main").loaded,
      transcriptOffset: scan.offset,
    });
  });
}

const handlers = {
  post: handlePostToolUse,
  pre: handlePreToolUse,
  session: handleSessionStart,
  subagent: handleSubagentStart,
};

try {
  const [mode, slotArgument = "0"] = process.argv.slice(2);
  configuration = readJson(path.join(projectDirectory, ".claude", "standards.json"));
  const handler = handlers[mode];
  if (handler === undefined) {
    throw new Error(`Unknown mode "${mode}"; expected one of ${Object.keys(handlers).join(", ")}`);
  }
  handler(readStandardInput(), Number(slotArgument));
} catch (error) {
  process.stderr.write(`standards hook: ${error.stack ?? error}\n`);
}
