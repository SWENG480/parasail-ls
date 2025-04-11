// src/lspLifecycle.ts

import {
	createConnection,
	IPCMessageReader,
	IPCMessageWriter,
	InitializeParams,
	InitializeResult
  } from 'vscode-languageserver/node';
  import { TextDocument } from 'vscode-languageserver-textdocument';
  
  /**
   * We create one connection for the server. The connection uses an IPC reader/writer.
   */
  export const connection = createConnection(
	new IPCMessageReader(process),
	new IPCMessageWriter(process)
  );
  
  /**
   * We create a simple manager for TextDocuments. 
   * The server will track open/closed documents in memory.
   */
  import { TextDocuments } from 'vscode-languageserver';
  export const documents = new TextDocuments(TextDocument);
  
  /**
   * This holds the parameters from the initialization request, 
   * if you need them for later reference (e.g. the user's initializationOptions).
   */
  export let initParams: InitializeParams | undefined;
  
  /**
   * Called when the client sends an initialize request. 
   * We return capabilities plus do any logging or checks.
   */
  export function handleOnInitialize(params: InitializeParams): InitializeResult {
	connection.console.log('Initializing Parasail LSP...');
	initParams = params;
  
	// Return the server's capabilities to the client
	return {
	capabilities: {
		// Tells the client how we want to sync text documents 
		// (could be TextDocumentSyncKind.Incremental if you prefer).
		textDocumentSync: 1, // TextDocumentSyncKind.Full
  
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
		legend: {
			tokenTypes: ["keyword", "number", "string", "class"],
			tokenModifiers: []
		},
		full: true,
		range: true
		}
	}
	};
  }
  