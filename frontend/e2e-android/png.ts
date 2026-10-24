import { inflateSync } from 'node:zlib'

// Just enough PNG to read one pixel of an Android screenshot (8-bit RGB or RGBA, not interlaced).
export const PNG = {
  /** The pixel at `xFraction` of the width and `y` pixels down, as [r, g, b]. */
  pixel(png: Buffer, xFraction: number, y: number): [number, number, number] {
    let pos = 8
    let width = 0
    let colorType = 0
    const idat: Buffer[] = []
    while (pos < png.length) {
      const length = png.readUInt32BE(pos)
      const type = png.toString('ascii', pos + 4, pos + 8)
      const data = png.subarray(pos + 8, pos + 8 + length)
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        if (data[8] !== 8 || data[12] !== 0) throw new Error('Only 8-bit, non-interlaced PNGs')
        colorType = data[9]
      } else if (type === 'IDAT') idat.push(data)
      else if (type === 'IEND') break
      pos += 12 + length
    }
    const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
    if (!bpp) throw new Error('Only RGB and RGBA PNGs')
    const raw = inflateSync(Buffer.concat(idat))
    const stride = width * bpp
    let prev = Buffer.alloc(stride)
    let line = Buffer.alloc(stride)
    // Undo each scanline's filter, up to the row asked for.
    for (let row = 0; row <= y; row++) {
      const filter = raw[row * (stride + 1)]
      const src = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
      line = Buffer.alloc(stride)
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
        const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth : 0
        line[i] = (src[i] + add) & 0xff
      }
      prev = line
    }
    const x = Math.min(width - 1, Math.floor(width * xFraction)) * bpp
    return [line[x], line[x + 1], line[x + 2]]
  },
}
