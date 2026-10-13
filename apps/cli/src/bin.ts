import { run } from './cli';

const tty = process.stderr.isTTY;
let lastStatus = false;

const interrupted = new Promise<void>((resolve) => {
  process.once('SIGINT', () => {
    process.stderr.write('\n');
    resolve();
  });
});

void run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => {
    if (lastStatus) process.stderr.write('\r\x1b[K');
    lastStatus = false;
    process.stderr.write(`${line}\n`);
  },
  status: tty
    ? (line) => {
        process.stderr.write(`\r\x1b[K${line}`);
        lastStatus = line !== '';
      }
    : undefined,
  env: process.env,
  cwd: process.cwd(),
  interrupted,
}).then((code) => process.exit(code));
