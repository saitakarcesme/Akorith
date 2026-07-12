import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ProductErrorBoundaryProps { name: string; children: ReactNode }
interface ProductErrorBoundaryState { error: string | null; resetKey: number }

export default class ProductErrorBoundary extends Component<ProductErrorBoundaryProps, ProductErrorBoundaryState> {
  state: ProductErrorBoundaryState = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: unknown): Partial<ProductErrorBoundaryState> {
    return { error: error instanceof Error ? error.message : 'This surface could not be rendered.' }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[renderer:${this.props.name}]`, error.message, info.componentStack)
  }

  private reset = (): void => this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }))

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="product-error-boundary" role="alert">
          <span>Akorith</span>
          <h1>{this.props.name} needs to reload</h1>
          <p>{this.state.error}</p>
          <button type="button" onClick={this.reset}>Try again</button>
        </main>
      )
    }
    return <div key={this.state.resetKey} className="product-error-content">{this.props.children}</div>
  }
}
