/**
 * Test bootstrap: stubs the `vscode` module for the node:test runner.
 *
 * The extension modules import `vscode` at the top level, which only resolves
 * inside the VS Code extension host. This file is loaded via
 * `node --require` BEFORE the test files, so `require('vscode')` returns a
 * minimal in-memory stub instead of throwing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = require('module') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad: (...args: any[]) => unknown = Module._load;

class FakeEventEmitter {
	private _listeners = new Set<() => void>();

	get event() {
		return (listener: () => void) => {
			this._listeners.add(listener);
			return {
				dispose: () => {
					this._listeners.delete(listener);
				},
			};
		};
	}

	fire(): void {
		for (const listener of [...this._listeners]) {
			listener();
		}
	}
}

class FakeTextPart {
	constructor(readonly value: string) { }
}

class FakeDataPart {
	constructor(readonly data: Uint8Array, readonly mimeType: string) { }
}

const vscodeStub = {
	workspace: {
		getConfiguration: () => ({
			get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
		}),
		onDidChangeConfiguration: () => ({ dispose: () => undefined }),
	},
	EventEmitter: FakeEventEmitter,
	LanguageModelTextPart: FakeTextPart,
	LanguageModelDataPart: FakeDataPart,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Module._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): any {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad.call(this, request, parent, isMain);
};
