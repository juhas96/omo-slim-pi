import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findImplementations, getTypeDefinitions, hoverSymbol, listSymbols } from "../extensions/oh-my-opencode-pi/tools/lsp.ts";

test("LSP helpers expose hover, implementations, type definitions, and symbols", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-lsp-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["**/*.ts"],
  }, null, 2));

  const filePath = path.join(projectDir, "index.ts");
  fs.writeFileSync(filePath, `
interface Greeter {
  greet(name: string): string;
}

type GreetingFn = (name: string) => string;

class ConsoleGreeter implements Greeter {
  greet(name: string): string {
    return "hello " + name;
  }
}

const greeter: Greeter = new ConsoleGreeter();
const alias: GreetingFn = (name) => greeter.greet(name);
alias("pi");
`.trimStart());

  const hover = hoverSymbol(projectDir, { path: filePath, line: 13, character: 8 });
  assert.match(hover.text, /Greeter|greeter/i);

  const implementations = findImplementations(projectDir, { path: filePath, line: 1, character: 12 });
  assert.ok(implementations.locations.some((location) => /ConsoleGreeter/.test(location.preview)));

  const typeDefs = getTypeDefinitions(projectDir, { path: filePath, line: 13, character: 8 });
  assert.ok(typeDefs.locations.length >= 1);

  const symbols = listSymbols(projectDir, { path: filePath, maxResults: 20 });
  assert.ok(symbols.symbols.some((symbol) => symbol.name === "ConsoleGreeter"));

  const workspaceSymbols = listSymbols(projectDir, { path: filePath, query: "greet", maxResults: 20 });
  assert.ok(workspaceSymbols.symbols.some((symbol) => /greet/i.test(symbol.name)));
});
