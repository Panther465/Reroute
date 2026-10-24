import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { City } from '@/api/types'
import { CityPicker } from './CityPicker'

const city = (slug: string, name: string, state: string, lng: number, lat: number): City => ({ slug, name, state, sample: false, lng, lat, bbox: [lng - 0.2, lat - 0.2, lng + 0.2, lat + 0.2] })
const EVERY = [city('ahmedabad', 'Ahmedabad', 'Gujarat', 72.5797, 23.0216), city('pune', 'Pune', 'Maharashtra', 73.8545, 18.5214), city('surat', 'Surat', 'Gujarat', 72.8311, 21.1959)]

afterEach(() => vi.restoreAllMocks())

describe('choosing a city from the list', () => {
  it('loads every city only when the list opens, by state, and picks one with where it is', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(EVERY)
    const onChange = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CityPicker value={null} onChange={onChange} />
      </QueryClientProvider>,
    )
    expect(get).not.toHaveBeenCalled()
    const list = screen.getByText('Or choose from the list').closest('details')!
    list.open = true
    fireEvent(list, new Event('toggle'))
    const gujarat = await screen.findByRole('region', { name: 'Gujarat' })
    expect(get).toHaveBeenCalledWith('/v1/cities')
    expect(within(gujarat).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ahmedabad', 'Surat'])
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Gujarat', 'Maharashtra'])
    fireEvent.click(screen.getByRole('button', { name: 'Pune' }))
    expect(onChange).toHaveBeenCalledWith(EVERY[1])
  })
})
