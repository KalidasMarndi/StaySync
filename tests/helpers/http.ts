import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RunningServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** Starts an HTTP server on a random free port (127.0.0.1). */
export async function startServer(handler: RequestListener): Promise<RunningServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
