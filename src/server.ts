/********************************************************************************************
 * Parasail Language Server - Extended Version
 *
 * This file implements a ParaSail language server using a simplified tokenizer, a recursive‑descent
 * parser for top‑level declarations and statements, and LSP features including hover, completions,
 * code actions, renaming, formatting, and semantic tokens.
 *
 * Logging is enabled (via connection.console.log) to show actions (token consumption, parsing, etc.).
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

/* --------------------------------------------------------------------------------------------
 * 1) Connection & Document Setup
 * ------------------------------------------------------------------------------------------ */

const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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

const tokenTypes = ["keyword", "function", "variable", "class", "interface", "operator", "number", "string"];
const tokenModifiers: string[] = [];
const legend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

/* --------------------------------------------------------------------------------------------
 * 2) Keywords, Reserved Words, Standard Library & Templates
 * ------------------------------------------------------------------------------------------ */

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
RESERVED_WORDS.forEach(word => {
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

/* --------------------------------------------------------------------------------------------
 * 3) Tokenizer
 * ------------------------------------------------------------------------------------------ */

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
    { type: 'operator', regex: new RegExp(
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
            tokens.push({
              type: pattern.type,
              value: result[0],
              line: lineNum,
              character: pos
            });
          }
          pos += result[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        tokens.push({
          type: 'unknown',
          value: lineText[pos],
          line: lineNum,
          character: pos
        });
        pos++;
      }
    }
  }
  connection.console.log(`Tokenization complete. Total tokens: ${tokens.length}`);
  return tokens;
}

/* --------------------------------------------------------------------------------------------
 * 4) Parser (Recursive‑Descent)
 * ------------------------------------------------------------------------------------------ */

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

  current(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  peekNextValue(): string | null {
    return (this.pos + 1 < this.tokens.length) ? this.tokens[this.pos + 1].value : null;
  }

  consume(): Token | null {
    const token = this.current();
    if (token) {
      this.pos++;
      connection.console.log(`Consumed token: "${token.value}" at line ${token.line}, char ${token.character}`);
    }
    return token;
  }

  matchValue(expected: string): boolean {
    const token = this.current();
    if (token && token.value === expected) {
      this.consume();
      return true;
    }
    return false;
  }

  expectValue(expected: string): Token | null {
    const token = this.current();
    if (token && token.value === expected) {
      return this.consume();
    } else {
      this.error(`Expected "${expected}"`, token);
      return null;
    }
  }

  error(message: string, token: Token | null) {
    const diag: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: token
        ? { start: { line: token.line, character: token.character }, end: { line: token.line, character: token.character + token.value.length } }
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      message,
      source: 'parasail-parser'
    };
    this.errors.push(diag);
    connection.console.log(`Parser error: ${message}`);
  }

  // Always returns a non-null position by falling back to a fallback token if needed.
  makePos(token: Token | null, fallback: Token): Position {
    const t = token || fallback;
    return { line: t.line, character: t.character + t.value.length };
  }

  parseProgram(): ASTNode {
    const root: ASTNode = { type: "Program", children: [], start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    connection.console.log("Parsing program...");
    while (this.current() !== null) {
      const decl = this.parseTopLevel();
      if (decl) {
        root.children.push(decl);
      } else {
        this.consume();
      }
    }
    if (this.tokens.length > 0) {
      const last = this.tokens[this.tokens.length - 1];
      root.end = { line: last.line, character: last.character + last.value.length };
    }
    connection.console.log("Program parsed.");
    return root;
  }

  parseTopLevel(): ASTNode | null {
    const token = this.current();
    if (!token) return null;
    switch (token.value) {
      case "module":     return this.parseModule();
      case "interface":  return this.parseInterface();
      case "class":      return this.parseClass();
      case "func":       return this.parseFunction();
      case "type":       return this.parseType();
      case "op":         return this.parseOp();
      case "var":
      case "const":
        return this.parseVarConst();
      default:
        return this.parseStatement();
    }
  }

  parseModule(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected module name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    if (this.matchValue("is")) {
      // Optionally parse module header contents
    }
    const body: ASTNode = { type: "ModuleBody", children: [], start: this.makePos(nameToken, startToken), end: this.makePos(nameToken, startToken) };
    while (!this.checkEnd("module")) {
      const child = this.parseTopLevel();
      if (child) body.children.push(child);
      else {
        if (!this.current()) break;
        this.consume();
      }
    }
    this.expectValue("end");
    this.expectValue("module");
    if (this.current() && this.current()!.value === name) {
      this.consume();
    }
    const endToken = this.current() || startToken;
    const moduleNode: ASTNode = {
      type: "ModuleDeclaration",
      name,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed module: ${name}`);
    return moduleNode;
  }

  checkEnd(kind: string): boolean {
    if (this.current() && this.current()!.value === "end") {
      const nextVal = this.peekNextValue();
      if (nextVal === kind) {
        return true;
      }
    }
    return false;
  }

  parseInterface(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected interface name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    if (this.matchValue("is")) {
      // Optionally parse interface header
    }
    const body: ASTNode = { type: "InterfaceBody", children: [], start: this.makePos(nameToken, startToken), end: this.makePos(nameToken, startToken) };
    while (!this.checkEnd("interface")) {
      const child = this.parseTopLevel();
      if (child) body.children.push(child);
      else {
        if (!this.current()) break;
        this.consume();
      }
    }
    this.expectValue("end");
    this.expectValue("interface");
    if (this.current() && this.current()!.value === name) {
      this.consume();
    }
    const endToken = this.current() || startToken;
    const interfaceNode: ASTNode = {
      type: "InterfaceDeclaration",
      name,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed interface: ${name}`);
    return interfaceNode;
  }

  parseClass(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected class name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    if (this.matchValue("is")) {
      // Optional class header parsing
    }
    const body: ASTNode = { type: "ClassBody", children: [], start: this.makePos(nameToken, startToken), end: this.makePos(nameToken, startToken) };
    while (!this.checkEnd("class")) {
      const child = this.parseTopLevel();
      if (child) body.children.push(child);
      else {
        if (!this.current()) break;
        this.consume();
      }
    }
    this.expectValue("end");
    this.expectValue("class");
    if (this.current() && this.current()!.value === name) {
      this.consume();
    }
    const endToken = this.current() || startToken;
    const classNode: ASTNode = {
      type: "ClassDeclaration",
      name,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed class: ${name}`);
    return classNode;
  }

  parseFunction(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) {
      this.error("Expected 'func' token", null);
      return null;
    }
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected function name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    this.expectValue("(");
    while (this.current() && this.current()!.value !== ")") {
      this.consume();
    }
    this.expectValue(")");
    this.expectValue("->");
    const retTypeToken = this.current();
    if (!retTypeToken || retTypeToken.type !== "identifier") {
      this.error("Expected return type", retTypeToken);
      return null;
    }
    this.consume();
    this.expectValue("is");
    const bodyStart = this.current() ? { line: this.current()!.line, character: this.current()!.character } : { line: 0, character: 0 };
    const body: ASTNode = { type: "FunctionBody", children: [], start: bodyStart, end: { line: 0, character: 0 } };
    while (this.current() && !(this.current()!.value === "end" && this.peekNextValue() === "func")) {
      const child = this.parseStatementOrDecl();
      if (child) body.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("func");
    const endToken = this.current() || startToken;
    const funcNode: ASTNode = {
      type: "FunctionDeclaration",
      name,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed function: ${name}`);
    return funcNode;
  }

  parseType(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) {
      this.error("Expected 'type' token", null);
      return null;
    }
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected type name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    this.expectValue("is");
    const body: ASTNode = { type: "TypeBody", children: [], start: this.makePos(nameToken, startToken), end: this.makePos(nameToken, startToken) };
    while (!this.checkEnd("type")) {
      if (!this.current()) break;
      const child = this.parseStatementOrDecl();
      if (child) body.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("type");
    if (this.current() && this.current()!.value === name) {
      this.consume();
    }
    const endToken = this.current() || startToken;
    const typeNode: ASTNode = {
      type: "TypeDeclaration",
      name,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed type: ${name}`);
    return typeNode;
  }

  parseOp(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) {
      this.error("Expected 'op' token", null);
      return null;
    }
    const opSymbolToken = this.current();
    if (!opSymbolToken || opSymbolToken.type !== "string") {
      this.error("Expected operator string literal after 'op'", opSymbolToken);
      return null;
    }
    const opName = opSymbolToken.value;
    this.consume();
    this.expectValue("(");
    while (this.current() && this.current()!.value !== ")") {
      this.consume();
    }
    this.expectValue(")");
    if (this.matchValue("->")) {
      const retType = this.current();
      if (retType && retType.type === "identifier") {
        this.consume();
      } else {
        this.error("Expected return type after ->", retType);
      }
    }
    this.expectValue("is");
    const body: ASTNode = { type: "OperatorBody", children: [], start: this.makePos(opSymbolToken, startToken), end: this.makePos(opSymbolToken, startToken) };
    while (this.current() && !(this.current()!.value === "end" && this.peekNextValue() === "op")) {
      const child = this.parseStatementOrDecl();
      if (child) body.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("op");
    if (this.current() && this.current()!.value === opSymbolToken.value) {
      this.consume();
    }
    const endToken = this.current() || startToken;
    const opNode: ASTNode = {
      type: "OperatorDeclaration",
      name: opName,
      children: [body],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed operator: ${opName}`);
    return opNode;
  }

  parseVarConst(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) {
      this.error("Expected 'var' or 'const' token", null);
      return null;
    }
    const varType = startToken.value;
    const nameToken = this.current();
    if (!nameToken || nameToken.type !== "identifier") {
      this.error("Expected variable/const name", nameToken);
      return null;
    }
    const name = nameToken.value;
    this.consume();
    if (this.matchValue(":")) {
      if (this.current() && this.current()!.type === "identifier") {
        this.consume();
      }
    }
    if (this.current() && (this.current()!.value === ":=" || this.current()!.value === "<==")) {
      this.consume();
      while (this.current() && this.current()!.value !== ";") {
        this.consume();
      }
    }
    this.expectValue(";");
    const endToken = this.current() || startToken;
    const varNode: ASTNode = {
      type: varType === "var" ? "VariableDeclaration" : "ConstantDeclaration",
      name,
      children: [],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    connection.console.log(`Parsed ${varType} declaration: ${name}`);
    return varNode;
  }

  parseStatementOrDecl(): ASTNode | null {
    const token = this.current();
    if (!token) return null;
    switch (token.value) {
      case "var":
      case "const":
        return this.parseVarConst();
      case "func":
        return this.parseFunction();
      case "type":
        return this.parseType();
      case "op":
        return this.parseOp();
      case "if":
      case "case":
      case "loop":
      case "while":
      case "for":
      case "block":
      case "exit":
      case "continue":
        return this.parseStatement();
      default:
        return this.parseStatement();
    }
  }

  parseStatement(): ASTNode | null {
    const token = this.current();
    if (!token) return null;
    switch (token.value) {
      case "if":     return this.parseIfStatement();
      case "case":   return this.parseCaseStatement();
      case "loop":   return this.parseLoopStatement();
      case "block":  return this.parseBlockStatement();
      case "while":  return this.parseWhileStatement();
      case "for":    return this.parseForStatement();
      case "exit":   return this.parseExitStatement();
      case "continue": return this.parseContinueStatement();
      default:
        return this.parseExprStatement();
    }
  }

  parseIfStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    while (this.current() && this.current()!.value !== "then") {
      this.consume();
    }
    this.expectValue("then");
    const ifBody: ASTNode = { type: "IfBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (this.current() && !this.checkAny(["elsif", "else", "end"])) {
      const child = this.parseStatementOrDecl();
      if (child) ifBody.children.push(child);
      else this.consume();
    }
    const elsifNodes: ASTNode[] = [];
    while (this.current() && this.current()!.value === "elsif") {
      const elsifToken = this.consume()!; // non-null
      while (this.current() && this.current()!.value !== "then") {
        this.consume();
      }
      this.expectValue("then");
      const elsifBody: ASTNode = { type: "ElsifBody", children: [], start: this.makePos(elsifToken, startToken), end: this.makePos(elsifToken, startToken) };
      while (this.current() && !this.checkAny(["elsif", "else", "end"])) {
        const child = this.parseStatementOrDecl();
        if (child) elsifBody.children.push(child);
        else this.consume();
      }
      elsifNodes.push(elsifBody);
    }
    let elseNode: ASTNode | null = null;
    if (this.current() && this.current()!.value === "else") {
      const elseToken = this.consume()!;
      const elseBody: ASTNode = { type: "ElseBody", children: [], start: this.makePos(elseToken, startToken), end: this.makePos(elseToken, startToken) };
      while (this.current() && !this.checkEnd("if")) {
        const child = this.parseStatementOrDecl();
        if (child) elseBody.children.push(child);
        else this.consume();
      }
      elseNode = elseBody;
    }
    this.expectValue("end");
    this.expectValue("if");
    const endToken = this.current() || startToken;
    const ifNode: ASTNode = {
      type: "IfStatement",
      name: "if",
      children: [ifBody, ...elsifNodes],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    if (elseNode) ifNode.children.push(elseNode);
    return ifNode;
  }

  parseCaseStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    while (this.current() && this.current()!.value !== "of") {
      this.consume();
    }
    this.expectValue("of");
    const caseBody: ASTNode = { type: "CaseBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (!this.checkEnd("case")) {
      if (!this.current()) break;
      this.consume();
    }
    this.expectValue("end");
    this.expectValue("case");
    const endToken = this.current() || startToken;
    const caseNode: ASTNode = {
      type: "CaseStatement",
      name: "case",
      children: [caseBody],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    return caseNode;
  }

  parseLoopStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    const loopBody: ASTNode = { type: "LoopBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (!this.checkEnd("loop")) {
      if (!this.current()) break;
      const child = this.parseStatementOrDecl();
      if (child) loopBody.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("loop");
    const endToken = this.current() || startToken;
    const loopNode: ASTNode = {
      type: "LoopStatement",
      children: [loopBody],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    return loopNode;
  }

  parseBlockStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    const blockBody: ASTNode = { type: "BlockBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (!this.checkEnd("block")) {
      if (!this.current()) break;
      const child = this.parseStatementOrDecl();
      if (child) blockBody.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("block");
    const endToken = this.current() || startToken;
    const blockNode: ASTNode = {
      type: "BlockStatement",
      children: [blockBody],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    return blockNode;
  }

  parseWhileStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    while (this.current() && this.current()!.value !== "loop") {
      this.consume();
    }
    this.expectValue("loop");
    const whileBody: ASTNode = { type: "WhileBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (!this.checkEnd("loop")) {
      if (!this.current()) break;
      const child = this.parseStatementOrDecl();
      if (child) whileBody.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("loop");
    const endToken = this.current() || startToken;
    const whileNode: ASTNode = {
      type: "WhileStatement",
      children: [whileBody],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    return whileNode;
  }

  parseForStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    while (this.current() && this.current()!.value !== "loop") {
      this.consume();
    }
    this.expectValue("loop");
    const forBody: ASTNode = { type: "ForBody", children: [], start: this.makePos(startToken, startToken), end: this.makePos(startToken, startToken) };
    while (!this.checkEnd("loop")) {
      if (!this.current()) break;
      const child = this.parseStatementOrDecl();
      if (child) forBody.children.push(child);
      else this.consume();
    }
    this.expectValue("end");
    this.expectValue("loop");
    const endToken = this.current() || startToken;
    const forNode: ASTNode = {
      type: "ForStatement",
      children: [forBody],
      start: this.makePos(startToken, startToken),
      end: this.makePos(endToken, startToken)
    };
    return forNode;
  }

  parseExitStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    if (this.current() && (this.current()!.value === "loop" || this.current()!.value === "if" || this.current()!.value === "block")) {
      this.consume();
    }
    const exitNode: ASTNode = {
      type: "ExitStatement",
      children: [],
      start: this.makePos(startToken, startToken),
      end: this.makePos(startToken, startToken)
    };
    return exitNode;
  }

  parseContinueStatement(): ASTNode | null {
    const startToken = this.consume();
    if (!startToken) return null;
    if (this.current() && this.current()!.value === "loop") {
      this.consume();
    }
    const contNode: ASTNode = {
      type: "ContinueStatement",
      children: [],
      start: this.makePos(startToken, startToken),
      end: this.makePos(startToken, startToken)
    };
    return contNode;
  }

  parseExprStatement(): ASTNode | null {
    const startToken = this.current();
    if (!startToken) return null;
    while (this.current() && this.current()!.value !== ";") {
      this.consume();
    }
    if (this.current() && this.current()!.value === ";") {
      this.consume();
    }
    const exprNode: ASTNode = {
      type: "ExpressionStatement",
      children: [],
      start: this.makePos(startToken, startToken),
      end: this.makePos(startToken, startToken)
    };
    return exprNode;
  }

  checkAny(values: string[]): boolean {
    return this.current() ? values.includes(this.current()!.value) : false;
  }
}

function parseFullDocument(text: string): { ast: ASTNode | null; errors: Diagnostic[] } {
  const tokens = tokenizeParasail(text);
  const parser = new Parser(tokens);
  const ast = parser.parseProgram();
  connection.console.log("Full document parsing complete.");
  return { ast, errors: parser.errors };
}

/* --------------------------------------------------------------------------------------------
 * 5) Helper: Convert Index to Position
 * ------------------------------------------------------------------------------------------ */

function positionFromIndex(text: string, idx: number): { line: number; character: number } {
  const lines = text.slice(0, idx).split('\n');
  const line = lines.length - 1;
  const character = lines[line].length;
  return { line, character };
}

/* --------------------------------------------------------------------------------------------
 * 6) LSP Lifecycle & Configuration
 * ------------------------------------------------------------------------------------------ */

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('Initializing Parasail LSP...');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.', ':', '<', '"', '/', ' ']
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

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  globalSettings = change.settings.parasailServer || globalSettings;
  connection.console.log("Configuration changed.");
  documents.all().forEach(validateDocument);
});

documents.onDidChangeContent(change => {
  connection.console.log(`Document changed: ${change.document.uri}`);
  validateDocument(change.document);
});
documents.onDidClose(e => {
  connection.console.log(`Document closed: ${e.document.uri}`);
  documentSettings.delete(e.document.uri);
});

/* --------------------------------------------------------------------------------------------
 * 7) Validation
 * ------------------------------------------------------------------------------------------ */

async function validateDocument(document: TextDocument): Promise<void> {
  const text = document.getText();
  const diagnostics: Diagnostic[] = [];

  // Naive token-based spelling check (using whitespace split)
  const tokensText = text.split(/[\s,.:(){}[\]]+/);
  let problemCount = 0;
  for (const token of tokensText) {
    const word = token.trim();
    if (!word) continue;
    const isKeyword = !!PARASAIL_KEYWORDS[word.toLowerCase()];
    const isStdLib = Object.keys(STANDARD_LIBRARY).some(k => k.toLowerCase().includes(word.toLowerCase()));
    const isUserDict = userDictionary.has(word);
    if (!isKeyword && !isStdLib && !isUserDict && isNaN(Number(word))) {
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

  // Tokenize document and report unknown tokens
  const tokens = tokenizeParasail(text);
  tokens.forEach(token => {
    if (token.type === 'unknown') {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: token.line, character: token.character },
          end: { line: token.line, character: token.character + token.value.length }
        },
        message: `Unrecognized token "${token.value}"`,
        source: 'parasail',
        code: 'UnknownToken'
      });
    }
  });

  // Parse document and add parser errors
  const parseResult = parseFullDocument(text);
  diagnostics.push(...parseResult.errors);

  // Check for functions missing an "end func" marker
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
  connection.console.log(`Diagnostics sent for document: ${document.uri}`);
}

/* --------------------------------------------------------------------------------------------
 * 8) Hover Provider
 * ------------------------------------------------------------------------------------------ */

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;

  const keywordDoc = PARASAIL_KEYWORDS[word.toLowerCase()];
  if (keywordDoc) {
    connection.console.log(`Hover: showing keyword info for ${word}`);
    return { contents: { kind: "markdown", value: keywordDoc } };
  }

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
  connection.console.log(`Hover: showing symbol info for ${word}`);
  return { contents: { kind: "markdown", value: hoverContent } };
});

/* --------------------------------------------------------------------------------------------
 * 9) Document Symbols (Regex-based for Hover)
 * ------------------------------------------------------------------------------------------ */

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
      extractor: (match) => ({ name: match[1], type: match[2]?.trim(), value: match[3]?.trim() })
    },
    {
      kind: 'const',
      regex: /^\s*const\s+(\w+)\s*(?::\s*([\w<>]+))?\s*(?::=\s*(.+))?;/i,
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
      kind: 'module',
      regex: /^\s*module\s+(\w+)/i,
      extractor: (match) => ({ name: match[1] })
    },
    {
      kind: 'op',
      regex: /^\s*op\s+"([^"]+)"\s*\((.*?)\)/i,
      extractor: (match) => ({ name: match[1] })
    }
  ];
  const map = new Map<string, ParasailSymbol>();
  lines.forEach((line) => {
    for (const p of patterns) {
      const match = line.match(p.regex);
      if (match) {
        const info = p.extractor(match);
        map.set(info.name!, {
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
  });
  return map;
}

/* --------------------------------------------------------------------------------------------
 * 10) Completion Provider & Helpers
 * ------------------------------------------------------------------------------------------ */

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const prefix = getCurrentWordPrefix(doc, params.position);
  connection.console.log(`Completion requested with prefix: ${prefix}`);
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

/* --------------------------------------------------------------------------------------------
 * 11) Code Actions
 * ------------------------------------------------------------------------------------------ */

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  connection.console.log("Code action requested.");
  const actions: CodeAction[] = [];
  for (const diag of params.context.diagnostics) {
    if (diag.code === 'SpellingError' || diag.code === 'UnknownToken') {
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
    } else if (diag.code === 'MissingEndFunc' || diag.code === 'MissingEnd') {
      const fix: CodeAction = {
        title: `Insert missing end marker`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: {
          changes: {
            [doc.uri]: [{
              range: {
                start: { line: diag.range.start.line + 1, character: 0 },
                end: { line: diag.range.start.line + 1, character: 0 }
              },
              newText: "end\n"
            }]
          }
        }
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

/* --------------------------------------------------------------------------------------------
 * 12) Document Formatting
 * ------------------------------------------------------------------------------------------ */

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

/* --------------------------------------------------------------------------------------------
 * 13) Document Symbols
 * ------------------------------------------------------------------------------------------ */

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

/* --------------------------------------------------------------------------------------------
 * 14) Definition / References / Rename
 * ------------------------------------------------------------------------------------------ */

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
    edits.push({
      range: { start: pos, end: { line: pos.line, character: pos.character + oldName.length } },
      newText: newName
    });
    idx = text.indexOf(oldName, idx + oldName.length);
  }
  connection.console.log(`Rename: Replacing "${oldName}" with "${newName}"`);
  return { changes: { [doc.uri]: edits } };
});

/* --------------------------------------------------------------------------------------------
 * 15) Semantic Tokens
 * ------------------------------------------------------------------------------------------ */

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const text = doc.getText();
  const lines = text.split('\n');
  const tokens: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
    { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|elsif|end|is|parallel|forward|optional|null|block|module|exit|with|continue)\b/g, tokenType: "keyword" },
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
  const tokenPatterns: Array<{ regex: RegExp; tokenType: string }> = [
    { regex: /\b(func|type|interface|class|op|const|var|abstract|extends|exports|import|all|new|not|and|or|xor|in|case|loop|for|while|if|then|else|elsif|end|is|parallel|forward|optional|null|block|module|exit|with|continue)\b/g, tokenType: "keyword" },
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

/* --------------------------------------------------------------------------------------------
 * 16) Final Helper Functions for Hover & Completion (Consolidated)
 * ------------------------------------------------------------------------------------------ */

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
  return words[words.length - 1];
}

/* --------------------------------------------------------------------------------------------
 * 17) LSP Lifecycle: Start Listening
 * ------------------------------------------------------------------------------------------ */

documents.listen(connection);
connection.listen();
// commit