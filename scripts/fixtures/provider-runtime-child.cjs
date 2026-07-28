const mode = process.argv[2]

if (mode === 'stall') {
  process.stdout.write('ready\n')
  setTimeout(() => process.exit(0), 2_000)
} else if (mode === 'pulse') {
  let count = 0
  const timer = setInterval(() => {
    process.stdout.write(`pulse-${++count}\n`)
    if (count === 5) {
      clearInterval(timer)
      process.exit(0)
    }
  }, 80)
} else if (mode === 'resume') {
  process.stdout.write('before-pause\n')
  setTimeout(() => {
    process.stdout.write('after-pause\n')
    process.exit(0)
  }, 260)
} else {
  process.stderr.write('unknown fixture mode\n')
  process.exit(2)
}
