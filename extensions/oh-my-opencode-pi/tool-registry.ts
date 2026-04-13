import { loadPantheonConfig } from "./config.js";
import {
  LspDiagnosticsParams,
  LspPositionParams,
  LspReferencesParams,
  LspRenameParams,
  LspSymbolsParams,
  findImplementations,
  findReferences,
  getDiagnostics,
  getTypeDefinitions,
  gotoDefinition,
  hoverSymbol,
  listSymbols,
  renameSymbol,
} from "./tools/lsp.js";
import { RepoMapParams, buildRepoMap } from "./tools/cartography.js";
import { CodeMapParams, buildCodeMap } from "./tools/codemap.js";
import { ApplyPatchParams, applyUnifiedPatch } from "./tools/patch.js";
import { FormatDocumentParams, OrganizeImportsParams, formatDocument, organizeImports } from "./tools/format.js";
import {
  AstGrepReplaceParams,
  AstGrepSearchParams,
  astGrepReplace,
  astGrepSearch,
} from "./tools/ast-grep.js";

type RegisterTool = (tool: any) => void;

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    details: undefined,
    isError: true,
  };
}

export function registerPantheonCodeTools(registerTool: RegisterTool): void {
  registerTool({
    name: "pantheon_lsp_goto_definition",
    label: "Pantheon LSP Definition",
    description: "Locate symbol definitions for TS/JS and JSON/JSONC files using Pi-native language-service integrations.",
    promptSnippet: "Jump to the definition of a symbol in a TypeScript or JavaScript project.",
    parameters: LspPositionParams,
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      try {
        const result = gotoDefinition(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  registerTool({ name: "pantheon_lsp_hover", label: "Pantheon LSP Hover", description: "Read hover/signature information for TS/JS and JSON/JSONC symbols.", promptSnippet: "Inspect symbol signature and inline documentation before editing or renaming code.", parameters: LspPositionParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = hoverSymbol(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_find_references", label: "Pantheon LSP References", description: "Find symbol references for TS/JS and JSON/JSONC files using Pi-native language-service integrations.", promptSnippet: "Find references to a symbol in a TypeScript or JavaScript project.", parameters: LspReferencesParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = findReferences(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_find_implementations", label: "Pantheon LSP Implementations", description: "Find implementation/reference sites for TS/JS and JSON/JSONC symbols.", promptSnippet: "Locate concrete implementations when tracing behavior from an interface or abstract definition.", parameters: LspPositionParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = findImplementations(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_type_definition", label: "Pantheon LSP Type Definition", description: "Locate TS/JS or JSON/JSONC type/reference definitions for the symbol under the cursor.", promptSnippet: "Jump to the underlying type definition when inspecting inferred or aliased types.", parameters: LspPositionParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = getTypeDefinitions(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_symbols", label: "Pantheon LSP Symbols", description: "List document or workspace symbols for TS/JS projects and JSON/JSONC files.", promptSnippet: "Inspect high-level symbol structure in a file or search for symbols across the current TS/JS project.", parameters: LspSymbolsParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = listSymbols(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_diagnostics", label: "Pantheon LSP Diagnostics", description: "Read TS/JS or JSON/JSONC diagnostics for a file or the nearest configured project/file.", promptSnippet: "Inspect TypeScript or JavaScript diagnostics before or after edits.", parameters: LspDiagnosticsParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = getDiagnostics(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result, isError: result.diagnostics.some((diagnostic: any) => diagnostic.category === "error") }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_rename", label: "Pantheon LSP Rename", description: "Preview or apply coordinated TS/JS, JSON/JSONC, or Python symbol renames.", promptSnippet: "Use coordinated renames instead of ad-hoc text edits when changing a symbol name.", parameters: LspRenameParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = renameSymbol(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_lsp_organize_imports", label: "Pantheon Organize Imports", description: "Preview or apply organize-imports code actions for TS/JS files.", promptSnippet: "Use a structured import organization pass after refactors instead of hand-editing import blocks.", parameters: OrganizeImportsParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = organizeImports(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_format_document", label: "Pantheon Format Document", description: "Preview or apply formatter edits for TS/JS and JSON/JSONC files.", promptSnippet: "Run a formatter pass after making structural edits or before final verification.", parameters: FormatDocumentParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = formatDocument(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_apply_patch", label: "Pantheon Apply Patch", description: "Preview or apply unified diff patches with tolerant hunk matching.", promptSnippet: "Use resilient patch application for larger refactors or when exact edit hunks are likely to drift.", parameters: ApplyPatchParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = applyUnifiedPatch(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_ast_grep_search", label: "Pantheon AST Search", description: "Run structural AST-grep searches against a file or directory.", promptSnippet: "Use structural search when plain text grep is too broad or syntax-aware matching matters.", parameters: AstGrepSearchParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = astGrepSearch(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_ast_grep_replace", label: "Pantheon AST Replace", description: "Preview or apply structural AST-grep rewrites against a file or directory.", promptSnippet: "Use structural replace for syntax-aware transformations instead of brittle text replacement.", parameters: AstGrepReplaceParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const result = astGrepReplace(ctx.cwd, params); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_repo_map", label: "Pantheon Repo Map", description: "Build a repository map summary for reconnaissance and planning.", promptSnippet: "Survey project structure, key files, directory hotspots, and entry points before planning large changes.", parameters: RepoMapParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const config = loadPantheonConfig(ctx.cwd).config; const result = buildRepoMap(ctx.cwd, { path: params.path, maxFiles: params.maxFiles ?? config.skills?.cartography?.maxFiles, maxDepth: params.maxDepth ?? config.skills?.cartography?.maxDepth, maxPerDirectory: params.maxPerDirectory ?? config.skills?.cartography?.maxPerDirectory, includeHidden: params.includeHidden, exclude: config.skills?.cartography?.exclude }); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
  registerTool({ name: "pantheon_code_map", label: "Pantheon Code Map", description: "Build a semantic code map with entrypoints, import edges, and key symbols.", promptSnippet: "Use semantic cartography when architecture, boundaries, imports, or important symbols matter more than the raw file tree.", parameters: CodeMapParams, async execute(_id: string, params: any, _s: AbortSignal | undefined, _u: unknown, ctx: any) { try { const config = loadPantheonConfig(ctx.cwd).config; const result = buildCodeMap(ctx.cwd, { path: params.path, maxFiles: params.maxFiles ?? config.skills?.cartography?.maxFiles, maxSymbols: params.maxSymbols, maxEdges: params.maxEdges }); return { content: [{ type: "text", text: result.text }], details: result }; } catch (error) { return errorResult(error); } } });
}
