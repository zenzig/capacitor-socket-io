import { createServer } from 'http';
import { Server } from 'socket.io';

const port = Number.parseInt(process.env.SOCKET_SERVER_PORT ?? '4000', 10);
const path = process.env.SOCKET_SERVER_PATH ?? '/socket.io';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  path,
});

io.on('connection', (socket) => {
  console.log(`[upstream] client ${socket.id} connected`);

  socket.on('ping', (payload, ack) => {
    console.log('[upstream] ping', payload);
    const response = { ok: true, received: payload };
    socket.emit('pong', response);
    if (typeof ack === 'function') {
      ack(response);
    }
  });

  socket.onAny((event, ...args) => {
    if (event !== 'ping') {
      console.log(`[upstream] event=${event}`, args);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[upstream] client ${socket.id} disconnected (${reason})`);
  });
});

httpServer.listen(port, () => {
  console.log(`Socket.IO upstream listening on http://0.0.0.0:${port}${path}`);
});
