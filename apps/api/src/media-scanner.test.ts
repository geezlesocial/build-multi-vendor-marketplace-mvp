import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, MediaScannerError } from './media-scanner.js';

const servers: Array<{ server: net.Server; sockets: Set<net.Socket> }> = [];

async function listen(handler: (socket: net.Socket) => void, allowHalfOpen = false) {
  const server = net.createServer({ allowHalfOpen }, handler);
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  servers.push({ server, sockets });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test scanner did not bind a TCP port');
  return { host: '127.0.0.1', port: address.port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server, sockets }) => new Promise<void>(resolve => {
    server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  })));
});

describe('ClamAV INSTREAM adapter', () => {
  it('sends framed bytes and maps an OK response to clean', async () => {
    let received = Buffer.alloc(0);
    const endpoint = await listen(socket => {
      socket.on('data', chunk => { received = Buffer.concat([received, chunk]); });
      socket.on('end', () => socket.end(Buffer.from('stream: OK\0')));
    });
    const payload = Buffer.from('synthetic harmless fixture');
    await expect(new ClamAvScanner(endpoint.host, endpoint.port, 1000).scan(payload)).resolves.toBe('CLEAN');
    expect(received.subarray(0, 10)).toEqual(Buffer.from('zINSTREAM\0'));
    expect(received.readUInt32BE(10)).toBe(payload.length);
    expect(received.subarray(14, 14 + payload.length)).toEqual(payload);
    expect(received.subarray(-4)).toEqual(Buffer.alloc(4));
  });

  it('maps a scanner FOUND response to infected', async () => {
    const endpoint = await listen(socket => {
      socket.on('data', () => undefined);
      socket.on('end', () => socket.end(Buffer.from('stream: Synthetic-Test-Signature FOUND\0')));
    });
    await expect(new ClamAvScanner(endpoint.host, endpoint.port, 1000).scan(Buffer.from('synthetic infected fixture'))).resolves.toBe('INFECTED');
  });

  it('fails closed for malformed scanner responses and timeouts', async () => {
    const malformed = await listen(socket => {
      socket.on('data', () => undefined);
      socket.on('end', () => socket.end(Buffer.from('unexpected response\0')));
    });
    await expect(new ClamAvScanner(malformed.host, malformed.port, 1000).scan(Buffer.from('fixture'))).rejects.toMatchObject({ safeCode: 'SCANNER_ERROR' });

    const silent = await listen(socket => { socket.on('data', () => undefined); }, true);
    await expect(new ClamAvScanner(silent.host, silent.port, 100).scan(Buffer.from('fixture'))).rejects.toMatchObject({ safeCode: 'SCANNER_TIMEOUT' });
    expect(new MediaScannerError('SCANNER_UNAVAILABLE', 'safe').safeCode).toBe('SCANNER_UNAVAILABLE');
  });
});
