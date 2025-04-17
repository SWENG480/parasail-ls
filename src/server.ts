// ───────────────────────── parasail-ls/src/server.ts ──────────────────────────
import {
  DidChangeConfigurationParams,
  TextDocumentPositionParams,
  InitializeParams,
  Hover,
  DocumentSymbol,
  DocumentSymbolParams,
  SymbolKind,
  TextEdit,
  Position,
  DocumentFormattingParams,
  CodeActionParams,
  CodeAction,
  WorkspaceEdit,
  RenameParams,
  SemanticTokensParams,
  SemanticTokens,
  SemanticTokensRangeParams,
  CompletionItem,
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

import { connection, documents, handleOnInitialize, initParams } from './lspLifeCycle';
import { debugCheckFile, uriToFilePath } from './utils';

////////////////////////////////////////////////////////////////////////////////
// 1) Global settings
////////////////////////////////////////////////////////////////////////////////
interface ParasailSettings {
  maxNumberOfProblems: number;
  enableFormatting: boolean;
  libraryPaths: string[];
  implicitImports: boolean;
}
let globalSettings: ParasailSettings = {
  maxNumberOfProblems: 1000,
  enableFormatting: true,
  libraryPaths: [],
  implicitImports: true
};

const userDictionary = new Set<string>();
const documentSettings = new Map<string, Thenable<ParasailSettings>>();

////////////////////////////////////////////////////////////////////////////////
// 2) Initialise
////////////////////////////////////////////////////////////////////////////////
connection.onInitialize((params: InitializeParams) => {
  const binDir = path.resolve(__dirname, '..', '..', '..', '..', 'parasail_macos_build', 'bin');
  const interp = path.join(binDir, 'interp.csh');
  const scriptsDir = path.resolve(__dirname, '..', 'scripts');
  const lookup = path.join(scriptsDir, 'extension_lookup.psl');

  debugCheckFile(interp, 'interp.csh');
  debugCheckFile(lookup, 'extension_lookup.psl');

  return handleOnInitialize(params);
});
connection.onDidChangeConfiguration((c: DidChangeConfigurationParams) => {
  globalSettings = c.settings.parasailServer || globalSettings;
  documents.all().forEach(validateDocument);
});

////////////////////////////////////////////////////////////////////////////////
// 3) Library notifications
////////////////////////////////////////////////////////////////////////////////
interface LibraryInfo {
  name: string;
  path: string;
  sources: string[];
  headers: string[];
}
const addedLibraries: LibraryInfo[] = [];

connection.onNotification('parasail/addLibrary', p => {
  if (!addedLibraries.some(l => l.path === p.path)) {
    addedLibraries.push({ name: p.name, path: p.path, sources: p.sources || [], headers: p.headers || [] });
    connection.sendNotification('parasail/libraryAdded', { name: p.name, path: p.path });
  }
});
connection.onNotification('parasail/removeLibrary', p => {
  for (let i = addedLibraries.length - 1; i >= 0; i--) {
    if (addedLibraries[i].path === p.path) addedLibraries.splice(i, 1);
  }
  connection.sendNotification('parasail/libraryRemoved', { name: p.name, path: p.path });
});

////////////////////////////////////////////////////////////////////////////////
// 4) Document lifecycle
////////////////////////////////////////////////////////////////////////////////
documents.onDidSave(e => {
  const fp = uriToFilePath(e.document.uri);
  if (fp && /\.(psi|psl)$/i.test(fp)) validateDocument(e.document);
});
documents.onDidClose(e => {
  dslProcesses.get(e.document.uri)?.stdin?.end();
  dslProcesses.delete(e.document.uri);
  interactiveDsl.get(e.document.uri)?.stdin?.end();
  interactiveDsl.delete(e.document.uri);
});
documents.listen(connection);

////////////////////////////////////////////////////////////////////////////////
// 5) Validation
////////////////////////////////////////////////////////////////////////////////
const DSL_ENTRY = 'PSL_Extension::Main';
const dslProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const lastRun = new Map<string, number>();

async function validateDocument(doc: TextDocument): Promise<void> {
  const uri = doc.uri;
  const file = uriToFilePath(uri);
  if (!file) return;

  const now = Date.now();
  if ((lastRun.get(uri) ?? 0) > now - 300) return;
  lastRun.set(uri, now);

  const binDir = path.resolve(__dirname, '..', '..', '..', '..', 'parasail_macos_build', 'bin');
  const interp = path.join(binDir, 'interp.csh');
  const scriptsDir = path.resolve(__dirname, '..', 'scripts');
  const lookup = initParams?.initializationOptions?.dslScript || path.join(scriptsDir, 'extension_lookup.psl');

  const args = [lookup, file, '-command', DSL_ENTRY, file];
  connection.console.log(`spawn → ${interp} ${args.join(' ')}`);

  const child = spawn(interp, args, { cwd: path.dirname(file), env: process.env });
  dslProcesses.set(uri, child);

  // ── NEW: tell interpreter to exit once script completes ────────────────
  child.stdin.write('exit\n');
  child.stdin.end();
  // ───────────────────────────────────────────────────────────────────────

  let out = '';
  child.stdout.on('data', b => { const t = b.toString(); out += t; connection.console.log(`[DSL stdout] ${t.trim()}`); });
  child.stderr.on('data', b => { const t = b.toString(); out += t; connection.console.log(`[DSL stderr] ${t.trim()}`); });

  child.on('exit', () => {
    const diags = parseDiagnostics(file, out);
    connection.sendDiagnostics({ uri, diagnostics: diags });
    dslProcesses.delete(uri);
  });
}
function parseDiagnostics(target: string, o: string): Diagnostic[] {
  const res: Diagnostic[] = [];
  const rx = /^(.+):(\d+):(\d+): (Error|Warning): (.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(o))) {
    if (path.resolve(m[1]) !== path.resolve(target)) continue;
    res.push({
      severity: m[4] === 'Error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      range: {
        start: { line: +m[2] - 1, character: +m[3] - 1 },
        end: { line: +m[2] - 1, character: +m[3] }
      },
      message: m[5].trim(),
      source: 'ParaSail DSL'
    });
  }
  return res;
}

////////////////////////////////////////////////////////////////////////////////
// 6) Interactive DSL (hover)
////////////////////////////////////////////////////////////////////////////////
const interactiveDsl = new Map<string, ChildProcessWithoutNullStreams>();

function spawnInteractive(uri: string, file: string) {
  if (interactiveDsl.has(uri)) return interactiveDsl.get(uri)!;
  const binDir = path.resolve(__dirname, '..', '..', '..', '..', 'parasail_macos_build', 'bin');
  const interp = path.join(binDir, 'interp.csh');
  const scriptsDir = path.resolve(__dirname, '..', 'scripts');
  const lookup = initParams?.initializationOptions?.dslScript || path.join(scriptsDir, 'extension_lookup.psl');

  const child = spawn(interp, [lookup, file], { cwd: path.dirname(file), env: process.env });
  interactiveDsl.set(uri, child);
  readline.createInterface({ input: child.stdout }).on('line', l => connection.console.log(`[iDSL] ${l}`));
  child.stderr.on('data', c => connection.console.log(`[iDSL stderr] ${c.toString().trim()}`));
  child.on('exit', () => interactiveDsl.delete(uri));
  return child;
}
function queryDSL(uri: string, q: string): Promise<string> {
  return new Promise((res, rej) => {
    const p = interactiveDsl.get(uri);
    if (!p) return rej('no interactive process');
    const rl = readline.createInterface({ input: p.stdout });
    const h = (l: string) => { rl.off('line', h); rl.close(); res(l); };
    rl.on('line', h);
    p.stdin.write(q + '\n');
  });
}

connection.onHover(async p => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return null;
  const word = getWord(doc, p.position);
  if (!word) return null;

  const file = uriToFilePath(p.textDocument.uri);
  if (!file) return null;
  spawnInteractive(p.textDocument.uri, file);

  const line = p.position.line + 1;
  const col = p.position.character + 1;
  try {
    const ans = await queryDSL(p.textDocument.uri, `${path.basename(file)}:${line}:${col}`);
    const obj = JSON.parse(ans);
    if (obj.error) return { contents: { kind: 'markdown', value: `**DSL**: ${obj.error}` } };

    let md = `**DSL kind**: \`${obj.kind}\``;
    if (obj.type?.name) md += `\n\n**Type**: \`${obj.type.name}\``;
    if (obj.call?.name) md += `\n\n**Call**: \`${obj.call.name}\``;
    return { contents: { kind: 'markdown', value: md } };
  } catch {
    return null;
  }
});

////////////////////////////////////////////////////////////////////////////////
// 7) Document symbols (simple regex scan)
////////////////////////////////////////////////////////////////////////////////
connection.onDocumentSymbol((p: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  return parseSymbols(doc.getText());
});
function parseSymbols(txt: string): DocumentSymbol[] {
  const res: DocumentSymbol[] = [];
  const lines = txt.split('\n');
  const pat: Array<{ k: SymbolKind; r: RegExp }> = [
    { k: SymbolKind.Function,   r: /^\s*func\s+(\w+)/i },
    { k: SymbolKind.Class,      r: /^\s*class\s+(\w+)/i },
    { k: SymbolKind.Interface,  r: /^\s*interface\s+(\w+)/i },
    { k: SymbolKind.Module,     r: /^\s*module\s+(\w+)/i }
  ];
  lines.forEach((ln, i) => {
    for (const p of pat) {
      const m = ln.match(p.r);
      if (m) {
        const n = m[1];
        res.push({
          name: n,
          kind: p.k,
          range: { start: { line: i, character: 0 }, end: { line: i, character: ln.length } },
          selectionRange: { start: { line: i, character: m.index ?? 0 }, end: { line: i, character: (m.index ?? 0) + n.length } }
        });
      }
    }
  });
  return res;
}

////////////////////////////////////////////////////////////////////////////////
// 8) Place‑holders
////////////////////////////////////////////////////////////////////////////////
connection.onCompletion(() => []);
connection.onCompletionResolve(i => i);
connection.onCodeAction(() => []);
connection.languages.semanticTokens.on(() => ({ data: [] }));
connection.languages.semanticTokens.onRange(() => ({ data: [] }));

////////////////////////////////////////////////////////////////////////////////
// 9) Helpers
////////////////////////////////////////////////////////////////////////////////
function getWord(doc: TextDocument, pos: Position) {
  const ln = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 1_000_000 } });
  let s = pos.character;
  while (s > 0 && /\w/.test(ln[s - 1])) s--;
  let e = pos.character;
  while (e < ln.length && /\w/.test(ln[e])) e++;
  return ln.slice(s, e);
}

////////////////////////////////////////////////////////////////////////////////
// 10) Boot
////////////////////////////////////////////////////////////////////////////////
documents.listen(connection);
connection.listen();
