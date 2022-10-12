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

/**
  * Calculates the least significant 2-bytes of the
  * summation of the entire buffer/message.
  *
  * @param buffer
  */
export function calculateChecksum (buffer: Buffer) {
  const checksum = Buffer.alloc(2)

  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i]
  }

  // set the least significant byte of the message summation
  checksum[1] = sum & 0xff

  // drop the least significant byte
  sum >>= 8

  // set the (second) least significant byte of the message summation
  checksum[0] = sum & 0xff

  return checksum
}
