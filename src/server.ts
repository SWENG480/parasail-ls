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
    NotificationType,
    CodeActionParams,
    CodeAction,
    CodeActionKind,
    WorkspaceEdit,
    RenameParams,
    Location,
    SemanticTokensParams,
    SemanticTokens,
    SemanticTokensLegend,
    SemanticTokensRangeParams
  } from 'vscode-languageserver/node';
  import { TextDocument } from 'vscode-languageserver-textdocument';
  import * as path from 'path';
  import * as os from 'os';
  import * as fs from 'fs';
  
  // Create the LSP connection and document manager.
  const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
  const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
  
  /**
   * Configuration interface for settings.
   */
  interface ParasailSettings {
    maxNumberOfProblems: number;
    enableFormatting: boolean;
    libraryPaths: string[];
    implicitImports: boolean;
  }
  
  /**
   * Parasail keyword documentation.
   */
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
  
  /**
   * Standard library references.
   */
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
  
  /**
   * Code templates for snippets.
   */
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
  
  /**
   * Global settings default.
   */
  let globalSettings: ParasailSettings = {
    maxNumberOfProblems: 1000,
    enableFormatting: true,
    libraryPaths: [],
    implicitImports: true
  };
  
  /**
   * Set to store user-defined words for "Add to dictionary".
   */
  const userDictionary: Set<string> = new Set<string>();
  
  /**
   * Document-specific settings.
   */
  const documentSettings: Map<string, Thenable<ParasailSettings>> = new Map();
  
  /**
   * Semantic Tokens Legend for syntax highlighting.
   */
  const tokenTypes = ["keyword", "function", "variable", "class", "interface", "operator", "number", "string"];
  const tokenModifiers: string[] = [];
  const legend: SemanticTokensLegend = { tokenTypes, tokenModifiers };
  
  /**
   * 1) onInitialize: set capabilities (including semantic tokens).
   */
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
        workspaceSymbolProvider: true,
        codeActionProvider: {
          resolveProvider: true
        },
        renameProvider: {
          prepareProvider: true
        },
        semanticTokensProvider: {
          legend,
          full: true,
          range: true
        }
      }
    };
  });
  
  /**
   * 2) onDidChangeConfiguration: update global settings.
   */
  connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
    globalSettings = change.settings.parasailServer || globalSettings;
    documents.all().forEach(validateDocument);
  });
  
  /**
   * 3) Document change events.
   */
  documents.onDidChangeContent(change => validateDocument(change.document));
  documents.onDidClose(e => documentSettings.delete(e.document.uri));
  
  /**
   * 4) Validation: Pinpoint errors.
   *    - Naively detect unrecognized words (spelling errors).
   *    - Check that every function declaration has a matching "end func".
   */
  async function validateDocument(document: TextDocument): Promise<void> {
    const text = document.getText();
    const diagnostics: Diagnostic[] = [];
  
    // Naive token-based spelling check.
    const tokens = text.split(/[\s,.:(){}[\]]+/);
    let problemCount = 0;
    for (const token of tokens) {
      const word = token.trim();
      if (!word) continue;
      const isKeyword = !!PARASAIL_KEYWORDS[word.toLowerCase()];
      const isStdLib = Object.keys(STANDARD_LIBRARY).some(k => k.toLowerCase().includes(word.toLowerCase()));
      const isUserDict = userDictionary.has(word);
      if (!isKeyword && !isStdLib && !isUserDict) {
        problemCount++;
        if (problemCount > globalSettings.maxNumberOfProblems) break;
        const index = text.indexOf(word);
        if (index >= 0) {
          const pos = positionFromIndex(text, index);
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
              start: { line: pos.line, character: pos.character },
              end: { line: pos.line, character: pos.character + word.length }
            },
            message: `Unrecognized word "${word}"`,
            source: 'parasail',
            code: 'SpellingError'
          });
        }
      }
    }
  
    // Check for functions missing an "end func" token.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const funcMatch = line.match(/^\s*func\s+(\w+)\s*\(.*?\)\s*->\s*([\w<>]+)\s*is\s*$/);
      if (funcMatch) {
        let foundEnd = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*end\s+func/.test(lines[j])) {
            foundEnd = true;
            break;
          }
        }
        if (!foundEnd) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
              start: { line: i, character: 0 },
              end: { line: i, character: line.length }
            },
            message: `Function "${funcMatch[1]}" is missing an "end func".`,
            source: 'parasail',
            code: 'MissingEndFunc'
          });
        }
      }
    }
  
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  }
  
  /**
   * Helper: Convert an index to a line/character position.
   */
  function positionFromIndex(text: string, idx: number): { line: number; character: number } {
    const lines = text.slice(0, idx).split('\n');
    const line = lines.length - 1;
    const character = lines[line].length;
    return { line, character };
  }
  
  /**
   * 5) Hover provider: Provide hover info for keywords and declarations.
   */
  connection.onHover((params: TextDocumentPositionParams): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return null;
  
    // Keyword hover.
    const keywordDoc = PARASAIL_KEYWORDS[word.toLowerCase()];
    if (keywordDoc) {
      return { contents: { kind: "markdown", value: keywordDoc } };
    }
  
    // Parse document for top-level symbols.
    const symbols = parseDocumentSymbolsForHover(doc);
    const symbol = symbols.get(word);
    if (!symbol) return null;
  
    let hoverContent = `**${symbol.kind.toUpperCase()}**: \`${symbol.name}\`\n\n`;
    if (symbol.kind === 'var' || symbol.kind === 'const') {
      if (symbol.type) {
        hoverContent += `**Type:** \`${symbol.type}\`\n\n`;
      }
      if (symbol.value) {
        hoverContent += `**Value:** \`${symbol.value}\`\n\n`;
      }
    }
    if (symbol.kind === 'func') {
      hoverContent += `**Parameters:** \`${symbol.params}\`\n\n`;
      if (symbol.returnType) {
        hoverContent += `**Returns:** \`${symbol.returnType}\`\n\n`;
      }
    }
    hoverContent += `**Definition:**\n\`\`\`parasail\n${symbol.line}\n\`\`\``;
    return { contents: { kind: "markdown", value: hoverContent } };
  });
  
  /**
   * Helper: Parse document for top-level symbols.
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
    const patterns: Array<{ kind: string; regex: RegExp; extractor: (match: RegExpMatchArray) => Partial<ParasailSymbol> }> = [
      {
        kind: 'var',
        regex: /^\s*var\s+(\w+)\s*(?::\s*([\w<>]+))?\s*(?::=\s*(.+))?/i,
        extractor: (match) => ({ name: match[1], type: match[2]?.trim(), value: match[3]?.trim() })
      },
      {
        kind: 'const',
        regex: /^\s*const\s+(\w+)\s*(?::\s*([\w<>]+))?\s*(?::=\s*(.+))?/i,
        extractor: (match) => ({ name: match[1], type: match[2]?.trim(), value: match[3]?.trim() })
      },
      {
        kind: 'func',
        regex: /^\s*func\s+(\w+)\s*\((.*?)\)\s*->\s*([\w<>]+)\s*is/i,
        extractor: (match) => ({ name: match[1], params: match[2].trim(), returnType: match[3].trim() })
      },
      {
        kind: 'type',
        regex: /^\s*type\s+(\w+)\s+is\b/i,
        extractor: (match) => ({ name: match[1] })
      },
      {
        kind: 'interface',
        regex: /^\s*interface\s+(\w+)/i,
        extractor: (match) => ({ name: match[1] })
      },
      {
        kind: 'class',
        regex: /^\s*class\s+(\w+)/i,
        extractor: (match) => ({ name: match[1] })
      },
      {
        kind: 'op',
        regex: /^\s*op\s+"([^"]+)"\s*\((.*?)\)/i,
        extractor: (match) => ({ name: match[1] })
      }
    ];
    const symbols = new Map<string, ParasailSymbol>();
    for (const line of lines) {
      for (const p of patterns) {
        const match = line.match(p.regex);
        if (match) {
          const info = p.extractor(match);
          symbols.set(info.name!, {
            kind: p.kind,
            name: info.name!,
            line: line.trim(),
            type: info.type,
            value: info.value,
            params: info.params,
            returnType: info.returnType
          });
        }
      }
    }
    return symbols;
  }
  
  /**
   * 6) Completion provider: Combine completions from keywords, standard library, templates, and imports.
   */
  connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const prefix = getCurrentWordPrefix(doc, params.position);
    const completions = [
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
  
  /**
   * 7) Code Actions: Provide fixes for SpellingError and FunctionMissingBody.
   */
  connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const actions: CodeAction[] = [];
    params.context.diagnostics.forEach(diag => {
      if (diag.code === 'SpellingError') {
        const text = doc.getText(diag.range);
        const title = `Add "${text}" to dictionary`;
        const fix: CodeAction = {
          title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit: { changes: {} },
          command: {
            title,
            command: 'parasail.addToDictionary',
            arguments: [text]
          }
        };
        actions.push(fix);
      } else if (diag.code === 'MissingEndFunc') {
        const fix: CodeAction = {
          title: `Insert "end func"`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit: {
            changes: {
              [doc.uri]: [{
                range: {
                  start: { line: diag.range.start.line + 1, character: 0 },
                  end: { line: diag.range.start.line + 1, character: 0 }
                },
                newText: "end func\n"
              }]
            }
          }
        };
        actions.push(fix);
      }
    });
    return actions;
  });
  
  connection.onCodeActionResolve((action: CodeAction): CodeAction => {
    return action;
  });
  
  /**
   * 8) Command handler for "Add to dictionary".
   */
  connection.onRequest('parasail.addToDictionary', (word: string) => {
    userDictionary.add(word);
    connection.console.log(`Added "${word}" to user dictionary.`);
  });
  
  /**
   * 9) Document formatting.
   */
  connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || !globalSettings.enableFormatting) return [];
    return formatDocument(doc.getText(), params.options);
  });
  
  /**
   * 10) Document symbols.
   */
  connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return findDocumentSymbols(doc.getText());
  });
  
  /**
   * 11) Definition request (stub).
   */
  connection.onDefinition((params) => {
    return [];
  });
  
  /**
   * 12) References request (stub).
   */
  connection.onReferences((params) => {
    return [];
  });
  
  /**
   * 13) Rename Provider: Prepare rename by returning the word range.
   */
  connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const word = getWordAtPosition(doc, params.position);
    if (!word) return null;
    const range = {
      start: params.position,
      end: { line: params.position.line, character: params.position.character + word.length }
    };
    return { range, placeholder: word };
  });
  
  /**
   * 14) Rename Request: Naively replace all occurrences of oldName with newName.
   */
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
      edits.push({
        range: { start: pos, end: { line: pos.line, character: pos.character + oldName.length } },
        newText: newName
      });
      idx = text.indexOf(oldName, idx + oldName.length);
    }
    return { changes: { [doc.uri]: edits } };
  });
  
  /**
   * 15) Semantic Tokens Provider (Full): Mark keywords, numbers, strings, and class names.
   */
  connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };
    const text = doc.getText();
    const lines = text.split('\n');
    const tokens: number[] = [];
    let prevLine = 0;
    let prevChar = 0;
    
    const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
      { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|end|is|parallel|forward|optional|null)\b/g, tokenType: "keyword" },
      { regex: /\b\d+(\.\d+)?\b/g, tokenType: "number" },
      { regex: /"([^"\\]|\\.)*"/g, tokenType: "string" },
      { regex: /\b[A-Z][A-Za-z0-9_]*\b/g, tokenType: "class" }
    ];
    
    const tokenTypeMap: { [key: string]: number } = {};
    tokenTypes.forEach((type, index) => { tokenTypeMap[type] = index; });
    
    for (let line = 0; line < lines.length; line++) {
      const lineText = lines[line];
      for (const { regex, tokenType } of tokenPatterns) {
        let match;
        while ((match = regex.exec(lineText)) !== null) {
          const startChar = match.index;
          const length = match[0].length;
          const deltaLine = line - prevLine;
          const deltaStart = deltaLine === 0 ? startChar - prevChar : startChar;
          tokens.push(deltaLine, deltaStart, length, tokenTypeMap[tokenType], 0);
          prevLine = line;
          prevChar = startChar;
        }
      }
    }
    return { data: tokens };
  });
  
  /**
   * 16) Semantic Tokens Provider (Range): Handle range requests.
   */
  connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams): SemanticTokens => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };
    const text = doc.getText();
    const lines = text.split('\n');
    const tokens: number[] = [];
    let prevLine = params.range.start.line;
    let prevChar = params.range.start.character;
    
    const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
      { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|end|is|parallel|forward|optional|null)\b/g, tokenType: "keyword" },
      { regex: /\b\d+(\.\d+)?\b/g, tokenType: "number" },
      { regex: /"([^"\\]|\\.)*"/g, tokenType: "string" },
      { regex: /\b[A-Z][A-Za-z0-9_]*\b/g, tokenType: "class" }
    ];
    
    const tokenTypeMap: { [key: string]: number } = {};
    tokenTypes.forEach((type, index) => { tokenTypeMap[type] = index; });
    
    for (let line = params.range.start.line; line <= params.range.end.line && line < lines.length; line++) {
      const lineText = lines[line];
      for (const { regex, tokenType } of tokenPatterns) {
        let match;
        while ((match = regex.exec(lineText)) !== null) {
          const startChar = match.index;
          const length = match[0].length;
          // Skip tokens before the range start on the first line.
          if (line === params.range.start.line && startChar < params.range.start.character) continue;
          // Skip tokens after the range end on the last line.
          if (line === params.range.end.line && (startChar + length) > params.range.end.character) continue;
          const deltaLine = line - prevLine;
          const deltaStart = deltaLine === 0 ? startChar - prevChar : startChar;
          tokens.push(deltaLine, deltaStart, length, tokenTypeMap[tokenType], 0);
          prevLine = line;
          prevChar = startChar;
        }
      }
    }
    return { data: tokens };
  });
  
  /**
   * 17) Helper: Get the word at the cursor.
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
  
  /**
   * 18) Helper: Get the current word prefix for completions.
   */
  function getCurrentWordPrefix(doc: TextDocument, pos: Position): string {
    const lineText = doc.getText({ start: { line: pos.line, character: 0 }, end: pos });
    const words = lineText.split(/[^\w$]/);
    return words[words.length - 1];
  }
  
  /**
   * 19) Helper: Keyword completions.
   */
  function getKeywordCompletions(prefix: string): CompletionItem[] {
    return Object.keys(PARASAIL_KEYWORDS)
      .filter(label => label.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(label => ({
        label,
        kind: CompletionItemKind.Keyword,
        documentation: PARASAIL_KEYWORDS[label]
      }));
  }
  
  /**
   * 20) Helper: Standard library completions.
   */
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
  
  /**
   * 21) Helper: Snippet completions.
   */
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
  
  /**
   * 22) Helper: Import completions.
   */
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
  
  /**
   * 23) Helper: Document formatting.
   */
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
  
  //
  /**
   * 24) Helper: Document symbols.
   */
  function findDocumentSymbols(content: string): DocumentSymbol[] {
    const symbols: DocumentSymbol[] = [];
    const symbolPatterns: { [key: string]: RegExp } = {
      func: /func\s+(\w+)/i,
      type: /type\s+(\w+)/i,
      interface: /interface\s+(\w+)/i,
      class: /class\s+(\w+)/i
    };
    const lines = content.split('\n');
    lines.forEach((line, lineNum) => {
      for (const [_, pattern] of Object.entries(symbolPatterns)) {
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
  
  /**
   * 25) Library notifications.
   */
  const addLibraryNotification = new NotificationType<{ name: string; path: string }>('parasail/addLibrary');
  const removeLibraryNotification = new NotificationType<{ name: string; path: string }>('parasail/removeLibrary');
  
  connection.onNotification(addLibraryNotification, (params) => {
    if (!globalSettings.libraryPaths.includes(params.path)) {
      globalSettings.libraryPaths.push(params.path);
      connection.console.log(`[Parasail] Added library path: ${params.path}`);
    }
  });
  
  connection.onNotification(removeLibraryNotification, (params) => {
    globalSettings.libraryPaths = globalSettings.libraryPaths.filter(p => p !== params.path);
    connection.console.log(`[Parasail] Removed library path: ${params.path}`);
  });
  
  /**
   * Finally, listen for text documents and start the LSP connection.
   */
  documents.listen(connection);
  connection.listen();
  