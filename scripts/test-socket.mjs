import { io } from 'socket.io-client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const socket = io('https://home.atomicfalls.com', {
  transports: ['websocket'],
  path: '/socket.io',
  timeout: 10000,
  rejectUnauthorized: false,
});

socket.on('connect', () => {
  console.log('Connected', socket.id);
  socket.emit('ping', { msg: 'Hello from Node test' }, (response) => {
    console.log('Ack from ping:', response);
  });
});

socket.on('connect_error', (err) => {
  console.error('Connect error', err);
});

socket.onAny((event, ...args) => {
  console.log('Event:', event, args);
});

setTimeout(() => {
  console.log('Closing');
  socket.close();
}, 10000);
