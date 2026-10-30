// Entry point: HTTP API, SSE stream and the built judge UI on one port.
import { startServer, TICK_MS } from './server.ts';

const port = Number(process.env.PORT ?? 3000);
startServer(port);
console.log(`KEEL listening on http://localhost:${port} (tick ${TICK_MS} ms; all external systems are SIMULATED)`);
