import { beforeEach, describe, expect, it, vi } from 'vitest'

const share = vi.hoisted(() => ({ share: vi.fn() }))
const fs = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('@capacitor/share', () => ({ Share: share }))
vi.mock('@capacitor/filesystem', () => ({ Filesystem: fs, Directory: { Documents: 'DOCUMENTS', Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' } }))

import { nthName, saveText, shareText } from './share'

beforeEach(() => vi.clearAllMocks())

describe('sharing in the app', () => {
  it("opens Android's share sheet", async () => {
    share.share.mockResolvedValue({ activityType: 'com.whatsapp' })
    await expect(shareText('Running 10 min late', 'Travel expenses')).resolves.toBe('shared')
    expect(share.share).toHaveBeenCalledWith({ text: 'Running 10 min late', title: 'Travel expenses', dialogTitle: 'Travel expenses' })
  })

  it('tells a dismissed sheet from a failure', async () => {
    share.share.mockRejectedValue(new Error('Share canceled'))
    await expect(shareText('x')).resolves.toBe('cancelled')
    share.share.mockRejectedValue(new Error('No app to share with'))
    await expect(shareText('x')).resolves.toBe('failed')
  })

  it('saves the expense slip to Documents/Reroute', async () => {
    fs.writeFile.mockResolvedValue({ uri: 'file:///storage/emulated/0/Documents/Reroute/slip.txt' })
    await expect(saveText('slip.txt', 'Fares: Rs 210')).resolves.toBe('Documents/Reroute/slip.txt')
    expect(fs.writeFile).toHaveBeenCalledWith({ path: 'Reroute/slip.txt', data: 'Fares: Rs 210', directory: 'DOCUMENTS', encoding: 'utf8', recursive: true })
  })

  it('saves under the next name when an earlier install left one it may not overwrite, as a browser names downloads', async () => {
    fs.writeFile.mockRejectedValueOnce(new Error('EACCES (Permission denied)')).mockResolvedValueOnce({ uri: 'file:///Documents/Reroute/slip (1).txt' })
    await expect(saveText('slip.txt', 'Fares: Rs 210')).resolves.toBe('Documents/Reroute/slip (1).txt')
    expect(fs.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'Reroute/slip (1).txt', directory: 'DOCUMENTS' }))
    expect(nthName('slip.txt', 2)).toBe('slip (2).txt')
    expect(nthName('slip', 1)).toBe('slip (1)')
  })

  it("hands the file to the share sheet where Android won't allow Documents at all", async () => {
    for (let i = 0; i < 5; i++) fs.writeFile.mockRejectedValueOnce(new Error('Permission denied'))
    fs.writeFile.mockResolvedValueOnce({ uri: 'file:///cache/slip.txt' })
    share.share.mockResolvedValue({})
    await expect(saveText('slip.txt', 'Fares: Rs 210')).resolves.toBe('the place you picked')
    expect(share.share).toHaveBeenCalledWith({ files: ['file:///cache/slip.txt'], dialogTitle: 'Save the expense slip' })
    fs.writeFile.mockRejectedValue(new Error('Disk full'))
    await expect(saveText('slip.txt', 'x')).resolves.toBeNull()
  })
})
