const { appendFileSync } = require('node:fs');

const traceFile = process.env.BENCH_RECONCILE_TRACE;
if (traceFile && process.argv.includes('--reconcile-tmux')) {
  appendFileSync(traceFile, `${Date.now()}\t${process.pid}\n`);
}
