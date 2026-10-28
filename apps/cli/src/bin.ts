import { createInterface } from 'node:readline';
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
  ask: process.stdin.isTTY
    ? (question) =>
        new Promise((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          // readline takes Ctrl+C for itself; hand it on so the command stops as usual.
          rl.on('SIGINT', () => {
            rl.close();
            process.emit('SIGINT');
          });
          // Ctrl+D closes the prompt without an answer: that is a no.
          rl.on('close', () => resolve(''));
          rl.question(question, (answer) => {
            // Resolve first: closing the prompt emits 'close', which means no answer.
            resolve(answer);
            rl.close();
          });
        })
    : undefined,
}).then((code) => process.exit(code));
