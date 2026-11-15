// Research-only Next server: pinned upstream stamps the actual accepted TCP peer.
import { createServer } from 'node:http';
import next from 'next';
import { ensurePeerStampToken, wrapRequestListenerWithPeerStamp } from '/work/app/scripts/dev/peer-stamp.mjs';

ensurePeerStampToken();
const app = next({ dev: false, hostname: '127.0.0.1', port: 43180, dir: '/work/app' });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer(wrapRequestListenerWithPeerStamp((req, res) => handler(req, res)));
server.listen(43180, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
