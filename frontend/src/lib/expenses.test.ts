import { describe, expect, it } from 'vitest'
import { categoryOf, paise, paiseField, paymentOf, toPaise } from './expenses'

describe('money in paise', () => {
  it('reads the Indian way, with paise only when there are some', () => {
    expect([0, 5000, 61250, 12405000, 1234567800, -2500].map(paise)).toEqual(['₹0', '₹50', '₹612.50', '₹1,24,050', '₹1,23,45,678', '-₹25'])
  })

  it('takes what people type in an amount field', () => {
    expect(['350', '612.50', '612.5', '₹1,240', 'Rs. 99', ' 45 '].map(toPaise)).toEqual([35000, 61250, 61250, 124000, 9900, 4500])
    expect(['', 'abc', '0', '1.234', '-5', '10000000'].map(toPaise)).toEqual([null, null, null, null, null, null])
  })

  it('shows an amount back in its field', () => {
    expect([35000, 61250, null, undefined].map(paiseField)).toEqual(['350', '612.50', '', ''])
  })

  it('names every category and way to pay', () => {
    expect(categoryOf('communication').label).toBe('Phone and internet')
    expect(paymentOf('company').label).toBe('Company paid')
  })
})
