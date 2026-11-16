import { decodeSync } from 'uao-js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const decodeBig5 = (data: number[] | Uint8Array): string => {
  let binary = '';
  // Avoid spreading large arrays into String.fromCharCode (stack overflow on big screens)
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return decodeSync(binary);
};

/**
 * Decode a chunk received from PTT.
 *
 * PTT switches to UTF-8 only after the "username," trick takes effect; the welcome
 * screen and some login error messages (e.g. 密碼不對或無此帳號) are still sent in Big5.
 * In utf8 mode we therefore decode strictly as UTF-8 and fall back to Big5 when the
 * bytes are not valid UTF-8.
 */
const decode = (data: number[] | Uint8Array, charset: string): string => {
  switch (charset.toLowerCase()) {
    case 'utf8':
    case 'utf-8': {
      const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
      try {
        return utf8Decoder.decode(bytes);
      } catch {
        return decodeBig5(bytes);
      }
    }
    case 'big5':
      return decodeBig5(data);
    default:
      throw new TypeError(`Unknown charset: ${charset}`);
  }
};

export default decode;
