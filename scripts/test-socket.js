import 'dotenv/config';
import { io } from 'socket.io-client';

const serverUrl = process.env.SOCKET_IO_PROXY_URL ?? 'https://socket-proxy.local';

console.log(`[test-socket] connecting to ${serverUrl}`);
if (serverUrl.includes('socket-proxy.example.com') || serverUrl.includes('socket-proxy.local')) {
  console.warn('[test-socket] Set SOCKET_IO_PROXY_URL to your TLS proxy to exercise a real server.');
}

const socket = io(serverUrl, {
  transports: ['websocket'],
  path: '/socket.io',
  secure: true,
});

socket.on('connect', () => {
  console.log('Connected', socket.id);
  socket.emit('ping', { msg: 'Hello from Node test' });
});

socket.onAny((event, ...args) => {
  console.log('Event:', event, args);
});

setTimeout(() => {
  console.log('Closing');
  socket.close();
}, 10000);
