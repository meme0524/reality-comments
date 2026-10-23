const tls = require('tls');
const crypto = require('crypto');

const HOST = 'comment.reality.app';

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * ??????????????
 * wss://comment.reality.app/?media_id={??ID}
 */
function connectSocket(mediaId, handlers) {
  const key = crypto.randomBytes(16).toString('base64');
  let buffer = Buffer.alloc(0);
  let handshaken = false;
  let closed = false;
  let fragments = [];
  let fragmentOpcode = 0;

  const socket = tls.connect({
    host: HOST,
    port: 443,
    servername: HOST,
  });

  function fail(error) {
    if (closed) return;
    if (handlers.onError) handlers.onError(error);
  }

  function send(opcode, payload) {
    if (closed || !socket.writable) return;
    socket.write(encodeFrame(opcode, payload));
  }

  socket.on('secureConnect', () => {
    const request = [
      `GET /?media_id=${encodeURIComponent(mediaId)} HTTP/1.1`,
      `Host: ${HOST}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Origin: https://reality.app',
      'User-Agent: Mozilla/5.0',
      '',
      '',
    ].join('\r\n');
    socket.write(request);
  });

  function emitText(payload) {
    if (handlers.onMessage) handlers.onMessage(payload.toString('utf8'));
  }

  function consumeFrames() {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(8 * 1024 * 1024)) {
          fail(new Error('???????????????'));
          socket.destroy();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      let payload = buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.slice(offset + maskLength + length);

      if (opcode === 0x9) {
        send(0xA, payload);
        continue;
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
        const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
        socket.closeCode = code;
        socket.closeReason = reason;
        socket.end();
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0 || opcode === 0x1) {
        if (opcode === 0x1) {
          fragments = [payload];
          fragmentOpcode = 1;
        } else {
          fragments.push(payload);
        }
        if (fin && fragmentOpcode === 1) {
          emitText(Buffer.concat(fragments));
          fragments = [];
          fragmentOpcode = 0;
        }
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshaken) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = buffer.slice(0, end).toString('utf8');
      buffer = buffer.slice(end + 4);
      handshaken = true;
      const status = header.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 101\b/.test(status)) {
        fail(new Error(status || '???????????????????'));
        socket.destroy();
        return;
      }
      if (handlers.onOpen) handlers.onOpen();
    }
    consumeFrames();
  });

  socket.on('error', (error) => fail(error));
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    if (handlers.onClose) handlers.onClose(socket.closeCode || 0, socket.closeReason || '');
  });

  return {
    ping() {
      send(0x9, 'ping');
    },
    close() {
      if (closed) return;
      closed = true;
      try { send(0x8, Buffer.alloc(0)); } catch (error) { /* already gone */ }
      socket.destroy();
      if (handlers.onClose) handlers.onClose();
    },
  };
}

module.exports = { connectSocket };
