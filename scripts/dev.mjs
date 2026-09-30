// Starts the room server and the web app together.
// Pass --preview to serve the built app (npm run share) instead of the dev server.
//
// Ctrl+C reaches both programs. The room server then finishes saving open work before it exits,
// so this script waits for both to finish instead of killing them.
import { spawn } from 'node:child_process';

const viteArgs = process.argv.includes('--preview') ? ['preview'] : [];

const children = [
  spawn(process.execPath, ['server/server.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...viteArgs], { stdio: 'inherit' }),
];

if (process.argv.includes('--codex')) {
  children.push(spawn(process.execPath, ['scripts/codex-bridge.mjs'], { stdio: 'inherit' }));
}

let interrupted = false;
const exited = new Set();
const forceStop = () => children.forEach((child) => child.kill());

function onInterrupt() {
  interrupted = true;
  // If saving hangs, stop everything after a while anyway.
  setTimeout(forceStop, 25_000).unref();
}

process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);

children.forEach((child) =>
  child.on('exit', (code) => {
    exited.add(child);
    // One program crashed on its own: stop the other too.
    if (!interrupted) forceStop();
    if (exited.size === children.length) process.exit(code ?? 0);
  }),
);
