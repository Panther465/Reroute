import { describe, expect, it } from 'vitest'
import { parseCommand } from './voice'

describe('parseCommand', () => {
  it('reads a delay in digits, words or hours', () => {
    expect(parseCommand("I'm running 20 minutes late")).toEqual({ kind: 'late', minutes: 20 })
    expect(parseCommand('Running about forty minutes late.')).toEqual({ kind: 'late', minutes: 40 })
    expect(parseCommand('The meeting is running half an hour over, I am late')).toEqual({ kind: 'late', minutes: 30 })
    expect(parseCommand('late by 15')).toEqual({ kind: 'late', minutes: 15 })
    expect(parseCommand('I need more time')).toEqual({ kind: 'late', minutes: null })
    expect(parseCommand("I'm an hour late")).toEqual({ kind: 'late', minutes: 60 })
    expect(parseCommand('I need ten more minutes')).toEqual({ kind: 'late', minutes: 10 })
  })

  it('a delay wins: "done, but late" is still a delay', () => {
    expect(parseCommand('almost done but 10 minutes late')).toEqual({ kind: 'late', minutes: 10 })
  })

  it('reads done, left, next and add', () => {
    expect(parseCommand('Meeting done')).toEqual({ kind: 'done' })
    expect(parseCommand("I've left the hotel")).toEqual({ kind: 'left' })
    expect(parseCommand('On my way')).toEqual({ kind: 'left' })
    expect(parseCommand("What's next?")).toEqual({ kind: 'next' })
    expect(parseCommand('When should I leave')).toEqual({ kind: 'next' })
    expect(parseCommand('Add lunch at one')).toEqual({ kind: 'add' })
  })

  it('says what it heard when it can’t tell', () => {
    expect(parseCommand('Tell me a joke')).toEqual({ kind: 'unknown', heard: 'Tell me a joke' })
  })
})
