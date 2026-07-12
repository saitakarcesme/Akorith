import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProductErrorBoundary from '../../src/renderer/src/components/ProductErrorBoundary'

let shouldThrow = true
function Unstable(): JSX.Element {
  if (shouldThrow) throw new Error('measured render failure')
  return <div>Recovered content</div>
}

describe('ProductErrorBoundary', () => {
  afterEach(() => { shouldThrow = true; vi.restoreAllMocks() })

  it('contains a product surface failure and supports retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<ProductErrorBoundary name="Loop"><Unstable /></ProductErrorBoundary>)
    expect(screen.getByRole('heading', { name: 'Loop needs to reload' })).toBeInTheDocument()
    expect(screen.getByText('measured render failure')).toBeInTheDocument()
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Recovered content')).toBeInTheDocument()
  })
})
