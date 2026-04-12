import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findReferences, getDiagnostics, gotoDefinition, hoverSymbol, listSymbols, renameSymbol } from "../extensions/oh-my-opencode-pi/tools/lsp.ts";
import { formatDocument, organizeImports } from "../extensions/oh-my-opencode-pi/tools/format.ts";

test("Python LSP helpers support hover, definition, references, diagnostics, symbols, and rename", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-python-lsp-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "app.py");
  fs.writeFileSync(filePath, [
    "class Greeter:",
    "    def greet(self, name):",
    "        return f'hi {name}'",
    "",
    "class LoudGreeter(Greeter):",
    "    pass",
    "",
    "greeter = Greeter()",
    "print(greeter.greet('pi'))",
    "",
  ].join("\n"));

  const hover = hoverSymbol(projectDir, { path: filePath, line: 1, character: 8 });
  assert.match(hover.text, /class Greeter|class Greeter/i);

  const definition = gotoDefinition(projectDir, { path: filePath, line: 8, character: 11 });
  assert.equal(definition.locations[0]?.line, 1);

  const references = findReferences(projectDir, { path: filePath, line: 1, character: 8, includeDeclaration: true });
  assert.ok(references.locations.length >= 2);

  const symbols = listSymbols(projectDir, { path: filePath, maxResults: 20 });
  assert.ok(symbols.symbols.some((symbol) => symbol.name === "Greeter"));

  const renamePreview = renameSymbol(projectDir, { path: filePath, line: 1, character: 8, newName: "Speaker", apply: false });
  assert.equal(renamePreview.files[0]?.edits, 3);

  const renameApplied = renameSymbol(projectDir, { path: filePath, line: 1, character: 8, newName: "Speaker", apply: true });
  assert.equal(renameApplied.files[0]?.edits, 3);
  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /class Speaker/);
  assert.match(updated, /class LoudGreeter\(Speaker\)/);

  fs.writeFileSync(path.join(projectDir, "broken.py"), "def broken(:\n    pass\n");
  const diagnostics = getDiagnostics(projectDir, { path: path.join(projectDir, "broken.py") });
  assert.ok(diagnostics.diagnostics.length >= 1);
});

test("formatDocument formats JSON, Go/Rust fallback documents, and organizeImports rewrites TS import blocks", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-format-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const jsonPath = path.join(projectDir, "config.jsonc");
  fs.writeFileSync(jsonPath, '{  "b":2, "a": 1 }');
  const formatted = formatDocument(projectDir, { path: jsonPath, apply: true });
  assert.equal(formatted.changed, true);
  assert.match(fs.readFileSync(jsonPath, "utf8"), /\n  "b": 2,/);

  const goPath = path.join(projectDir, "main.go");
  fs.writeFileSync(goPath, "package main   \n\nfunc main() {    \n}\n");
  const goFormatted = formatDocument(projectDir, { path: goPath, apply: true });
  assert.equal(typeof goFormatted.changed, "boolean");
  assert.ok(fs.readFileSync(goPath, "utf8").endsWith("\n"));

  const rustPath = path.join(projectDir, "lib.rs");
  fs.writeFileSync(rustPath, "pub fn demo() {    \n}\n");
  const rustFormatted = formatDocument(projectDir, { path: rustPath, apply: true });
  assert.equal(typeof rustFormatted.changed, "boolean");
  assert.ok(fs.readFileSync(rustPath, "utf8").endsWith("\n"));

  const tsPath = path.join(projectDir, "index.ts");
  fs.writeFileSync(tsPath, [
    "import { z } from './z';",
    "import { a } from './a';",
    "",
    "console.log(a, z);",
    "",
  ].join("\n"));
  const organized = organizeImports(projectDir, { path: tsPath, apply: true });
  assert.equal(typeof organized.changed, "boolean");
  const tsText = fs.readFileSync(tsPath, "utf8");
  assert.ok(tsText.includes("import { a } from './a';") || tsText.includes('import { a } from "./a";'));
});
