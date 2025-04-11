// src/fallbackTokenizer.ts
import { connection } from './lspLifecycle'; 
// (We import `connection` directly so we can do connection.console.log(...) below.)

import { Position } from 'vscode-languageserver/node';

// A token interface for the fallback tokenizer
export interface Token {
  type: string;
  value: string;
  line: number;
  character: number;
}

/**
 * Basic fallback tokenizer for Parasail-like text. 
 * Logs the number of tokens via connection.console.log.
 */
export function tokenizeParasail(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');

  const patterns: { type: string; regex: RegExp }[] = [
    { type: 'whitespace', regex: /^[\s]+/ },
    { type: 'comment',    regex: /^\/\/.*/ },
    { type: 'string',     regex: /^"([^"\\]|\\.)*"/ },
    { type: 'char',       regex: /^'([^'\\]|\\.)'/ },
    { type: 'number',     regex: /^\d+(\.\d+)?/ },
    {
      type: 'identifier',
      regex: /^[A-Za-z_][A-Za-z0-9_]*/
    },
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

  connection.console.log(`Tokenization complete => ${tokens.length} tokens`);
  return tokens;
}
