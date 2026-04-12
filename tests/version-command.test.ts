import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("pantheon-version command renders a package version report without injecting chat text", async () => {
  const commands = new Map<string, any>();
  const sentMessages: string[] = [];
  let editorText = "";

  const fakePi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
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
  assert.match(editorText, /Pantheon package version report/);
  assert.match(editorText, /Current version:/);
  assert.match(editorText, /Local checkout:/);
});
