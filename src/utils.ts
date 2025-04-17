// src/utils.ts
import * as fs from 'fs';
import { connection } from './lspLifeCycle';

/**
 * Convert a URI (e.g. "file:///home/user/file.psl") to a local file path.
 */
export function uriToFilePath(docUri: string): string | undefined {
  if (docUri.startsWith("file://")) {
    return docUri.replace("file://", "");
  }
  return undefined;
}

/**
 * Quick debug function to check if a file exists, logging the result.
 */
export function debugCheckFile(filePath: string, label: string) {
  if (fs.existsSync(filePath)) {
    connection.console.log(`[DEBUG] ${label} found successfully at: ${filePath}`);
  } else {
    connection.console.log(`[DEBUG] ${label} NOT found at: ${filePath}`);
  }
}
