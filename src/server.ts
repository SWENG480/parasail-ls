/********************************************************************************************
 * Parasail Language Server - Extended Version
 *
 * This file implements a ParaSail language server using a simplified tokenizer, a recursive‑descent
 * parser for top‑level declarations and statements, and LSP features including hover, completions,
 * code actions, renaming, formatting, and semantic tokens.
 *
 * Logging is enabled (via connection.console.log) to show actions (token consumption, parsing, etc.).
 *
 * NOTE: The DSL already handles parsing, keywords, and type detectors. To obtain semantic errors,
 *       we invoke the parasail executable with the following command:
 *
 *         <parasail_executable> <stdLib> <dslScript> <targetFile> -command PSL_Extension_Main <targetFile>
 *
 *       The standard library file (e.g. aaa.psi) is loaded first so that errors are computed with the
 *       proper context. The local parser code is retained only for completions and fallback.
 ********************************************************************************************/

import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  InitializeParams,
  DidChangeConfigurationParams,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Hover,
  DocumentSymbol,
  SymbolKind,
  DocumentSymbolParams,
  FormattingOptions,
  TextEdit,
  Position,
  IPCMessageReader,
  IPCMessageWriter,
  DocumentFormattingParams,
  CodeActionParams,
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
  RenameParams,
  SemanticTokensParams,
  SemanticTokens,
  SemanticTokensLegend,
  SemanticTokensRangeParams
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Maps to store spawned DSL processes.
const dslProcesses: Map<string, ChildProcessWithoutNullStreams> = new Map();
const interactiveDslProcesses: Map<string, ChildProcessWithoutNullStreams> = new Map();

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

const userDictionary: Set<string> = new Set<string>();
const documentSettings: Map<string, Thenable<ParasailSettings>> = new Map();

/* -----------------------------------------------------------------------------
 * Standard constants for fallback tokenization and completions.
 * (These are now superseded by the DSL’s own keyword and type detection,
 * but remain available for fallback.)
 * -----------------------------------------------------------------------------
 */
const PARASAIL_KEYWORDS: { [key: string]: string } = {
  "func": "Defines a function: `func name(params) -> return_type is ... end func name`",
  "type": "Defines a type: `type Name is ... end type Name`",
  "interface": "Declares a parameterized interface: `interface Name<> is ... end interface Name`",
  "class": "Defines a class: `class Name is ... end class Name`",
  "op": "Operator overload: `op \"=\"(Left: T, Right: T) -> Boolean is ... end op`",
  "const": "Constant declaration: `const Name: Type := Value;`",
  "var": "Variable declaration: `var Name: Type := Value;`",
  "abstract": "Abstract operation in interfaces: `abstract func Name(...)`",
  "extends": "Inheritance for interfaces: `interface Name<> extends Parent<> is ... end interface Name`",
  "exports": "Visibility control in classes: `exports {Name1, Name2}`",
  "import": "Dependency: `import Package::Module`",
  "all": "Wildcard import: `import Package::Module::all`",
  "new": "Constructor: `var Obj := new Class(...)`",
  "not": "Logical negation: `not Condition`",
  "and": "Logical AND: `Condition1 and Condition2`",
  "or": "Logical OR: `Condition1 or Condition2`",
  "xor": "Logical XOR: `Condition1 xor Condition2`",
  "in": "Membership test: `Element in Collection`",
  "case": "Case statement: `case Expression of ... end case`",
  "loop": "Loop construct: `loop ... end loop`",
  "for": "For iteration: `for Elem in Collection loop ... end loop`",
  "while": "While loop: `while Condition loop ... end loop`",
  "if": "If statement: `if Condition then ... else ... end if`",
  "then": "Used in if statements: `if Condition then ...`",
  "else": "Else branch: `else ... end if`",
  "elsif": "Else-if branch: `elsif Condition then ...`",
  "end": "Block termination (for if, func, etc.)",
  "is": "Declaration separator",
  "parallel": "Parallel block: `parallel ... end parallel`",
  "forward": "Indicates a forward loop or declaration",
  "optional": "Nullable type: `optional T`",
  "null": "Empty reference (e.g. `return null`)",
  "block": "Block statement: `block ... end block`",
  "module": "Module declaration: `module Name is ... end module Name`",
  "exit": "Exit statement: `exit loop`",
  "with": "Used in code blocks, e.g. `end loop with X => ...`",
  "continue": "Continue statement: `continue loop`"
};

const RESERVED_WORDS: string[] = [
  "abs", "abstract", "all", "and", "block", "case", "class", "concurrent",
  "const", "continue", "each", "else", "elsif", "end", "exit", "extends",
  "exports", "for", "forward", "func", "global", "if", "implements", "import",
  "in", "interface", "is", "lambda", "locked", "loop", "mod", "new", "not", "null",
  "of", "op", "optional", "or", "private", "queued", "ref", "rem", "return", "reverse",
  "separate", "some", "then", "type", "until", "var", "while", "with", "xor"
];
RESERVED_WORDS.forEach((word: string) => {
  if (!PARASAIL_KEYWORDS[word]) {
    PARASAIL_KEYWORDS[word] = `Reserved word: \`${word}\``;
  }
});

const STANDARD_LIBRARY: { [key: string]: string } = {
  "IO::Print": "Output to console: Print(\"Message\")",
  "Math::Sin": "Sine function: Sin(Radians: Float) -> Float",
  "Containers::Vector": "Resizable array: Vector<Element_Type>",
  "String::Concat": "Concatenate strings: Concat(Left, Right) -> String",
  "File::Open": "Open file: Open(Path: String) -> File_Handle",
  "DateTime::Now": "Current timestamp: Now() -> DateTime",
  "Network::HttpRequest": "HTTP client: HttpRequest(Url: String) -> Response",
  "Crypto::SHA256": "Hash data: SHA256(Data: String) -> Hash"
};

const CODE_TEMPLATES = [
  {
    trigger: /^\s*fun/i,
    snippet: 'func ${1:name}($2) -> ${3:ReturnType} is\n\t${4:-- Implementation}\nend func ${1:name}',
    docs: "Function declaration template"
  },
  {
    trigger: /^\s*typ/i,
    snippet: 'type ${1:TypeName} is\n\t${2:-- Definition}\nend type ${1:TypeName}',
    docs: "Type declaration template"
  },
  {
    trigger: /^\s*int/i,
    snippet: 'interface ${1:InterfaceName}<> is\n\t${2:-- Operations}\nend interface ${1:InterfaceName}',
    docs: "Interface declaration template"
  },
  {
    trigger: /^\s*cla/i,
    snippet: 'class ${1:ClassName} {\n\t${2:-- Fields}\n\n\tfunc ${3:New}($4) -> ${5:ClassName} is\n\t\t${6:-- Constructor}\n\tend func\n}\n',
    docs: "Class declaration template"
  },
  {
    trigger: /^\s*for/i,
    snippet: 'for ${1:element} in ${2:collection} loop\n\t${3:-- Loop body}\nend loop',
    docs: "For-each loop template"
  },
  {
    trigger: /^\s*if/i,
    snippet: 'if ${1:condition} then\n\t${2:-- True branch}\nelsif ${3:condition} then\n\t${4:-- Elseif branch}\nelse\n\t${5:-- False branch}\nend if',
    docs: "If-elsif-else statement template"
  }
];

/* -----------------------------------------------------------------------------
 * Tokenizer (Retained for fallback/completions)
 * -----------------------------------------------------------------------------
 */
interface Token {
  type: string;
  value: string;
  line: number;
  character: number;
}

function tokenizeParasail(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');
  const patterns: { type: string; regex: RegExp }[] = [
    { type: 'whitespace', regex: /^[\s]+/ },
    { type: 'comment', regex: /^\/\/.*/ },
    { type: 'string', regex: /^"([^"\\]|\\.)*"/ },
    { type: 'char', regex: /^'([^'\\]|\\.)'/ },
    { type: 'number', regex: /^\d+(\.\d+)?/ },
    { type: 'identifier', regex: /^[A-Za-z_][A-Za-z0-9_]*/ },
    {
      type: 'operator',
      regex: new RegExp(
        '^(::|==|!=|<=|>=|=>|<<|>>|:=|<==|<=>|' +
        '\\+=|-=|\\*=|\\/=|\\*\\*=|' +
        'and then|or else|==>|' +
        '\\.\\.|\\.\\.<|<\\.\\.|<\\.\\.<|' +
        '[\\[\\]\\.,:;(){}+\\-*/<>|&^!~])'
      )
    }
  ];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const lineText = lines[lineNum];
    let pos = 0;
    while (pos < lineText.length) {
      let matched = false;
      for (const pattern of patterns) {
        const result = pattern.regex.exec(lineText.substring(pos));
        if (result && result.index === 0) {
          if (pattern.type !== 'whitespace' && pattern.type !== 'comment') {
            tokens.push({ type: pattern.type, value: result[0], line: lineNum, character: pos });
          }
          pos += result[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        tokens.push({ type: 'unknown', value: lineText[pos], line: lineNum, character: pos });
        pos++;
      }
    }
  }
  connection.console.log(`Tokenization complete. Total tokens: ${tokens.length}`);
  return tokens;
}

/* -----------------------------------------------------------------------------
 * Dummy Parser (Retained for fallback/completions)
 * -----------------------------------------------------------------------------
 */
interface ASTNode {
  type: string;
  name?: string;
  children: ASTNode[];
  start: Position;
  end: Position;
}

class Parser {
  tokens: Token[];
  pos: number;
  errors: Diagnostic[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
    this.errors = [];
    connection.console.log("Parser initialized.");
  }

  parseProgram(): ASTNode {
    return { type: "Program", children: [], start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  }
}

function parseFullDocument(text: string): { ast: ASTNode | null; errors: Diagnostic[] } {
  const tokens = tokenizeParasail(text);
  const parser = new Parser(tokens);
  const ast = parser.parseProgram();
  connection.console.log("Full document parsing complete.");
  return { ast, errors: parser.errors };
}

/* -----------------------------------------------------------------------------
 * Helper: Convert Index to Position
 * -----------------------------------------------------------------------------
 */
function positionFromIndex(text: string, idx: number): { line: number; character: number } {
  const lines = text.slice(0, idx).split('\n');
  const line = lines.length - 1;
  const character = lines[line].length;
  return { line, character };
}

/* -----------------------------------------------------------------------------
 * LSP Lifecycle & Configuration
 * -----------------------------------------------------------------------------
 */
let initParams: InitializeParams;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('Initializing Parasail LSP...');
  initParams = params;
  if (params.initializationOptions) {
    if (params.initializationOptions.standardLibraryPath) {
      connection.console.log(`Standard library path: ${params.initializationOptions.standardLibraryPath}`);
    }
    if (params.initializationOptions.dslScript) {
      connection.console.log(`DSL script path: ${params.initializationOptions.dslScript}`);
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.', ':', '<', '"', '/', ' ']
      },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['('], retriggerCharacters: [','] },
      definitionProvider: true,
      documentFormattingProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      workspaceSymbolProvider: true,
      codeActionProvider: { resolveProvider: true },
      renameProvider: { prepareProvider: true },
      semanticTokensProvider: {
        legend: { tokenTypes: ["keyword", "number", "string", "class"], tokenModifiers: [] },
        full: true,
        range: true
      }
    }
  };
});

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  globalSettings = change.settings.parasailServer || globalSettings;
  connection.console.log("Configuration changed.");
  documents.all().forEach(validateDocument);
});

// Validate only on document save.
documents.onDidSave(change => {
  connection.console.log(`Document saved: ${change.document.uri}`);
  validateDocument(change.document);
});

documents.onDidClose(e => {
  connection.console.log(`Document closed: ${e.document.uri}`);
  documentSettings.delete(e.document.uri);
  const docUri = e.document.uri;
  if (dslProcesses.has(docUri)) {
    const proc = dslProcesses.get(docUri);
    if (proc) {
      connection.console.log(`Killing DSL process for doc: ${docUri}`);
      proc.kill();
    }
    dslProcesses.delete(docUri);
  }
  if (interactiveDslProcesses.has(docUri)) {
    const proc = interactiveDslProcesses.get(docUri);
    if (proc) {
      connection.console.log(`Killing interactive DSL process for doc: ${docUri}`);
      proc.kill();
    }
    interactiveDslProcesses.delete(docUri);
  }
});

/* -----------------------------------------------------------------------------
 * Validation via DSL
 * -----------------------------------------------------------------------------
 * Spawns the parasail executable with the standard library and DSL script so that the DSL
 * (extension_lookup.psl) handles keywords, type detection, and semantic analysis.
 *
 * Command format:
 *   <parasail_executable> <stdLib> <dslScript> <targetFile> -command PSL_Extension_Main <targetFile>
 */
async function validateDocument(document: TextDocument): Promise<void> {
  const docUri = document.uri;
  const docPath = uriToFilePath(docUri);
  if (!docPath) return;

  const parasailCmd = process.env.PARASAIL_CMD || "/Users/aisenlopezramos/parasail_macos_build/build/bin/parasail_main";
  const dslScript = initParams.initializationOptions && initParams.initializationOptions.dslScript
    ? initParams.initializationOptions.dslScript
    : undefined;
  const stdLib = initParams.initializationOptions && initParams.initializationOptions.standardLibraryPath
    ? initParams.initializationOptions.standardLibraryPath
    : undefined;

  if (!dslScript) {
    connection.console.log("No DSL script provided, skipping validation.");
    return;
  }

  let args: string[];
  if (stdLib) {
    args = [stdLib, dslScript, docPath, "-command", "PSL_Extension_Main", docPath];
  } else {
    args = [dslScript, docPath, "-command", "PSL_Extension_Main", docPath];
  }

  connection.console.log(`Spawning DSL for semantic analysis: ${parasailCmd} ${args.join(" ")}`);

  try {
    const child = spawn(parasailCmd, args, { cwd: path.dirname(docPath), env: process.env });
    dslProcesses.set(docUri, child);

    let dslOutput = "";
    child.stdout.on('data', (chunk: Buffer) => {
      dslOutput += chunk.toString();
      connection.console.log(`DSL stdout: ${chunk.toString()}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      connection.console.log(`DSL stderr: ${chunk.toString()}`);
      dslOutput += chunk.toString();
    });
    child.on('exit', (code) => {
      connection.console.log(`DSL process exited with code ${code}`);
      connection.console.log("Complete DSL output:\n" + dslOutput);
      const diagnostics: Diagnostic[] = parseDSLDiagnostics(docPath, dslOutput);
      connection.sendDiagnostics({ uri: docUri, diagnostics });
      connection.console.log(`DSL diagnostics sent for document: ${docUri}`);
    });
  } catch (err) {
    connection.console.error(`Error spawning DSL: ${err}`);
  }
}

/**
 * Parses DSL output lines in the format:
 *   <file>:<line>:<col>: Error|Warning: <message>
 * and returns an array of Diagnostics.
 */
function parseDSLDiagnostics(targetFile: string, output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const regex = /^(.+):(\d+):(\d+): (Error|Warning): (.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const fileFromOutput = match[1];
    if (path.resolve(fileFromOutput) !== path.resolve(targetFile)) continue;
    const lineNum = parseInt(match[2], 10) - 1;
    const colNum = parseInt(match[3], 10) - 1;
    const severity = match[4] === "Error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
    const message = match[5].trim();
    diagnostics.push({
      severity,
      range: { start: { line: lineNum, character: colNum }, end: { line: lineNum, character: colNum + 1 } },
      message,
      source: "ParaSail DSL"
    });
  }
  return diagnostics;
}

/* -----------------------------------------------------------------------------
 * Interactive DSL Integration (for hover queries)
 * -----------------------------------------------------------------------------
 * Spawns an interactive DSL process so that hover queries can be answered.
 */
function spawnInteractiveDSLForDocument(docUri: string, filePath: string): ChildProcessWithoutNullStreams | null {
  if (interactiveDslProcesses.has(docUri)) {
    connection.console.log(`Interactive DSL already running for doc: ${docUri}`);
    return interactiveDslProcesses.get(docUri)!;
  }
  const parasailCmd = process.env.PARASAIL_CMD || "/Users/aisenlopezramos/parasail_macos_build/build/bin/parasail_main";
  const dslScript = initParams.initializationOptions && initParams.initializationOptions.dslScript
    ? initParams.initializationOptions.dslScript
    : undefined;
  if (!dslScript) {
    connection.console.log("No DSL script provided, cannot spawn interactive DSL.");
    return null;
  }
  // For interactive queries, we call the DSL script with the target file only.
  const args = [dslScript, filePath];
  connection.console.log(`Spawning interactive DSL: ${parasailCmd} ${args.join(" ")}`);
  try {
    const child = spawn(parasailCmd, args, { cwd: path.dirname(filePath), env: process.env });
    interactiveDslProcesses.set(docUri, child);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      connection.console.log(`Interactive DSL stdout for doc ${docUri}: ${line}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      connection.console.log(`Interactive DSL stderr for doc ${docUri}: ${chunk.toString()}`);
    });
    child.on('exit', (code) => {
      connection.console.log(`Interactive DSL for doc ${docUri} exited with code ${code}`);
      interactiveDslProcesses.delete(docUri);
    });
    return child;
  } catch (err) {
    connection.console.error(`Failed to spawn interactive DSL: ${err}`);
    return null;
  }
}

function queryDSLPosition(docUri: string, positionStr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = interactiveDslProcesses.get(docUri);
    if (!proc) {
      reject(new Error("No interactive DSL process running for doc " + docUri));
      return;
    }
    let stdoutLine = "";
    const rl = readline.createInterface({ input: proc.stdout });
    const onLine = (line: string) => {
      stdoutLine = line;
      rl.removeListener('line', onLine);
      rl.close();
      resolve(stdoutLine);
    };
    rl.on('line', onLine);
    proc.stdin.write(positionStr + "\n");
  });
}

/* -----------------------------------------------------------------------------
 * Hover Provider
 * -----------------------------------------------------------------------------
 */
connection.onHover(async (params: TextDocumentPositionParams): Promise<Hover | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;

  // 1) Check built-in keyword info.
  const keywordDoc = PARASAIL_KEYWORDS[word.toLowerCase()];
  if (keywordDoc) {
    connection.console.log(`Hover: showing keyword info for ${word}`);
    return { contents: { kind: "markdown", value: keywordDoc } };
  }

  // 2) Check local symbols (fallback).
  const symbols = parseDocumentSymbolsForHover(doc);
  const symbol = symbols.get(word);
  if (symbol) {
    let hoverContent = `**${symbol.kind.toUpperCase()}**: \`${symbol.name}\`\n\n`;
    if (symbol.kind === 'var' || symbol.kind === 'const') {
      if (symbol.type) { hoverContent += `**Type:** \`${symbol.type}\`\n\n`; }
      if (symbol.value) { hoverContent += `**Value:** \`${symbol.value}\`\n\n`; }
    }
    if (symbol.kind === 'func') {
      hoverContent += `**Parameters:** \`${symbol.params}\`\n\n`;
      if (symbol.returnType) { hoverContent += `**Returns:** \`${symbol.returnType}\`\n\n`; }
    }
    hoverContent += `**Definition:**\n\`\`\`parasail\n${symbol.line}\n\`\`\``;
    connection.console.log(`Hover: showing local symbol info for ${word}`);
    return { contents: { kind: "markdown", value: hoverContent } };
  }

  // 3) Fallback: query the interactive DSL.
  const docUriLocal = params.textDocument.uri;
  const filePath = uriToFilePath(docUriLocal);
  if (!filePath) return null;
  const interactiveProc = spawnInteractiveDSLForDocument(docUriLocal, filePath);
  if (!interactiveProc) return null;
  const lineOneBased = params.position.line + 1;
  const charOneBased = params.position.character + 1;
  const queryStr = `${path.basename(filePath)}:${lineOneBased}:${charOneBased}`;
  connection.console.log(`Hover: querying interactive DSL for position ${queryStr}`);
  try {
    const dslJsonLine = await queryDSLPosition(docUriLocal, queryStr);
    let dslObj: any;
    try {
      dslObj = JSON.parse(dslJsonLine);
    } catch (parseErr) {
      connection.console.log(`Interactive DSL returned non-JSON or parse error: ${dslJsonLine}`);
      return null;
    }
    if (dslObj.error) {
      return { contents: { kind: "markdown", value: `**DSL**: ${dslObj.error}` } };
    }
    let hoverVal = `**DSL kind**: \`${dslObj.kind}\``;
    if (dslObj.type && dslObj.type.name) {
      hoverVal += `\n\n**DSL type**: \`${dslObj.type.name}\``;
      if (dslObj.type.src) { hoverVal += `\n\n**Type definition at**: \`${dslObj.type.src}\``; }
    }
    connection.console.log(`Hover: showing interactive DSL info for ${word}`);
    return { contents: { kind: "markdown", value: hoverVal } };
  } catch (err) {
    connection.console.warn(`Interactive DSL query failed: ${err}`);
    return null;
  }
});

/* -----------------------------------------------------------------------------
 * Document Symbols (Regex-based for Hover)
 * -----------------------------------------------------------------------------
 */
interface ParasailSymbol {
  kind: string;
  name: string;
  line: string;
  type?: string;
  value?: string;
  params?: string;
  returnType?: string;
}

function parseDocumentSymbolsForHover(doc: TextDocument): Map<string, ParasailSymbol> {
  const text = doc.getText();
  const lines = text.split('\n');
  const patterns: Array<{ kind: string; regex: RegExp; extractor: (m: RegExpMatchArray) => Partial<ParasailSymbol> }> = [
    {
      kind: 'var',
      regex: /^\s*var\s+(\w+)\s*(?::\s*([\w<>]+))?\s*(?::=\s*(.+))?;/i,
      extractor: (m) => ({ name: m[1], type: m[2]?.trim(), value: m[3]?.trim() })
    },
    {
      kind: 'const',
      regex: /^\s*const\s+(\w+)\s*(?::\s*([\w<>]+))?\s*(?::=\s*(.+))?;/i,
      extractor: (m) => ({ name: m[1], type: m[2]?.trim(), value: m[3]?.trim() })
    },
    {
      kind: 'func',
      regex: /^\s*func\s+(\w+)\s*\((.*?)\)\s*->\s*([\w<>]+)\s*(is)?/i,
      extractor: (m) => ({ name: m[1], params: m[2].trim(), returnType: m[3].trim() })
    },
    {
      kind: 'type',
      regex: /^\s*type\s+(\w+)\s+is\b/i,
      extractor: (m) => ({ name: m[1] })
    },
    {
      kind: 'interface',
      regex: /^\s*interface\s+(\w+)/i,
      extractor: (m) => ({ name: m[1] })
    },
    {
      kind: 'class',
      regex: /^\s*class\s+(\w+)/i,
      extractor: (m) => ({ name: m[1] })
    },
    {
      kind: 'module',
      regex: /^\s*module\s+(\w+)/i,
      extractor: (m) => ({ name: m[1] })
    },
    {
      kind: 'op',
      regex: /^\s*op\s+"([^"]+)"\s*\((.*?)\)/i,
      extractor: (m) => ({ name: m[1] })
    }
  ];

  const map = new Map<string, ParasailSymbol>();
  lines.forEach((line) => {
    for (const p of patterns) {
      const match = line.match(p.regex);
      if (match) {
        const info = p.extractor(match);
        if (info.name) {
          map.set(info.name, {
            kind: p.kind,
            name: info.name,
            line: line.trim(),
            type: info.type,
            value: info.value,
            params: info.params,
            returnType: info.returnType
          });
        }
      }
    }
  });
  return map;
}

/* -----------------------------------------------------------------------------
 * Completion Provider & Helpers
 * -----------------------------------------------------------------------------
 */
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const prefix = getCurrentWordPrefix(doc, params.position);
  connection.console.log(`Completion requested with prefix: ${prefix}`);
  const completions: CompletionItem[] = [
    ...getKeywordCompletions(prefix),
    ...getLibraryCompletions(prefix),
    ...getTemplateCompletions(doc, params.position),
    ...getImportCompletions(doc.getText())
  ];
  return completions;
});

connection.onCompletionResolve(item => {
  if (PARASAIL_KEYWORDS[item.label]) {
    item.documentation = PARASAIL_KEYWORDS[item.label];
  }
  return item;
});

function getKeywordCompletions(prefix: string): CompletionItem[] {
  return Object.keys(PARASAIL_KEYWORDS)
    .filter(k => k.toLowerCase().startsWith(prefix.toLowerCase()))
    .map(k => ({
      label: k,
      kind: CompletionItemKind.Keyword,
      documentation: PARASAIL_KEYWORDS[k]
    }));
}

function getLibraryCompletions(prefix: string): CompletionItem[] {
  return Object.keys(STANDARD_LIBRARY)
    .filter(k => k.toLowerCase().includes(prefix.toLowerCase()))
    .map(k => ({
      label: k,
      kind: CompletionItemKind.Module,
      documentation: STANDARD_LIBRARY[k],
      detail: 'Standard Library'
    }));
}

function getTemplateCompletions(doc: TextDocument, pos: Position): CompletionItem[] {
  const line = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } })
    .split('\n')[0];
  return CODE_TEMPLATES
    .filter(t => t.trigger.test(line))
    .map(t => ({
      label: t.snippet.split(' ')[1],
      kind: CompletionItemKind.Snippet,
      documentation: t.docs,
      insertText: t.snippet,
      insertTextFormat: 2
    }));
}

function getImportCompletions(text: string): CompletionItem[] {
  const importPattern = /import\s+([\w:]+)/g;
  const imports = new Set<string>();
  let match;
  while ((match = importPattern.exec(text))) {
    imports.add(match[1]);
  }
  return Array.from(imports).map(i => ({
    label: i.split('::').pop()!,
    kind: CompletionItemKind.Reference,
    detail: `Import from ${i}`,
    documentation: `Resolved import: ${i}`
  }));
}

/* -----------------------------------------------------------------------------
 * Code Actions
 * -----------------------------------------------------------------------------
 */
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  connection.console.log("Code action requested.");
  const actions: CodeAction[] = [];

  for (const diag of params.context.diagnostics) {
    if (diag.code === 'SpellingError' || diag.code === 'UnknownToken') {
      const text = doc.getText(diag.range);
      const title = `Add "${text}" to dictionary`;
      const fix = CodeAction.create(
        title,
        { changes: { [doc.uri]: [{ range: diag.range, newText: text }] } },
        CodeActionKind.QuickFix
      );
      fix.diagnostics = [diag];
      fix.command = { title, command: 'parasail.addToDictionary', arguments: [text] };
      actions.push(fix);
    } else if (diag.code === 'MissingEndFunc' || diag.code === 'MissingEnd') {
      const fix: CodeAction = {
        title: `Insert missing end marker`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: { changes: { [doc.uri]: [{
          range: { start: { line: diag.range.start.line + 1, character: 0 }, end: { line: diag.range.start.line + 1, character: 0 } },
          newText: "end\n"
        }] } }
      };
      actions.push(fix);
    } else {
      const fix: CodeAction = {
        title: `Default fix`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: { changes: { [doc.uri]: [] } }
      };
      actions.push(fix);
    }
  }
  connection.console.log(`Code actions provided: ${actions.length}`);
  return actions;
});

connection.onCodeActionResolve((action: CodeAction): CodeAction => action);

connection.onRequest('parasail.addToDictionary', (word: string) => {
  userDictionary.add(word);
  connection.console.log(`Command executed: Added "${word}" to user dictionary.`);
});

/* -----------------------------------------------------------------------------
 * Document Formatting
 * -----------------------------------------------------------------------------
 */
connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !globalSettings.enableFormatting) return [];
  connection.console.log(`Formatting document: ${doc.uri}`);
  return formatDocument(doc.getText(), params.options);
});

function formatDocument(content: string, options: FormattingOptions): TextEdit[] {
  const lines = content.split('\n');
  const edits: TextEdit[] = [];
  lines.forEach((line, index) => {
    const indentation = line.match(/^\s*/)?.[0] || '';
    const expected = ' '.repeat(options.tabSize * Math.floor(indentation.length / options.tabSize));
    if (indentation !== expected) {
      edits.push(TextEdit.replace(
        { start: { line: index, character: 0 }, end: { line: index, character: indentation.length } },
        expected
      ));
    }
  });
  return edits;
}

/* -----------------------------------------------------------------------------
 * Document Symbols
 * -----------------------------------------------------------------------------
 */
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  connection.console.log(`Document symbols requested for: ${doc.uri}`);
  return findDocumentSymbols(doc.getText());
});

function findDocumentSymbols(content: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const symbolPatterns: { [key: string]: RegExp } = {
    func: /func\s+(\w+)/i,
    type: /type\s+(\w+)/i,
    interface: /interface\s+(\w+)/i,
    class: /class\s+(\w+)/i,
    module: /module\s+(\w+)/i
  };
  const lines = content.split('\n');
  lines.forEach((line, lineNum) => {
    for (const pattern of Object.values(symbolPatterns)) {
      const match = line.match(pattern);
      if (match) {
        symbols.push({
          name: match[1],
          kind: SymbolKind.Function,
          range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: line.length } },
          selectionRange: { start: { line: lineNum, character: match.index || 0 }, end: { line: lineNum, character: (match.index || 0) + match[1].length } }
        });
      }
    }
  });
  return symbols;
}

/* -----------------------------------------------------------------------------
 * Definition / References / Rename
 * -----------------------------------------------------------------------------
 */
connection.onDefinition((params) => {
  connection.console.log("Definition request received.");
  return [];
});
connection.onReferences((params) => {
  connection.console.log("References request received.");
  return [];
});
connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;
  const range = {
    start: params.position,
    end: { line: params.position.line, character: params.position.character + word.length }
  };
  connection.console.log(`Prepare rename for word: ${word}`);
  return { range, placeholder: word };
});
connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const oldName = getWordAtPosition(doc, params.position);
  if (!oldName) return null;
  const newName = params.newName;
  const text = doc.getText();
  const edits: TextEdit[] = [];
  let idx = text.indexOf(oldName);
  while (idx !== -1) {
    const pos = positionFromIndex(text, idx);
    edits.push({ range: { start: pos, end: { line: pos.line, character: pos.character + oldName.length } }, newText: newName });
    idx = text.indexOf(oldName, idx + oldName.length);
  }
  connection.console.log(`Rename: Replacing "${oldName}" with "${newName}"`);
  return { changes: { [doc.uri]: edits } };
});

/* -----------------------------------------------------------------------------
 * Semantic Tokens
 * -----------------------------------------------------------------------------
 */
connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const text = doc.getText();
  const lines = text.split('\n');
  const tokens: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  const tokenTypes: string[] = ["keyword", "number", "string", "class"];
  const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
    { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|elsif|end|is|parallel|forward|optional|null|block|module|exit|with|continue)\b/g, tokenType: "keyword" },
    { regex: /\b\d+(\.\d+)?\b/g, tokenType: "number" },
    { regex: /"([^"\\]|\\.)*"/g, tokenType: "string" },
    { regex: /\b[A-Z][A-Za-z0-9_]*\b/g, tokenType: "class" }
  ];
  const tokenTypeMap: { [key: string]: number } = {};
  tokenTypes.forEach((t, index) => { tokenTypeMap[t] = index; });
  for (let line = 0; line < lines.length; line++) {
    const lineText = lines[line];
    for (const { regex, tokenType } of tokenPatterns) {
      let match;
      while ((match = regex.exec(lineText)) !== null) {
        const startChar = match.index;
        const length = match[0].length;
        const deltaLine = line - prevLine;
        const deltaStart = (deltaLine === 0) ? startChar - prevChar : startChar;
        tokens.push(deltaLine, deltaStart, length, tokenTypeMap[tokenType], 0);
        prevLine = line;
        prevChar = startChar;
      }
    }
  }
  connection.console.log("Semantic tokens computed (full).");
  return { data: tokens };
});

connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const text = doc.getText();
  const lines = text.split('\n');
  const tokens: number[] = [];
  let prevLine = params.range.start.line;
  let prevChar = params.range.start.character;
  const tokenTypes: string[] = ["keyword", "number", "string", "class"];
  const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
    { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|elsif|end|is|parallel|forward|optional|null|block|module|exit|with|continue)\b/g, tokenType: "keyword" },
    { regex: /\b\d+(\.\d+)?\b/g, tokenType: "number" },
    { regex: /"([^"\\]|\\.)*"/g, tokenType: "string" },
    { regex: /\b[A-Z][A-Za-z0-9_]*\b/g, tokenType: "class" }
  ];
  const tokenTypeMap: { [key: string]: number } = {};
  tokenTypes.forEach((t, index) => { tokenTypeMap[t] = index; });
  for (let line = params.range.start.line; line <= params.range.end.line && line < lines.length; line++) {
    const lineText = lines[line];
    for (const { regex, tokenType } of tokenPatterns) {
      let match;
      while ((match = regex.exec(lineText)) !== null) {
        const startChar = match.index;
        const length = match[0].length;
        if (line === params.range.start.line && startChar < params.range.start.character) continue;
        if (line === params.range.end.line && (startChar + length) > params.range.end.character) continue;
        const deltaLine = line - prevLine;
        const deltaStart = (deltaLine === 0) ? startChar - prevChar : startChar;
        tokens.push(deltaLine, deltaStart, length, tokenTypeMap[tokenType], 0);
        prevLine = line;
        prevChar = startChar;
      }
    }
  }
  connection.console.log("Semantic tokens computed (range).");
  return { data: tokens };
});

/* -----------------------------------------------------------------------------
 * Final Helper Functions for Hover & Completion
 * -----------------------------------------------------------------------------
 */
function getWordAtPosition(doc: TextDocument, pos: Position): string | undefined {
  const lineText = doc.getText({
    start: { line: pos.line, character: 0 },
    end: { line: pos.line, character: Number.MAX_SAFE_INTEGER }
  });
  let start = pos.character;
  while (start > 0 && /[\w$]/.test(lineText[start - 1])) start--;
  let end = pos.character;
  while (end < lineText.length && /[\w$]/.test(lineText[end])) end++;
  return lineText.slice(start, end);
}

function getCurrentWordPrefix(doc: TextDocument, pos: Position): string {
  const lineText = doc.getText({ start: { line: pos.line, character: 0 }, end: pos });
  const words = lineText.split(/[^\w$]/);
  return words[words.length - 1] || "";
}

/** Convert a URI (e.g. "file:///home/user/file.psl") to a local file path. */
function uriToFilePath(docUri: string): string | undefined {
  if (docUri.startsWith("file://")) {
    return docUri.replace("file://", "");
  }
  return undefined;
}

/* -----------------------------------------------------------------------------
 * LSP Lifecycle: Start Listening
 * -----------------------------------------------------------------------------
 */
documents.listen(connection);
connection.listen();
// commit
