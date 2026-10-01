const { appendFileSync } = require('node:fs');

const traceFile = process.env.BENCH_RECONCILE_TRACE;
if (traceFile && process.argv.includes('--reconcile-tmux')) {
  appendFileSync(traceFile, `S\t${Date.now()}\t${process.pid}\n`);
  process.on('exit', () => {
    const usage = process.cpuUsage();
    appendFileSync(traceFile, `E\t${Date.now()}\t${process.pid}\t${usage.user + usage.system}\n`);
  });
}
