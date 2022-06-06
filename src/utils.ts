import usx from 'unishox2.siara.cc'

/**
 * Compress a string using the Unishox 2 compression algorithm.
 *
 * @param str
 * @returns {Buffer} the compress string as binary
 */
export function compress (str: string) {
  const uint8arr = new Uint8Array(str.length + 10)
  const length = usx.unishox2_compress_simple(str, str.length, uint8arr)
  return Buffer.from(uint8arr.subarray(0, length))
}

/**
 * Decompress a buffer encoded with the Unishox 2 compression algorithm.
 *
 * @param buffer
 * @returns {string} the decompressed string
 */
export function decompress (buffer: Buffer) {
  return usx.unishox2_decompress_simple(buffer, buffer.length)
}
