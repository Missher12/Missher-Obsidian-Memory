/**
 * 稳定的内容哈希，与运行时无关。
 *
 * 使用 SHA-256 的纯 TypeScript 实现，避免核心依赖 Node 的 `node:crypto`
 * 或浏览器的 `crypto.subtle`（后者是异步的，会污染同步提交路径）。
 * 这里只用于变更检测与幂等指纹，不用于密码学安全用途。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 计算 UTF-8 字符串的 SHA-256 十六进制摘要。 */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  /**
   * FIPS 180-4 填充：先补一个 0x80，再补 0 直到长度 ≡ 56 (mod 64)，
   * 最后追加 8 字节大端比特长度。
   *
   * 这里的块数必须**为长度字段留出空间**：`((len + 8) >> 6) + 1` 在
   * len ≡ 55 (mod 64) 时会多开一块。曾经写成 `((len + 9) >> 6) + 1`，
   * 于是 55、119 字节这类边界值的长度字段被写进了不存在的空间，
   * 摘要与标准实现不一致。边界（0/54/55/56/63/64/119/120）必须有回归测试。
   */
  const blocks = (((bytes.length + 8) >> 6) + 1) << 6;
  const withPad = new Uint8Array(blocks);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  // 64 位长度：高 32 位与低 32 位（大端）。
  view.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(withPad.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}

/** 计算短哈希（前 16 位十六进制），用于长度敏感的场景。 */
export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      } else {
        /**
         * 落单的高代理项不是合法 UTF-8 码位。WHATWG 编码标准（Node 的
         * `Buffer.from(str,'utf8')` 与 `TextEncoder` 都遵守）要求替换成
         * U+FFFD，而不是自行编造字节。这里照做，保证与 Node 逐字节一致。
         */
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 落单的低代理项同样替换。
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** 生成时间有序的随机 id。`rand` 可注入以便测试确定性。 */
export function createId(prefix: string, rand: () => number = Math.random): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const value = Math.floor(rand() * 16);
    out += hex[Math.min(15, Math.max(0, value))];
  }
  return `${prefix}_${out}`;
}
