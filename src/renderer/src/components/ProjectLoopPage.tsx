export default function ProjectLoopPage({ active }: { active: boolean }): JSX.Element {
  return <main className="loop-empty-page" aria-label="Loop" aria-hidden={!active} />
}
