/** A minimal Borsh writer and reader: little-endian integers, u32-length strings and byte vectors, no padding. */

export class BorshWriter {
  #parts: Uint8Array[] = [];

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error("u8 out of range");
    this.#parts.push(Uint8Array.of(v));
    return this;
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error("u32 out of range");
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.#parts.push(b);
    return this;
  }

  #uint(v: bigint, bytes: number, what: string): this {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`${what} out of range`);
    const b = new Uint8Array(bytes);
    let x = v;
    for (let i = 0; i < bytes; i++) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.#parts.push(b);
    return this;
  }

  u64(v: bigint): this {
    return this.#uint(v, 8, "u64");
  }

  u128(v: bigint): this {
    return this.#uint(v, 16, "u128");
  }

  /** Fixed-size bytes, written as they are. */
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    this.#parts.push(b);
    return this;
  }

  /** `Vec<u8>`: u32 length, then the bytes. */
  bytes(b: Uint8Array): this {
    this.u32(b.length);
    this.#parts.push(b);
    return this;
  }

  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }

  done(): Uint8Array {
    const len = this.#parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of this.#parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class BorshReader {
  #b: Uint8Array;
  #o = 0;

  constructor(b: Uint8Array) {
    this.#b = b;
  }

  #take(n: number): Uint8Array {
    if (this.#o + n > this.#b.length) throw new Error("unexpected end of Borsh data");
    const s = this.#b.subarray(this.#o, this.#o + n);
    this.#o += n;
    return s;
  }

  u8(): number {
    return this.#take(1)[0]!;
  }

  u32(): number {
    const s = this.#take(4);
    return new DataView(s.buffer, s.byteOffset, 4).getUint32(0, true);
  }

  #uint(bytes: number): bigint {
    const s = this.#take(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(s[i]!);
    return v;
  }

  u64(): bigint {
    return this.#uint(8);
  }

  u128(): bigint {
    return this.#uint(16);
  }

  fixed(n: number): Uint8Array {
    return this.#take(n).slice();
  }

  bytes(): Uint8Array {
    return this.#take(this.u32()).slice();
  }

  string(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes());
  }

  /** Throws unless every byte was read. */
  end(): void {
    if (this.#o !== this.#b.length) throw new Error(`${this.#b.length - this.#o} trailing bytes`);
  }
}
