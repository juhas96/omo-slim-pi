import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("pantheon-version command renders a package version report in chat and the editor", async () => {
  const commands = new Map<string, any>();
  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  let editorText = "";

  const fakePi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage(message: { content?: string; details?: any }) {
      commandMessages.push(message);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
    appendEntry() {},
  };

  extension(fakePi as never);

  const command = commands.get("pantheon-version");
  assert.ok(command?.handler);

  await command.handler("", {
    cwd: process.cwd(),
    ui: {
      notify() {},
      setEditorText(text: string) {
        editorText = text;
      },
      setStatus() {},
      setWidget() {},
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.match(editorText, /Command: \/pantheon-version/);
  assert.equal(commandMessages.length, 1);
  assert.match(commandMessages[0]?.content ?? "", /Pantheon package version report/);
  assert.match(commandMessages[0]?.content ?? "", /Current version:/);
  assert.match(commandMessages[0]?.content ?? "", /Local checkout:/);
});
