// src/fallbackParser.ts
import { connection } from './lspLifeCycle';
import { Diagnostic } from 'vscode-languageserver/node';
import { tokenizeParasail, Token } from './fallbackTokenizer';

/** ASTNode for the fallback parser. */
export interface ASTNode {
  type: string;
  name?: string;
  children: ASTNode[];
  start: { line: number; character: number };
  end:   { line: number; character: number };
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
    // Minimal parse
    return {
      type: "Program",
      children: [],
      start: { line: 0, character: 0 },
      end:   { line: 0, character: 0 }
    };
  }
}

/**
 * Fallback parse function that logs "Full document parsing complete."
 */
export function parseFullDocument(text: string): { ast: ASTNode | null; errors: Diagnostic[] } {
  const tokens = tokenizeParasail(text);
  const parser = new Parser(tokens);
  const ast = parser.parseProgram();
  connection.console.log("Full document parsing complete.");
  return { ast, errors: parser.errors };
}
