import { defineConfig } from 'vite';

// Room traffic (/ws) and the game preview (/preview) go through the app's own address,
// so one port (or one tunnel) covers the page, the room server, and the running game.
const proxy = {
  '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
  '/preview': { target: 'http://127.0.0.1:8787' },
  '/auth': { target: 'http://127.0.0.1:8787' },
};
const allowedHosts = ['.trycloudflare.com'];

export default defineConfig({
  server: { port: 5174, strictPort: true, host: true, proxy, allowedHosts },
  preview: { port: 4173, strictPort: true, host: true, proxy, allowedHosts },
});
