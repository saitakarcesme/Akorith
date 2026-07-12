'use strict'

const { resolve } = require('node:path')

const script = process.argv[2]
if (!script) throw new Error('Electron TypeScript runner requires a script path')

require('tsx/cjs')
require(resolve(script))
