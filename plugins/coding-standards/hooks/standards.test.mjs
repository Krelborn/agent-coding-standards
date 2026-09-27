import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryDirectory = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(import.meta.dirname, "standards.mjs");
const configuration = JSON.parse(fs.readFileSync(path.join(repositoryDirectory, ".claude", "standards.json"), "utf8"));
const commentsDocument = "docs/standards/comments.md";
const reactDocument = "docs/standards/react.md";
const typescriptDocument = "docs/standards/typescript.md";
const vitestDocument = "docs/standards/vitest-unit-testing.md";

let projectDirectory;
let temporaryDirectory;
let transcriptPath;
let toolUseCount = 0;

function runHook(mode, slot, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, mode, String(slot)], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDirectory, TMPDIR: temporaryDirectory },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ exitCode, stderr, output: stdout === "" ? undefined : JSON.parse(stdout) })
    );
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function runAllSlots(mode, input) {
  return Promise.all(Array.from({ length: configuration.slotCount }, (_, slot) => runHook(mode, slot, input)));
}

function toolInput(toolName, filePath, extra = {}) {
  toolUseCount += 1;
  return {
    session_id: "session",
    transcript_path: transcriptPath,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_use_id: `tool-${toolUseCount}`,
    tool_input: { file_path: path.join(projectDirectory, filePath) },
    ...extra,
  };
}

function sessionStartInput(source) {
  return {
    session_id: "session",
    transcript_path: transcriptPath,
    hook_event_name: "SessionStart",
    source,
  };
}

function contexts(results) {
  return results.map((result) => result.output?.hookSpecificOutput.additionalContext).filter(Boolean);
}

function injectedDocuments(results) {
  const text = contexts(results).join("\n");
  return configuration.rules.map((rule) => rule.document).filter((document) => text.includes(`standard ${document}`));
}

function appendCompactBoundary(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`);
}

function appendAssistantMessage(filePath, messageId, toolUseIds) {
  const content = toolUseIds.map((toolUseId) => ({
    type: "tool_use",
    id: toolUseId,
    name: "Read",
    input: {},
  }));
  fs.appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { id: messageId, content } })}\n`);
}

function appendThinking(filePath, messageId) {
  const content = [{ type: "thinking", thinking: "" }];
  fs.appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { id: messageId, content } })}\n`);
}

function mainStatePath() {
  return path.join(temporaryDirectory, "claude-standards", "session", "main.json");
}

function seedOldFormatState(documents) {
  fs.mkdirSync(path.dirname(mainStatePath()), { recursive: true });
  fs.writeFileSync(mainStatePath(), JSON.stringify({ loaded: documents, transcriptOffset: 0 }));
}

function stripHeaders(text) {
  return text.replace(
    /Project coding standard \S+( \(part \d+ of \d+\))?, which applies to [^\n]* files\. Its full text:\n\n/g,
    ""
  );
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "standards-hook-"));
  projectDirectory = path.join(temporaryDirectory, "project");
  fs.mkdirSync(path.join(projectDirectory, ".claude"), { recursive: true });
  fs.cpSync(
    path.join(repositoryDirectory, ".claude", "standards.json"),
    path.join(projectDirectory, ".claude", "standards.json")
  );
  fs.cpSync(path.join(repositoryDirectory, "docs"), path.join(projectDirectory, "docs"), {
    recursive: true,
  });
  transcriptPath = path.join(temporaryDirectory, "session.jsonl");
  fs.writeFileSync(transcriptPath, "");
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("standards hook", () => {
  describe("on Read", () => {
    it("injects the standards matching the file type", async () => {
      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts"))), [
        commentsDocument,
        typescriptDocument,
      ]);
      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/Button.tsx"))), [
        reactDocument,
      ]);
      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx"))), [
        vitestDocument,
      ]);
    });

    it("injects nothing for unmatched or excluded files", async () => {
      for (const filePath of ["README.md", "node_modules/react/index.ts", "dist/index.js", "../elsewhere/file.ts"]) {
        assert.deepEqual(contexts(await runAllSlots("pre", toolInput("Read", filePath))), []);
      }
    });

    it("injects each standard once per context", async () => {
      await runAllSlots("pre", toolInput("Read", "src/Button.tsx"));

      assert.deepEqual(contexts(await runAllSlots("pre", toolInput("Read", "src/Other.tsx"))), []);
    });

    it("lets the read proceed", async () => {
      const results = await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      assert.ok(results.every((result) => result.output?.hookSpecificOutput.permissionDecision === undefined));
    });
  });

  describe("on Write and Edit", () => {
    for (const toolName of ["Write", "Edit"]) {
      it(`denies a ${toolName} made before its standards were in context and allows the retry`, async () => {
        const firstInput = toolInput(toolName, "src/format.test.ts");
        const retryInput = toolInput(toolName, "src/format.test.ts");
        appendAssistantMessage(transcriptPath, "message-1", [firstInput.tool_use_id]);
        appendAssistantMessage(transcriptPath, "message-2", [retryInput.tool_use_id]);

        const first = await runAllSlots("pre", firstInput);
        const retry = await runAllSlots("pre", retryInput);

        assert.equal(first[0].output.hookSpecificOutput.permissionDecision, "deny");
        assert.ok(first.slice(1).every((result) => result.output?.hookSpecificOutput.permissionDecision === undefined));
        assert.ok(injectedDocuments(first).length > 0);
        assert.ok(retry.every((result) => result.output === undefined));
      });
    }

    it("denies a Write composed in the same assistant message as the Read that loaded its standards", async () => {
      const read = toolInput("Read", "src/A.tsx");
      const write = toolInput("Write", "src/B.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [read.tool_use_id]);
      appendAssistantMessage(transcriptPath, "message-1", [write.tool_use_id]);
      await runAllSlots("pre", read);

      const results = await runAllSlots("pre", write);

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(results[0].output.hookSpecificOutput.additionalContext, undefined);
      assert.ok(results.slice(1).every((result) => result.output === undefined));
    });

    it("allows a Write composed in a later assistant message than the Read that loaded its standards", async () => {
      const read = toolInput("Read", "src/A.tsx");
      const write = toolInput("Write", "src/B.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [read.tool_use_id]);
      appendAssistantMessage(transcriptPath, "message-2", [write.tool_use_id]);
      await runAllSlots("pre", read);

      assert.ok((await runAllSlots("pre", write)).every((result) => result.output === undefined));
    });

    it("denies a Write missing from the transcript just after its standards were loaded", async () => {
      await runAllSlots("pre", toolInput("Read", "src/A.tsx"));

      const results = await runAllSlots("pre", toolInput("Write", "src/B.tsx"));

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
      assert.ok(results.slice(1).every((result) => result.output === undefined));
    });

    it("allows a retried Write missing from the transcript once a later assistant message has started", async () => {
      const first = toolInput("Write", "src/A.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [first.tool_use_id]);
      await runAllSlots("pre", first);
      appendThinking(transcriptPath, "message-2");

      assert.ok(
        (await runAllSlots("pre", toolInput("Write", "src/A.tsx"))).every((result) => result.output === undefined)
      );
    });

    it("denies a Write missing from the transcript when only an assistant entry with no message ID follows", async () => {
      const first = toolInput("Write", "src/A.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [first.tool_use_id]);
      await runAllSlots("pre", first);
      fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);

      const results = await runAllSlots("pre", toolInput("Write", "src/B.tsx"));

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
    });

    it("denies a second Write missing from the transcript when no later assistant message has started", async () => {
      const first = toolInput("Write", "src/A.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [first.tool_use_id]);
      await runAllSlots("pre", first);

      const results = await runAllSlots("pre", toolInput("Write", "src/B.tsx"));

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
    });

    it("allows a Write missing from the transcript when its standards were loaded 10 seconds ago", async () => {
      await runAllSlots("pre", toolInput("Read", "src/A.tsx"));
      const state = JSON.parse(fs.readFileSync(mainStatePath(), "utf8"));
      const loaded = state.loaded.map((entry) => ({ ...entry, loadedAt: Date.now() - 10000 }));
      fs.writeFileSync(mainStatePath(), JSON.stringify({ ...state, loaded }));

      assert.ok(
        (await runAllSlots("pre", toolInput("Write", "src/B.tsx"))).every((result) => result.output === undefined)
      );
    });
  });

  describe("on Bash", () => {
    const rawDiff = [
      "diff --git a/src/Button.tsx b/src/Button.tsx",
      "--- a/src/Button.tsx",
      "+++ b/src/Button.tsx",
      "@@ -1 +1 @@",
      "+export {}",
    ].join("\n");
    const compactedDiff = [
      "src/format.ts | 1 +",
      " 1 file changed, 1 insertion(+)",
      "",
      "src/format.ts",
      "  @@ -1 +1 @@",
    ].join("\n");

    function bashInput(command, stdout, extra = {}) {
      return {
        ...toolInput("Bash", "unused", extra),
        hook_event_name: "PostToolUse",
        tool_input: { command },
        tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
      };
    }

    beforeEach(() => {
      fs.mkdirSync(path.join(projectDirectory, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDirectory, "src", "Button.tsx"), "");
      fs.writeFileSync(path.join(projectDirectory, "src", "format.ts"), "");
    });

    it("injects the standards for files in a git diff", async () => {
      assert.deepEqual(injectedDocuments(await runAllSlots("post", bashInput("git diff HEAD", rawDiff))), [
        commentsDocument,
        typescriptDocument,
        reactDocument,
      ]);
    });

    it("injects the standards for files in compacted git output", async () => {
      assert.deepEqual(
        injectedDocuments(await runAllSlots("post", bashInput("rtk git show HEAD -- src/format.ts", compactedDiff))),
        [commentsDocument, typescriptDocument]
      );
    });

    it("injects the standards for files in a pull request diff", async () => {
      assert.ok(injectedDocuments(await runAllSlots("post", bashInput("gh pr diff 12", rawDiff))).length > 0);
    });

    it("injects the standards for a git diff run with --no-pager", async () => {
      assert.ok(injectedDocuments(await runAllSlots("post", bashInput("git --no-pager diff", rawDiff))).length > 0);
    });

    it("injects the standards for a git diff run with -C", async () => {
      assert.ok(injectedDocuments(await runAllSlots("post", bashInput("git -C . diff", rawDiff))).length > 0);
    });

    it("injects the standards for a git diff run with -P", async () => {
      assert.ok(injectedDocuments(await runAllSlots("post", bashInput("git -P diff", rawDiff))).length > 0);
    });

    it("ignores a non-change command with global options", async () => {
      assert.deepEqual(contexts(await runAllSlots("post", bashInput("git --no-pager status", rawDiff))), []);
    });

    it("injects the standards for a stat path git shortened", async () => {
      const directory = path.join(projectDirectory, "src", "components", "ThemeSwitcher");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "ThemeSwitcher.module.css"), "");
      execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
      const stat = " .../ThemeSwitcher/ThemeSwitcher.module.css | 5 +\n 1 file changed, 5 insertions(+)";

      assert.deepEqual(injectedDocuments(await runAllSlots("post", bashInput("git diff --stat", stat))), [
        commentsDocument,
        reactDocument,
      ]);
    });

    it("injects the standards for a stat path git shortened inside its file name", async () => {
      fs.writeFileSync(path.join(projectDirectory, "src", "averylongfilename.ts"), "");
      execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });

      assert.deepEqual(
        injectedDocuments(await runAllSlots("post", bashInput("git show --stat=20", " ...gfilename.ts | 1 +"))),
        [commentsDocument, typescriptDocument]
      );
    });

    it("ignores a shortened stat path that matches more than one file", async () => {
      for (const directory of ["one", "two"]) {
        fs.mkdirSync(path.join(projectDirectory, "src", directory), { recursive: true });
        fs.writeFileSync(path.join(projectDirectory, "src", directory, "Same.tsx"), "");
      }
      execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });

      assert.deepEqual(contexts(await runAllSlots("post", bashInput("git diff --stat", " .../Same.tsx | 1 +"))), []);
    });

    it("injects the standards for a renamed path in stat output", async () => {
      fs.mkdirSync(path.join(projectDirectory, "src", "next"), { recursive: true });
      fs.writeFileSync(path.join(projectDirectory, "src", "next", "Card.tsx"), "");

      assert.deepEqual(
        injectedDocuments(
          await runAllSlots("post", bashInput("git diff --stat", " src/{old => next}/Card.tsx | 2 +-"))
        ),
        [commentsDocument, typescriptDocument, reactDocument]
      );
      assert.deepEqual(
        injectedDocuments(
          await runAllSlots("post", bashInput("git diff --stat", " notes.md => src/format.ts | 0", { agent_id: "x" }))
        ),
        [commentsDocument, typescriptDocument]
      );
    });

    it("ignores files mentioned only in the changed text", async () => {
      const prose = [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "+See src/Button.tsx and src/format.ts",
      ].join("\n");

      assert.deepEqual(contexts(await runAllSlots("post", bashInput("git diff", prose))), []);
    });

    it("ignores commands that do not show changes", async () => {
      assert.deepEqual(contexts(await runAllSlots("post", bashInput("ls src", "Button.tsx\nformat.ts"))), []);
      assert.deepEqual(contexts(await runAllSlots("post", bashInput("cat src/format.ts", compactedDiff))), []);
    });

    it("denies an Edit composed in the same assistant message as a git diff that loaded its standards", async () => {
      const diff = bashInput("git diff", rawDiff);
      const edit = toolInput("Edit", "src/Button.tsx");
      appendAssistantMessage(transcriptPath, "message-1", [diff.tool_use_id, edit.tool_use_id]);
      await runAllSlots("post", diff);

      const results = await runAllSlots("pre", edit);

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
      assert.ok(results.slice(1).every((result) => result.output === undefined));
    });

    it("never denies the command", async () => {
      const results = await runAllSlots("post", bashInput("git diff", rawDiff));

      assert.ok(results.every((result) => result.output?.hookSpecificOutput.permissionDecision === undefined));
    });
  });

  describe("message size", () => {
    it("keeps every message within the additionalContext limit and delivers documents in full", async () => {
      const messages = contexts(await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx")));

      assert.ok(messages.every((message) => message.length <= 10000));
      const delivered = stripHeaders(messages.join("\n\n"));
      for (const document of [commentsDocument, typescriptDocument, reactDocument, vitestDocument]) {
        const text = fs.readFileSync(path.join(projectDirectory, document), "utf8");
        for (const line of text.split("\n").filter((line) => line.trim() !== "")) {
          assert.ok(delivered.includes(line), `${document} is missing the line: ${line}`);
        }
      }
    });

    it("delivers each message exactly once across parallel slots", async () => {
      const messages = contexts(await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx")));

      assert.equal(new Set(messages).size, messages.length);
      assert.equal(
        injectedDocuments([{ output: { hookSpecificOutput: { additionalContext: messages.join("\n") } } }]).length,
        4
      );
    });
  });

  describe("after compaction", () => {
    it("injects standards again once the transcript records a compaction", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      appendCompactBoundary(transcriptPath);

      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts"))), [
        commentsDocument,
        typescriptDocument,
      ]);
    });

    it("does not treat an escaped compaction marker in transcript content as a compaction", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      const escapedLine = JSON.stringify({
        type: "user",
        message: { content: '"subtype":"compact_boundary"' },
      });
      fs.appendFileSync(transcriptPath, `${escapedLine}\n`);

      assert.deepEqual(contexts(await runAllSlots("pre", toolInput("Read", "src/format.ts"))), []);
    });

    it("restores loaded standards when the main session compacts", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      appendCompactBoundary(transcriptPath);

      const restored = await runAllSlots("session", sessionStartInput("compact"));
      const nextRead = await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      assert.deepEqual(injectedDocuments(restored), [commentsDocument, typescriptDocument]);
      assert.deepEqual(contexts(nextRead), []);
    });

    it("allows a Write straight after the main session compacts", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      appendCompactBoundary(transcriptPath);
      await runAllSlots("session", sessionStartInput("compact"));

      assert.ok(
        (await runAllSlots("pre", toolInput("Write", "src/other.ts"))).every((result) => result.output === undefined)
      );
    });

    it("restores standards recorded in the older state format", async () => {
      seedOldFormatState([commentsDocument]);
      appendCompactBoundary(transcriptPath);

      const restored = await runAllSlots("session", sessionStartInput("compact"));

      assert.deepEqual(injectedDocuments(restored), [commentsDocument]);
      assert.ok(restored.every((result) => result.stderr === ""));
    });

    it("reuses the compaction plan when a transcript line only resembles the marker", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      appendCompactBoundary(transcriptPath);
      const firstRestore = await runAllSlots("session", sessionStartInput("compact"));

      await runAllSlots("pre", toolInput("Read", "src/Button.tsx"));
      const escapedLine = JSON.stringify({
        type: "user",
        message: { content: '"subtype":"compact_boundary"' },
      });
      fs.appendFileSync(transcriptPath, `${escapedLine}\n`);
      const secondRestore = await runAllSlots("session", sessionStartInput("compact"));

      assert.deepEqual(injectedDocuments(firstRestore), [commentsDocument, typescriptDocument]);
      assert.deepEqual(injectedDocuments(secondRestore), [commentsDocument, typescriptDocument]);
    });

    it("restores the standards still configured when a loaded one was removed", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      const configurationPath = path.join(projectDirectory, ".claude", "standards.json");
      const rules = configuration.rules.filter((rule) => rule.document !== commentsDocument);
      fs.writeFileSync(configurationPath, JSON.stringify({ ...configuration, rules }));
      appendCompactBoundary(transcriptPath);

      const restored = await runAllSlots("session", sessionStartInput("compact"));

      assert.deepEqual(injectedDocuments(restored), [typescriptDocument]);
      assert.ok(restored.every((result) => result.stderr === ""));
    });

    it("forgets loaded standards when the session is cleared", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      await runAllSlots("session", sessionStartInput("clear"));

      assert.ok(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts"))).length > 0);
    });
  });

  describe("with state in the older format", () => {
    it("treats its documents as already in context for a Read", async () => {
      seedOldFormatState([commentsDocument, typescriptDocument]);

      assert.deepEqual(contexts(await runAllSlots("pre", toolInput("Read", "src/format.ts"))), []);
    });

    it("allows a Write without treating its documents as loaded in the same step", async () => {
      seedOldFormatState([commentsDocument, typescriptDocument]);

      assert.ok(
        (await runAllSlots("pre", toolInput("Write", "src/format.ts"))).every((result) => result.output === undefined)
      );
    });
  });

  describe("when standards outgrow the slots", () => {
    beforeEach(() => {
      const configurationPath = path.join(projectDirectory, ".claude", "standards.json");
      fs.writeFileSync(configurationPath, JSON.stringify({ ...configuration, slotCount: 2 }));
    });

    function configureDocuments(slotCount, lengths) {
      const rules = Object.entries(lengths).map(([name, length]) => {
        const document = `docs/standards/${name}.md`;
        fs.writeFileSync(path.join(projectDirectory, document), `${name} line\n`.repeat(length / (name.length + 6)));
        return { document, suffixes: [".x"] };
      });
      const configurationPath = path.join(projectDirectory, ".claude", "standards.json");
      fs.writeFileSync(configurationPath, JSON.stringify({ ...configuration, slotCount, rules }));
    }

    function sentParts(results, name) {
      return contexts(results)
        .join("\n")
        .split("Project coding standard ")
        .filter((piece) => piece.startsWith(`docs/standards/${name}.md`)).length;
    }

    it("makes progress when the first document needs every slot", async () => {
      configureDocuments(2, { big: 12000, small: 9000 });

      const first = await runAllSlots("pre", toolInput("Read", "src/a.x"));
      const second = await runAllSlots("pre", toolInput("Read", "src/b.x"));

      assert.equal(sentParts(first, "big"), 2);
      assert.equal(sentParts(second, "small"), 1);
    });

    it("sends a document with more parts than slots on its own call", async () => {
      configureDocuments(3, { small: 1000, huge: 45000 });

      const first = await runAllSlots("pre", toolInput("Read", "src/a.x"));
      const second = await runAllSlots("pre", toolInput("Read", "src/b.x"));

      assert.equal(sentParts(first, "huge"), 0);
      assert.equal(sentParts(second, "huge"), 2);
      assert.match(contexts(second).at(-1), /available to read in full: docs\/standards\/huge\.md/);
    });

    it("lists every document it could not deliver in full", async () => {
      const messages = contexts(await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx")));

      assert.equal(messages.length, 2);
      assert.match(messages[1], /available to read in full: .*docs\/standards\/vitest-unit-testing\.md/);
    });

    it("delivers the rest on later calls for the same file type", async () => {
      const delivered = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        delivered.push(...injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx"))));
      }

      assert.deepEqual(delivered.toSorted(), [commentsDocument, reactDocument, typescriptDocument, vitestDocument]);
    });

    it("denies a Write with the standards it has not delivered yet attached", async () => {
      await runAllSlots("pre", toolInput("Read", "src/Button.test.tsx"));

      const results = await runAllSlots("pre", toolInput("Write", "src/Other.test.tsx"));

      assert.equal(results[0].output.hookSpecificOutput.permissionDecision, "deny");
      assert.ok(injectedDocuments(results).length > 0);
    });

    it("delivers on the next call what a compaction could not restore", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));
      await runAllSlots("pre", toolInput("Read", "src/Button.tsx"));
      appendCompactBoundary(transcriptPath);
      const restored = await runAllSlots("session", sessionStartInput("compact"));

      assert.deepEqual(injectedDocuments(restored), [commentsDocument]);
      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts"))), [
        typescriptDocument,
      ]);
    });
  });

  describe("session lock", () => {
    it("recovers a lock left by a process that exited", async () => {
      const deadProcessId = await new Promise((resolve) => {
        const child = spawn("node", ["-e", ""]);
        child.on("close", () => resolve(child.pid));
      });
      const sessionDirectory = path.join(temporaryDirectory, "claude-standards", "session");
      fs.mkdirSync(sessionDirectory, { recursive: true });
      fs.writeFileSync(path.join(sessionDirectory, "lock"), String(deadProcessId));

      const results = await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      assert.deepEqual(injectedDocuments(results), [commentsDocument, typescriptDocument]);
      assert.ok(results.every((result) => result.stderr === ""));
    });
  });

  describe("in subagents", () => {
    const subagent = { agent_id: "abc123", agent_type: "Explore" };

    it("tracks each subagent's context separately from the main agent", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      assert.deepEqual(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts", subagent))), [
        commentsDocument,
        typescriptDocument,
      ]);
    });

    it("injects standards again after the subagent's own transcript records a compaction", async () => {
      await runAllSlots("pre", toolInput("Read", "src/format.ts", subagent));
      appendCompactBoundary(path.join(temporaryDirectory, "session", "subagents", "agent-abc123.jsonl"));

      assert.ok(injectedDocuments(await runAllSlots("pre", toolInput("Read", "src/format.ts", subagent))).length > 0);
    });

    it("treats a fork as already holding the main agent's standards", async () => {
      const fork = { agent_id: "fork1", agent_type: "fork" };
      await runAllSlots("pre", toolInput("Read", "src/format.ts"));

      await runHook("subagent", 0, {
        session_id: "session",
        transcript_path: transcriptPath,
        hook_event_name: "SubagentStart",
        ...fork,
      });

      assert.deepEqual(contexts(await runAllSlots("pre", toolInput("Read", "src/format.ts", fork))), []);
    });
  });

  it("exits cleanly without output on malformed input", async () => {
    const result = await runHook("pre", 0, "not json");

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, undefined);
    assert.match(result.stderr, /standards hook/);
  });

  it("is registered with one handler per slot", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(repositoryDirectory, ".claude", "settings.json"), "utf8"));

    for (const [event, mode] of [
      ["PreToolUse", "pre"],
      ["PostToolUse", "post"],
      ["SessionStart", "session"],
    ]) {
      const commands = settings.hooks[event][0].hooks.map((hook) => hook.command);
      const expected = Array.from({ length: configuration.slotCount }, (_, slot) => `standards.mjs" ${mode} ${slot}`);
      assert.deepEqual(
        commands.map((command) => command.slice(command.indexOf("standards.mjs"))),
        expected
      );
    }
  });
});
