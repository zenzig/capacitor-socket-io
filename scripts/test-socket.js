import { io } from 'socket.io-client';

const socket = io('https://home.atomicfalls.com', {
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
