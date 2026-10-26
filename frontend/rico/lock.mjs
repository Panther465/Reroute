// Rico's art (rico/files.txt: his Blender model and its scripts, the sheets of his rendered pieces, his stills, his
// picture on Android) is kept in the repository only as rico/rico.pack, encrypted with AES-256-GCM. Anyone can
// download the repository; only someone with the key can open the pack. The key, RICO_KEY (64 hex characters), is
// read from the environment or else from the nearest .env above this folder, and never goes in git.
//
//   node rico/lock.mjs unlock [--quiet]  writes the files from the pack where the app and Blender expect them.
//                                        Builds run it first; without the key it changes nothing, and the app is
//                                        built with a plain stand-in for Rico.
//   node rico/lock.mjs lock              packs the files again after changing them (the pack is rewritten only
//                                        when something changed).
//   node rico/lock.mjs key               makes a new key (printed once: keep it safe; it can't be recovered).
//   node rico/lock.mjs status            says whether the key is there and the files match the pack.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const PACK = join(HERE, 'rico.pack')
const MAGIC = Buffer.from('RICO1\n')

/** The files listed in files.txt (paths from frontend/, `*` within one folder) that are here on disk. */
export function listed(root = FRONTEND, list = readFileSync(join(HERE, 'files.txt'), 'utf8')) {
  const out = []
  for (const raw of list.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!line.includes('*')) {
      if (existsSync(join(root, line))) out.push(line)
      continue
    }
    const dir = dirname(line)
    const pattern = new RegExp(`^${line.slice(dir.length + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
    if (!existsSync(join(root, dir))) continue
    for (const name of readdirSync(join(root, dir)).sort()) if (pattern.test(name)) out.push(`${dir}/${name}`)
  }
  return out
}

/** RICO_KEY from the environment (set but empty: no key), else from the nearest .env above frontend/. */
export function findKey(env = process.env, start = FRONTEND) {
  if (env.RICO_KEY !== undefined) return env.RICO_KEY.trim() || null
  for (let dir = start; ; dir = dirname(dir)) {
    const file = join(dir, '.env')
    if (existsSync(file)) {
      const m = readFileSync(file, 'utf8').match(/^\s*RICO_KEY\s*=\s*"?([0-9a-fA-F]{64})"?\s*$/m)
      if (m) return m[1]
    }
    if (dirname(dir) === dir) return null
  }
}

function keyBytes(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('RICO_KEY must be 64 hex characters (node rico/lock.mjs key makes one).')
  return Buffer.from(hex, 'hex')
}

/** Files (name → bytes) into one sealed pack: the magic, a fresh nonce, the tag, then the compressed files. */
export function seal(files, hex) {
  const parts = []
  for (const [name, data] of files) {
    const n = Buffer.from(name, 'utf8')
    const head = Buffer.alloc(6)
    head.writeUInt16BE(n.length, 0)
    head.writeUInt32BE(data.length, 2)
    parts.push(head, n, data)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(hex), iv)
  const body = Buffer.concat([cipher.update(deflateRawSync(Buffer.concat(parts), { level: 9 })), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

/** A sealed pack back into its files; throws when the key is wrong or the pack was changed. */
export function open(pack, hex) {
  if (!pack.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('rico.pack is not a Rico pack.')
  const iv = pack.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = pack.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(hex), iv)
  decipher.setAuthTag(tag)
  let plain
  try {
    plain = inflateRawSync(Buffer.concat([decipher.update(pack.subarray(MAGIC.length + 28)), decipher.final()]))
  } catch {
    throw new Error("RICO_KEY doesn't open rico.pack: a different key, or the pack was changed.")
  }
  const files = new Map()
  for (let at = 0; at < plain.length; ) {
    const n = plain.readUInt16BE(at)
    const size = plain.readUInt32BE(at + 2)
    const name = plain.subarray(at + 6, at + 6 + n).toString('utf8')
    files.set(name, plain.subarray(at + 6 + n, at + 6 + n + size))
    at += 6 + n + size
  }
  return files
}

/** A file named in the pack, on disk; never outside frontend/. */
function inside(name) {
  const full = resolve(FRONTEND, name)
  const rel = relative(FRONTEND, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Not under frontend/: ${name}`)
  return full
}

function unlock(quiet) {
  const have = listed()
  const hex = findKey()
  if (!hex) {
    if (!quiet || have.length === 0) console.log(have.length ? "Rico's art is here (no RICO_KEY to check it against the pack)." : "Rico's art is locked (no RICO_KEY): building with a plain stand-in for Rico.")
    return
  }
  const files = open(readFileSync(PACK), hex)
  let wrote = 0
  for (const [name, data] of files) {
    const full = inside(name)
    if (existsSync(full) && readFileSync(full).equals(data)) continue
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, data)
    wrote++
  }
  if (!quiet || wrote) console.log(`Rico's art unlocked: ${files.size} files, ${wrote} written.`)
}

function lock() {
  const hex = findKey()
  if (!hex) throw new Error('No RICO_KEY: set it in the .env at the repository root (node rico/lock.mjs key makes one).')
  const names = listed()
  if (names.length === 0) throw new Error('None of the files in rico/files.txt are here to lock.')
  const files = new Map(names.map((name) => [name, readFileSync(inside(name))]))
  if (existsSync(PACK)) {
    const before = open(readFileSync(PACK), hex)
    const same = before.size === files.size && [...files].every(([name, data]) => before.get(name)?.equals(data))
    if (same) return console.log(`rico.pack already holds these ${files.size} files.`)
  }
  writeFileSync(PACK, seal(files, hex))
  console.log(`rico.pack sealed: ${files.size} files.`)
}

function status() {
  const hex = findKey()
  const names = listed()
  console.log(`Key: ${hex ? 'found' : 'none'}. Files here: ${names.length}. Pack: ${existsSync(PACK) ? 'present' : 'missing'}.`)
  if (!hex || !existsSync(PACK)) return
  const files = open(readFileSync(PACK), hex)
  const differ = [...files].filter(([name, data]) => !existsSync(inside(name)) || !readFileSync(inside(name)).equals(data)).map(([name]) => name)
  const extra = names.filter((name) => !files.has(name))
  console.log(differ.length || extra.length ? `Not matching the pack: ${[...differ, ...extra].join(', ')} (lock or unlock).` : 'The files match the pack.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [what, flag] = process.argv.slice(2)
  try {
    if (what === 'unlock') unlock(flag === '--quiet')
    else if (what === 'lock') lock()
    else if (what === 'status') status()
    else if (what === 'key') console.log(randomBytes(32).toString('hex'))
    else {
      console.log('Usage: node rico/lock.mjs unlock [--quiet] | lock | status | key')
      process.exitCode = 2
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
