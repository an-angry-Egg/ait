#!/usr/bin/env node
import { run } from '../src/cli.js'

run(process.argv.slice(2)).catch((err) => {
  console.error('\n启动失败：', err?.message ?? err)
  if (process.env.AIT_DEBUG) console.error(err)
  process.exit(1)
})
