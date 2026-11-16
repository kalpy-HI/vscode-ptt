import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  findSourceFolder,
  isForkSource,
  readPackageInfo,
  clearObsoleteMarker,
  cliCandidates,
  forceInstallVsix
} from '../../selfUpdate';
import { mockVscode } from './setup';

describe('selfUpdate (從原始碼更新擴充功能)', () => {
  it('recognises the fork source by publisher.name', () => {
    assert.strictEqual(isForkSource({ name: 'vscode-ptt', publisher: 'kalpy' }, 'kalpy.vscode-ptt'), true);
    assert.strictEqual(isForkSource({ name: 'vscode-ptt', publisher: 'Kalpy' }, 'kalpy.vscode-ptt'), true);
    assert.strictEqual(isForkSource({ name: 'vscode-ptt', publisher: 'Yukai' }, 'kalpy.vscode-ptt'), false);
    assert.strictEqual(isForkSource({ name: 'other' }, 'kalpy.vscode-ptt'), false);
    assert.strictEqual(isForkSource(null, 'kalpy.vscode-ptt'), false);
  });

  it('prefers the remembered folder, then workspace folders, skipping others', async () => {
    const pkgs: Record<string, { name: string; publisher: string }> = {
      '/remembered': { name: 'vscode-ptt', publisher: 'kalpy' },
      '/ws-other': { name: 'something', publisher: 'me' },
      '/ws-fork': { name: 'vscode-ptt', publisher: 'kalpy' }
    };
    const read = async (f: string) => pkgs[f] ?? null;

    assert.strictEqual(await findSourceFolder(['/remembered', '/ws-fork'], 'kalpy.vscode-ptt', read), '/remembered');
    assert.strictEqual(await findSourceFolder([undefined, '/ws-other', '/ws-fork'], 'kalpy.vscode-ptt', read), '/ws-fork');
    assert.strictEqual(await findSourceFolder(['/gone', '/ws-other'], 'kalpy.vscode-ptt', read), undefined);
  });

  it('reads package.json from disk and tolerates missing folders', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptt-self-update-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'vscode-ptt', publisher: 'kalpy', version: '0.5.0' }));
      assert.deepStrictEqual(await readPackageInfo(dir), { name: 'vscode-ptt', publisher: 'kalpy', version: '0.5.0' });
      assert.strictEqual(await readPackageInfo(path.join(dir, 'missing')), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('forcing a same-version reinstall', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptt-obsolete-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('removes this version from VS Code\'s .obsolete list and keeps other entries', async () => {
      await fs.writeFile(path.join(dir, '.obsolete'), JSON.stringify({ 'Kalpy.vscode-ptt-0.5.0': true, 'other.ext-1.0.0': true }));

      assert.strictEqual(await clearObsoleteMarker(dir, 'kalpy.vscode-ptt-0.5.0'), true);
      assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(dir, '.obsolete'), 'utf8')), { 'other.ext-1.0.0': true });
    });

    it('deletes .obsolete when it becomes empty, and ignores a missing file', async () => {
      await fs.writeFile(path.join(dir, '.obsolete'), JSON.stringify({ 'kalpy.vscode-ptt-0.5.0': true }));
      assert.strictEqual(await clearObsoleteMarker(dir, 'kalpy.vscode-ptt-0.5.0'), true);
      await assert.rejects(fs.access(path.join(dir, '.obsolete')));
      assert.strictEqual(await clearObsoleteMarker(dir, 'kalpy.vscode-ptt-0.5.0'), false);
    });

    it('locates the code CLI next to the running VS Code', () => {
      assert.deepStrictEqual(cliCandidates('D:\\Microsoft VS Code\\resources\\app', 'win32').map(p => path.basename(p)), ['code.cmd', 'code.cmd']);
      assert.deepStrictEqual(cliCandidates('/usr/share/code/resources/app', 'linux'), [
        path.join('/usr/share/code/bin/code'),
        path.join('/usr/share/code/resources/app/bin/code')
      ]);
    });

    it('installs through VS Code\'s own installer when it accepts the VSIX', async () => {
      const original = mockVscode.commands.executeCommand;
      const calls: unknown[][] = [];
      mockVscode.commands.executeCommand = async (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      };
      try {
        const vsix = ({ fsPath: '/src/vscode-ptt.vsix' } as unknown as vscode.Uri);
        assert.strictEqual(await forceInstallVsix(vsix), 'workbench');
        assert.strictEqual(calls[0][0], 'workbench.extensions.installExtension');
        assert.strictEqual(calls[0][1], vsix);
      } finally {
        mockVscode.commands.executeCommand = original;
      }
    });

    it('falls back to the CLI with --force and reports both errors when that is unavailable', async () => {
      const original = mockVscode.commands.executeCommand;
      mockVscode.commands.executeCommand = async () => {
        throw new Error('already installed');
      };
      try {
        await assert.rejects(
          forceInstallVsix(({ fsPath: '/src/vscode-ptt.vsix' } as unknown as vscode.Uri)),
          /already installed；改用指令列 --force 也失敗：找不到 VS Code 的 code 指令/
        );
      } finally {
        mockVscode.commands.executeCommand = original;
      }
    });
  });

  it('the repository itself is detected as the fork source', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    assert.strictEqual(await findSourceFolder([repoRoot], 'kalpy.vscode-ptt'), repoRoot);
  });
});
