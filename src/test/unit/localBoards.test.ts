import assert from 'node:assert';
import {
  LocalBoards,
  LOCAL_BOARDS_KEY,
  normalizeBoardNames,
  parseLocalBoardsImport
} from '../../localBoards';

function memento(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: <T>(key: string, defaultValue?: T) => (key in data ? data[key] as T : defaultValue),
    update: async (key: string, value: unknown) => {
      data[key] = value;
    }
  };
}

describe('LocalBoards (本地喜愛看板)', () => {
  it('normalizes names: trims, drops invalid entries and case-insensitive duplicates', () => {
    assert.deepStrictEqual(
      normalizeBoardNames([' C_Chat ', 'c_chat', 'Stock', '', '壞掉', '../etc', 42, null, 'Tech_Job']),
      ['C_Chat', 'Stock', 'Tech_Job']
    );
  });

  it('reads the legacy boardlist key so existing subscriptions are kept', () => {
    const state = memento({ [LOCAL_BOARDS_KEY]: ['Gossiping', 'C_Chat', 'Gossiping'] });
    assert.deepStrictEqual(new LocalBoards(state).list(), ['Gossiping', 'C_Chat']);
  });

  it('adds boards without duplicates and reports which were new', async () => {
    const state = memento({ [LOCAL_BOARDS_KEY]: ['C_Chat'] });
    const boards = new LocalBoards(state);
    const added = await boards.add(['c_chat', 'Stock', 'Stock', 'NBA']);
    assert.deepStrictEqual(added, ['Stock', 'NBA']);
    assert.deepStrictEqual(state.data[LOCAL_BOARDS_KEY], ['C_Chat', 'Stock', 'NBA']);
    assert.strictEqual(boards.has('stock'), true);
  });

  it('removes boards case-insensitively', async () => {
    const state = memento({ [LOCAL_BOARDS_KEY]: ['C_Chat', 'Stock'] });
    const boards = new LocalBoards(state);
    assert.strictEqual(await boards.remove('c_chat'), true);
    assert.strictEqual(await boards.remove('nope'), false);
    assert.deepStrictEqual(boards.list(), ['Stock']);
  });

  it('exports a versioned JSON document that imports back', () => {
    const boards = new LocalBoards(memento({ [LOCAL_BOARDS_KEY]: ['C_Chat', 'Stock'] }));
    const exported = boards.toExport(new Date('2026-11-16T00:00:00Z'));
    assert.deepStrictEqual(exported, {
      app: 'vscode-ptt',
      version: 1,
      exportedAt: '2026-11-16T00:00:00.000Z',
      boards: ['C_Chat', 'Stock']
    });
    assert.deepStrictEqual(parseLocalBoardsImport(JSON.stringify(exported)), ['C_Chat', 'Stock']);
  });

  it('imports plain JSON arrays and one-board-per-line text', () => {
    assert.deepStrictEqual(parseLocalBoardsImport('["NBA", "Baseball"]'), ['NBA', 'Baseball']);
    assert.deepStrictEqual(parseLocalBoardsImport('\uFEFFNBA\r\nBaseball\n\nnba\n'), ['NBA', 'Baseball']);
    assert.deepStrictEqual(parseLocalBoardsImport(''), []);
  });

  it('rejects malformed JSON with a readable error', () => {
    assert.throws(() => parseLocalBoardsImport('{ broken'), /不是有效的 JSON/);
    assert.throws(() => parseLocalBoardsImport('{"foo": 1}'), /boards/);
  });
});
