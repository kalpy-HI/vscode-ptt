import assert from 'node:assert';
import decode from '../src/utils/decode';
import encode from '../src/utils/encode';

describe('decode', () => {
  it('decodes UTF-8 in utf8 mode', () => {
    const bytes = encode('請改用網頁版 https://www.ptt.cc', 'utf8');
    assert.strictEqual(decode(bytes, 'utf8'), '請改用網頁版 https://www.ptt.cc');
  });

  it('falls back to Big5 when utf8 mode receives Big5 bytes (welcome screen / login errors)', () => {
    const text = '密碼不對或無此帳號。請檢查大小寫及有無輸入錯誤。';
    const big5 = encode(text, 'big5');
    assert.strictEqual(decode(big5, 'utf8'), text);
  });

  it('keeps ANSI escape sequences intact on Big5 fallback', () => {
    const text = '\x1b[1;33m請輸入代號，或以 guest 參觀，或以 new 註冊:\x1b[m';
    assert.strictEqual(decode(encode(text, 'big5'), 'utf8'), text);
  });

  it('accepts plain number arrays as produced by the socket', () => {
    const arr = Array.from(encode('作者', 'big5'));
    assert.strictEqual(decode(arr, 'utf8'), '作者');
    assert.strictEqual(decode(arr, 'big5'), '作者');
  });

  it('handles large payloads without overflowing the call stack', () => {
    const text = '推'.repeat(200_000);
    assert.strictEqual(decode(encode(text, 'big5'), 'big5').length, 200_000);
  });

  it('throws on unknown charset', () => {
    assert.throws(() => decode([0x41], 'latin1'), /Unknown charset/);
  });
});
