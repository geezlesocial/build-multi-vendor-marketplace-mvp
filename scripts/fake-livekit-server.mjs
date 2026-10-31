import http from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.E2E_LIVEKIT_PORT ?? 9399);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Fake LiveKit port must be an unprivileged TCP port.');

const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (request.method === 'POST' && request.url === '/twirp/livekit.RoomService/ListRooms') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"rooms":[]}');
    return;
  }

  if (request.method === 'POST' && request.url === '/twirp/livekit.RoomService/ListParticipants') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"participants":[]}');
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end('{"code":"not_found","msg":"Local LiveKit simulator endpoint is not implemented."}');
});

server.listen(port, '127.0.0.1');
server.on('error', error => {
  process.stderr.write(`Local LiveKit simulator failed to bind on 127.0.0.1:${port}: ${error.message}\n`);
  process.exitCode = 1;
});
