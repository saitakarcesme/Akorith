import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandModal, PrimaryButton } from '../../src/renderer/src/components/CreationPrimitives'

describe('creation primitives', () => {
  it('renders an accessible primary action', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<PrimaryButton onClick={onClick}>Create loop</PrimaryButton>)

    await user.click(screen.getByRole('button', { name: 'Create loop' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('closes a command modal with Escape', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <CommandModal ariaLabel="Create loop" onClose={onClose}>
        <p>Choose a project</p>
      </CommandModal>
    )

    expect(screen.getByRole('dialog', { name: 'Create loop' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
