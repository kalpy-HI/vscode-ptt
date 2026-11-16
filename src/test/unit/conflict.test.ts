import assert from 'node:assert';
import type * as vscode from 'vscode';
import { findConflictingExtension, setExtensionContext, ORIGINAL_EXTENSION_ID } from '../../extension';
import { mockVscode } from './setup';

describe('conflict with the original extension', () => {
  const originalGetExtension = mockVscode.extensions.getExtension;

  afterEach(() => {
    mockVscode.extensions.getExtension = originalGetExtension;
  });

  it('reports the original Yukai.vscode-ptt when it is enabled', () => {
    setExtensionContext({ extension: { id: 'kalpy.vscode-ptt' } } as unknown as vscode.ExtensionContext);
    mockVscode.extensions.getExtension = (id: string) => (id === ORIGINAL_EXTENSION_ID ? { id: 'Yukai.vscode-ptt' } : undefined);

    assert.strictEqual(findConflictingExtension()?.id, 'Yukai.vscode-ptt');
  });

  it('reports nothing when the original is not installed or disabled', () => {
    setExtensionContext({ extension: { id: 'kalpy.vscode-ptt' } } as unknown as vscode.ExtensionContext);
    mockVscode.extensions.getExtension = () => undefined;

    assert.strictEqual(findConflictingExtension(), undefined);
  });

  it('does not flag itself when running as the original extension', () => {
    setExtensionContext({ extension: { id: 'Yukai.vscode-ptt' } } as unknown as vscode.ExtensionContext);
    mockVscode.extensions.getExtension = () => ({ id: 'Yukai.vscode-ptt' });

    assert.strictEqual(findConflictingExtension(), undefined);
  });
});
