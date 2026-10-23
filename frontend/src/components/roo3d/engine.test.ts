import { describe, expect, it } from 'vitest'
import { REST, type MouthParams } from '@/lib/roo/lipsync/mouth'
import { POSES } from '@/lib/roo/lipsync/visemes'
import { armPoses, mouthPoints, pickSheet, project, turn } from './engine'
import { PIECES } from './rig'

describe('the rendered Roo', () => {
  it('cuts every mouth it makes from its rendered felt, however its head is turned', () => {
    const mouths: MouthParams[] = [
      REST,
      ...Object.values(POSES),
      { open: 0.55, wide: 0.45, round: 0, smile: 1 },
      { open: 0.75, wide: 0.5, round: 0, smile: 1 },
      { open: 0.35, wide: -0.4, round: 1, smile: 0 },
      { open: 1, wide: 1, round: 0, smile: 1 },
    ]
    const felt = PIECES['Felt Black']
    const [x, y, w, h] = felt.rect
    for (const yaw of [-0.24, 0, 0.24]) {
      for (const pitch of [-0.12, 0, 0.155]) {
        // The felt slides with the head, as the mouth does.
        const [ax, ay] = project(felt.anchor!)
        const [bx, by] = project(turn(felt.anchor!, yaw, pitch))
        for (const m of mouths) {
          for (const [px, py] of mouthPoints(m, yaw, pitch)) {
            expect(px - (bx - ax)).toBeGreaterThan(x + 2)
            expect(px - (bx - ax)).toBeLessThan(x + w - 2)
            expect(py - (by - ay)).toBeGreaterThan(y + 2)
            expect(py - (by - ay)).toBeLessThan(y + h - 2)
          }
        }
      }
    }
  })

  it('puts each face piece where it was rendered', () => {
    for (const [key, piece] of Object.entries(PIECES)) {
      if (!piece.anchor) continue
      const [px, py] = project(piece.anchor)
      const [x, y, w, h] = piece.rect
      expect(px, key).toBeGreaterThan(x)
      expect(px, key).toBeLessThan(x + w)
      expect(py, key).toBeGreaterThan(y)
      expect(py, key).toBeLessThan(y + h)
    }
  })

  it('loads the smallest sheet sharp enough for its size', () => {
    expect(pickSheet(35)).toBe('sm')
    expect(pickSheet(100)).toBe('md')
    expect(pickSheet(190)).toBe('lg')
    expect(pickSheet(600)).toBe('lg')
  })

  it('blends an arm between the poses either side of it', () => {
    expect(armPoses('R', 0)).toEqual({ a: 'arm.R.0', b: 'arm.R.1', t: 0 })
    expect(armPoses('L', -0.04)).toEqual({ a: 'arm.L.0', b: 'arm.L.1', t: 0 })
    const mid = armPoses('R', 0.9)
    expect(mid.a).toBe('arm.R.1')
    expect(mid.b).toBe('arm.R.2')
    expect(mid.t).toBeCloseTo((0.9 - PIECES['arm.R.1'].raise!) / (PIECES['arm.R.2'].raise! - PIECES['arm.R.1'].raise!))
    expect(armPoses('R', 2.5)).toEqual({ a: 'arm.R.2', b: 'arm.R.3', t: 1 })
  })
})
