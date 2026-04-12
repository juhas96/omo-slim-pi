import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findImplementations,
  findReferences,
  getDiagnostics,
  getTypeDefinitions,
  gotoDefinition,
  hoverSymbol,
  listSymbols,
  renameSymbol,
} from "../extensions/oh-my-opencode-pi/tools/lsp.ts";

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

test("LSP helpers support Go and Rust heuristic navigation with capability-aware fallback behavior", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-lsp-native-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const goPath = path.join(projectDir, "main.go");
  fs.writeFileSync(goPath, [
    "package main",
    "",
    "type Greeter struct {}",
    "",
    "func (g Greeter) Greet(name string) string {",
    "  return \"hi \" + name",
    "}",
    "",
    "func main() {",
    "  var greeter Greeter",
    "  _ = greeter.Greet(\"pi\")",
    "}",
    "",
  ].join("\n"));

  const rustPath = path.join(projectDir, "lib.rs");
  fs.writeFileSync(rustPath, [
    "pub trait Greeter {",
    "    fn greet(&self, name: &str) -> String;",
    "}",
    "",
    "pub struct ConsoleGreeter;",
    "",
    "impl Greeter for ConsoleGreeter {",
    "    fn greet(&self, name: &str) -> String {",
    "        format!(\"hi {}\", name)",
    "    }",
    "}",
    "",
  ].join("\n"));

  const goHover = hoverSymbol(projectDir, { path: goPath, line: 3, character: 8 });
  assert.match(goHover.text, /struct Greeter|Navigation mode: heuristic/i);
  const goDefinition = gotoDefinition(projectDir, { path: goPath, line: 10, character: 15 });
  assert.equal(goDefinition.locations[0]?.line, 3);
  const goReferences = findReferences(projectDir, { path: goPath, line: 3, character: 8, includeDeclaration: true });
  assert.ok(goReferences.locations.length >= 2);
  const goSymbols = listSymbols(projectDir, { path: goPath, maxResults: 20 });
  assert.ok(goSymbols.symbols.some((symbol) => symbol.name === "Greeter"));
  const goRename = renameSymbol(projectDir, { path: goPath, line: 3, character: 8, newName: "Speaker", apply: true });
  assert.ok((goRename.files[0]?.edits ?? 0) >= 2);
  assert.match(fs.readFileSync(goPath, "utf8"), /type Speaker struct/);

  const rustHover = hoverSymbol(projectDir, { path: rustPath, line: 1, character: 11 });
  assert.match(rustHover.text, /trait Greeter|Navigation mode: heuristic/i);
  const rustImplementations = findImplementations(projectDir, { path: rustPath, line: 1, character: 11 });
  assert.ok(rustImplementations.locations.some((location) => /ConsoleGreeter/.test(location.preview)));
  const rustSymbols = listSymbols(projectDir, { path: rustPath, maxResults: 20 });
  assert.ok(rustSymbols.symbols.some((symbol) => symbol.name === "ConsoleGreeter"));

  const brokenGo = path.join(projectDir, "broken.go");
  fs.writeFileSync(brokenGo, "func nope() {}\n");
  const goDiagnostics = getDiagnostics(projectDir, { path: brokenGo, maxResults: 10 });
  assert.ok(goDiagnostics.diagnostics.length >= 1);

  const brokenRust = path.join(projectDir, "broken.rs");
  fs.writeFileSync(brokenRust, "pub fn broken() {\n");
  const rustDiagnostics = getDiagnostics(projectDir, { path: brokenRust, maxResults: 10 });
  assert.ok(rustDiagnostics.diagnostics.length >= 1);
});

test("LSP helpers support JSONC navigation, references, diagnostics, and rename flows", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-lsp-json-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const filePath = path.join(projectDir, "schema.jsonc");
  fs.writeFileSync(filePath, `{
  // schema with JSONC comments
  "$defs": {
    "User": {
      "type": "object",
      "properties": {
        "id": { "type": "string" }
      }
    }
  },
  "items": {
    "$ref": "#/$defs/User"
  }
}
`);

  const hover = hoverSymbol(projectDir, { path: filePath, line: 4, character: 7 });
  assert.match(hover.text, /Property: User/);
  assert.match(hover.text, /\$\.\$defs\.User/);

  const definition = gotoDefinition(projectDir, { path: filePath, line: 12, character: 16 });
  assert.equal(definition.locations[0]?.line, 4);

  const references = findReferences(projectDir, { path: filePath, line: 4, character: 7, includeDeclaration: true });
  assert.ok(references.locations.some((location) => location.line === 12));

  const implementations = findImplementations(projectDir, { path: filePath, line: 4, character: 7 });
  assert.ok(implementations.locations.some((location) => location.line === 12));

  const typeDefs = getTypeDefinitions(projectDir, { path: filePath, line: 11, character: 8 });
  assert.ok(typeDefs.locations.some((location) => location.kind === "json-ref" || location.kind === "json-ref-target"));

  const diagnostics = getDiagnostics(projectDir, { path: filePath, maxResults: 10 });
  assert.equal(diagnostics.diagnostics.length, 0);

  const symbols = listSymbols(projectDir, { path: filePath, query: "User", maxResults: 10 });
  assert.ok(symbols.symbols.some((symbol) => symbol.name === "User"));

  const renamePreview = renameSymbol(projectDir, { path: filePath, line: 4, character: 7, newName: "Account", apply: false });
  assert.equal(renamePreview.files[0]?.edits, 2);

  const renameApplied = renameSymbol(projectDir, { path: filePath, line: 4, character: 7, newName: "Account", apply: true });
  assert.equal(renameApplied.files[0]?.edits, 2);
  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /"Account"/);
  assert.match(updated, /#\/\$defs\/Account/);
});
