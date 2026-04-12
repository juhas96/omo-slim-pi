import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("adapter health command reports status without prefilling the composer", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-adapter-health-command-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "adapters": {
      "defaultAllow": ["docs-context7"]
    }
  }`);

  const commands = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];
  let editorWrites = 0;

  const fakePi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  };

  extension(fakePi as never);

  const command = commands.get("pantheon-adapter-health");
  assert.ok(command?.handler);

  await command.handler("", {
    cwd: projectDir,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level: level ?? "info" });
      },
      setEditorText() {
        editorWrites += 1;
      },
    },
  });

  assert.equal(editorWrites, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /docs-context7 \[ok\] auth=not-required/);
});
