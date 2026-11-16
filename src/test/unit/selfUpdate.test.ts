import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findSourceFolder, isForkSource, readPackageInfo } from '../../selfUpdate';

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

  it('the repository itself is detected as the fork source', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    assert.strictEqual(await findSourceFolder([repoRoot], 'kalpy.vscode-ptt'), repoRoot);
  });
});
