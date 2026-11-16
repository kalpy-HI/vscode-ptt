import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Integration Tests', () => {
  test('Extension activates and registers commands', async () => {
    const ext = vscode.extensions.getExtension('kalpy.vscode-ptt');
    assert.ok(ext, 'Extension should be present in host');

    if (!ext.isActive) {
      await ext.activate();
    }

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('kalpy.ptt.login'), 'kalpy.ptt.login should be registered');
    assert.ok(commands.includes('kalpy.ptt.logout'), 'kalpy.ptt.logout should be registered');
    assert.ok(commands.includes('kalpy.ptt.add-board'), 'kalpy.ptt.add-board should be registered');
    assert.ok(commands.includes('kalpy.ptt.remove-board'), 'kalpy.ptt.remove-board should be registered');
    assert.ok(commands.includes('kalpy.ptt.favorite-board'), 'kalpy.ptt.favorite-board should be registered');
    assert.ok(commands.includes('kalpy.ptt.refresh-article'), 'kalpy.ptt.refresh-article should be registered');
    assert.ok(commands.includes('kalpy.ptt.refresh-board'), 'kalpy.ptt.refresh-board should be registered');
  });

  test('Can execute ptt.refresh-article command without error', async () => {
    const ext = vscode.extensions.getExtension('kalpy.vscode-ptt');
    if (ext && !ext.isActive) {
      await ext.activate();
    }

    // Should execute cleanly
    await vscode.commands.executeCommand('kalpy.ptt.refresh-article');
  });
});
