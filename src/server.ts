import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationParams,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Hover,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  DocumentSymbol,
  SymbolKind,
  DocumentSymbolParams,
  FormattingOptions,
  TextEdit,
  Position,
  IPCMessageReader,
  IPCMessageWriter,
  DocumentFormattingParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

interface ParasailSettings {
  maxNumberOfProblems: number;
  enableFormatting: boolean;
  libraryPaths: string[];
  implicitImports: boolean;
}

const PARASAIL_KEYWORDS: { [key: string]: string } = {
  "func": "Defines a function: `func name(params) -> return_type is ... end func name`",
  "type": "Defines a type: `type Name is ...`",
  "interface": "Declares a parameterized interface: `interface Name<> is ... end interface Name`",
  "class": "Defines a class: `class Name is ... end class Name`",
  "op": "Operator overload: `operator \"=\"(Left: Type, Right: Type) -> Boolean is ...`",
  "const": "Constant declaration: `const Name: Type := Value`",
  "var": "Variable declaration: `var Name: Type := Value`",
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
  "case": "Pattern matching: `case Expression of ... end case`",
  "loop": "Loop construct: `loop ... end loop`",
  "for": "Iteration: `for Elem in Collection loop ... end loop`",
  "while": "Conditional loop: `while Condition loop ... end loop`",
  "if": "Conditional: `if Condition then ... else ... end if`",
  "then": "Conditional clause",
  "else": "Alternative branch",
  "end": "Block termination",
  "is": "Declaration separator",
  "parallel": "Parallel block: `parallel ... end parallel`",
  "forward": "Sequential loop: `for ... forward loop ... end loop`",
  "optional": "Nullable type: `optional Type`",
  "null": "Empty reference"
};

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
      snippet: 'type ${1:TypeName} is\n\t${2:-- Definition}\nend type',
      docs: "Type declaration template"
  },
  {
      trigger: /^\s*int/i,
      snippet: 'interface ${1:InterfaceName}<> is\n\t${2:-- Operations}\nend interface ${1:InterfaceName}',
      docs: "Interface declaration template"
  },
  {
      trigger: /^\s*cla/i,
      snippet: 'class ${1:ClassName} {\n\t${2:-- Fields}\n\n\tfunc ${3:New}($4) -> ${5:ClassName} is\n\t\t${6:-- Constructor}\n\tend func\n}',
      docs: "Class declaration template"
  },
  {
      trigger: /^\s*for/i,
      snippet: 'for ${1:element} in ${2:collection} loop\n\t${3:-- Loop body}\nend loop',
      docs: "For-each loop template"
  },
  {
      trigger: /^\s*if/i,
      snippet: 'if ${1:condition} then\n\t${2:-- True branch}\nelse\n\t${3:-- False branch}\nend if',
      docs: "If-else statement template"
  }
];

let globalSettings: ParasailSettings = {
  maxNumberOfProblems: 1000,
  enableFormatting: true,
  libraryPaths: [],
  implicitImports: true
};

const documentSettings: Map<string, Thenable<ParasailSettings>> = new Map();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  console.log('[Parasail] Language server initialized');
  return {
      capabilities: {
          textDocumentSync: TextDocumentSyncKind.Incremental,
          completionProvider: { 
              resolveProvider: true,
              triggerCharacters: ['.', ':', '<', '"', '/']
          },
          hoverProvider: true,
          signatureHelpProvider: {
              triggerCharacters: ['('],
              retriggerCharacters: [',']
          },
          definitionProvider: true,
          documentFormattingProvider: true,
          documentSymbolProvider: true,
          referencesProvider: true,
          workspaceSymbolProvider: true
      }
  };
});

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  globalSettings = change.settings.parasailServer || globalSettings;
  documents.all().forEach(validateDocument);
});

documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(e => documentSettings.delete(e.document.uri));

async function validateDocument(document: TextDocument): Promise<void> {
  const diagnostics: Diagnostic[] = [];
  const tempFile = createTempFile(document.getText());
  
  try {
      const parser = cp.spawn('interp.csh', [tempFile]);
      let errorOutput = '';
      
      parser.stderr.on('data', (data) => {
          errorOutput += data.toString();
      });

      parser.on('close', () => {
          processDiagnostics(errorOutput, document.uri, diagnostics);
          connection.sendDiagnostics({ uri: document.uri, diagnostics });
          fs.unlinkSync(tempFile);
      });

  } catch (error) {
      connection.console.error(`Validation error: ${error}`);
  }
}

function processDiagnostics(output: string, uri: string, diagnostics: Diagnostic[]) {
  const regex = /(\d+):(\d+):\s+(Error|Warning|Info):\s+(.*)/;
  output.split('\n').forEach(line => {
      const match = line.match(regex);
      if (match) {
          const lineNum = parseInt(match[1]) - 1;
          const charNum = parseInt(match[2]) - 1;
          diagnostics.push({
              severity: match[3] === 'Error' ? DiagnosticSeverity.Error :
                        match[3] === 'Warning' ? DiagnosticSeverity.Warning :
                        DiagnosticSeverity.Information,
              range: {
                  start: { line: lineNum, character: charNum },
                  end: { line: lineNum, character: charNum + 1 }
              },
              message: match[4],
              source: 'parasail'
          });
      }
  });
}

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
      console.log('[Parasail] No document found for hover');
      return null;
  }
  
  const word = getWordAtPosition(doc, params.position)?.toLowerCase();
  console.log(`[Parasail] Hover word: ${word}`);

  if (word && PARASAIL_KEYWORDS[word]) {
      console.log(`[Parasail] Found hover documentation for: ${word}`);
      return {
          contents: {
              kind: "markdown",
              value: PARASAIL_KEYWORDS[word]
          }
      };
  }
  return null;
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
      console.log('[Parasail] No document found for completion');
      return [];
  }
  
  const prefix = getCurrentWordPrefix(doc, params.position);
  console.log(`[Parasail] Completion prefix: ${prefix}`);

  const completions = [
      ...getKeywordCompletions(prefix),
      ...getLibraryCompletions(prefix),
      ...getTemplateCompletions(doc, params.position),
      ...getImportCompletions(doc.getText())
  ];

  console.log(`[Parasail] Generated completions: ${completions.length}`);
  return completions;
});

connection.onCompletionResolve(item => {
  if (PARASAIL_KEYWORDS[item.label]) {
      item.documentation = PARASAIL_KEYWORDS[item.label];
  }
  return item;
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !globalSettings.enableFormatting) {
      console.log('[Parasail] Formatting disabled or no document found');
      return [];
  }
  return formatDocument(doc.getText(), params.options);
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
      console.log('[Parasail] No document found for symbol search');
      return [];
  }
  return findDocumentSymbols(doc.getText());
});

function getKeywordCompletions(prefix: string): CompletionItem[] {
  return Object.keys(PARASAIL_KEYWORDS)
      .filter(label => label.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(label => ({
          label,
          kind: CompletionItemKind.Keyword,
          documentation: PARASAIL_KEYWORDS[label]
      }));
}

function getLibraryCompletions(prefix: string): CompletionItem[] {
  return Object.keys(STANDARD_LIBRARY)
      .filter(label => label.toLowerCase().includes(prefix.toLowerCase()))
      .map(label => ({
          label,
          kind: CompletionItemKind.Module,
          documentation: STANDARD_LIBRARY[label],
          detail: 'Standard Library'
      }));
}

function getTemplateCompletions(doc: TextDocument, pos: Position): CompletionItem[] {
  const line = doc.getText({
      start: { line: pos.line, character: 0 },
      end: { line: pos.line + 1, character: 0 }
  }).split('\n')[0];
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
  const lineText = doc.getText({
      start: { line: pos.line, character: 0 },
      end: pos
  });
  const words = lineText.split(/[^\w$]/);
  return words[words.length - 1];
}

function createTempFile(content: string): string {
  const tempPath = path.join(os.tmpdir(), `parasail-${Date.now()}.psi`);
  fs.writeFileSync(tempPath, content);
  return tempPath;
}

function formatDocument(content: string, options: FormattingOptions): TextEdit[] {
  const lines = content.split('\n');
  const edits: TextEdit[] = [];
  lines.forEach((line, index) => {
      const indentation = line.match(/^\s*/)?.[0] || '';
      const expected = ' '.repeat(options.tabSize * Math.max(0, (indentation.length / options.tabSize) | 0));
      if (indentation !== expected) {
          edits.push(TextEdit.replace(
              { start: { line: index, character: 0 }, end: { line: index, character: indentation.length } },
              expected
          ));
      }
  });
  return edits;
}

function findDocumentSymbols(content: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const symbolPatterns: { [key: string]: RegExp } = {
      func: /func\s+(\w+)/i,
      type: /type\s+(\w+)/i,
      interface: /interface\s+(\w+)/i,
      class: /class\s+(\w+)/i
  };
  
  content.split('\n').forEach((line, lineNum) => {
      for (const [kind, pattern] of Object.entries(symbolPatterns)) {
          const match = line.match(pattern);
          if (match) {
              symbols.push({
                  name: match[1],
                  kind: SymbolKind.Function,
                  range: {
                      start: { line: lineNum, character: 0 },
                      end: { line: lineNum, character: line.length }
                  },
                  selectionRange: {
                      start: { line: lineNum, character: match.index || 0 },
                      end: { line: lineNum, character: (match.index || 0) + match[1].length }
                  }
              });
          }
      }
  });
  return symbols;
}

documents.listen(connection);
connection.listen();