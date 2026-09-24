const MAX_PLAYERS = 2; // EmulatorJS 4.2.3 disables 3/4 players in its client.

function start(io, rooms = new Map()) {
  const key = extra => JSON.stringify([extra.domain, extra.game_id, extra.sessionid]);
  const valid = data => data && data.extra &&
    ['domain', 'sessionid', 'userid', 'player_name', 'room_name'].every(k =>
      typeof data.extra[k] === 'string' && data.extra[k].length > 0 && data.extra[k].length <= 200) &&
    Number.isSafeInteger(data.extra.game_id);
  const users = room => Object.fromEntries([...room.users.values()].map(u => [u.extra.userid, u.extra]));
  const publish = room => io.to(room.id).emit('users-updated', users(room));
  io.on('connection', socket => {
    let room = null;
    socket.conn.transport.socket?.setNoDelay?.(true);
    socket.on('open-room', (data, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!valid(data) || !Number.isInteger(data.maxPlayers) || data.maxPlayers < 2 || data.maxPlayers > MAX_PLAYERS || typeof data.password !== 'string') return cb(true, 'INVALID_ROOM');
      if (room) return cb(true, 'ALREADY_IN_ROOM');
      const id = key(data.extra);
      if (rooms.has(id)) return cb(true, 'ROOM_ALREADY_EXISTS');
      // The pinned client never sends passwords when joining. Reject them explicitly.
      if (data.password.trim()) return cb(true, 'PASSWORD_UNSUPPORTED');
      room = { id, extra: data.extra, max: data.maxPlayers, owner: socket.id, users: new Map() };
      room.users.set(socket.id, { socket, extra: data.extra });
      rooms.set(id, room);
      socket.join(id);
      cb(false);
    });
    socket.on('join-room', (data, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!valid(data)) return cb(true, 'INVALID_ROOM');
      if (room) return cb(true, 'ALREADY_IN_ROOM');
      const target = rooms.get(key(data.extra));
      if (!target) return cb(true, 'ROOM_NOT_FOUND');
      if (target.users.size >= target.max) return cb(true, 'ROOM_FULL');
      if ([...target.users.values()].some(u => u.extra.userid === data.extra.userid)) return cb(true, 'USER_ALREADY_EXISTS');
      room = target;
      room.users.set(socket.id, { socket, extra: data.extra });
      socket.join(room.id);
      cb(false, users(room));
      publish(room);
    });
    socket.on('data-message', data => {
      if (!room || !data || typeof data !== 'object') return;
      if (room.owner !== socket.id && ['state','restart','play','pause','readyready'].some(k => k in data)) return;
      socket.to(room.id).emit('data-message', data);
    });
    socket.on('signal', data => {
      if (!room || !data) return;
      socket.to(room.id).emit('signal', data);
    });
    socket.on('latency', (_, cb) => { if (typeof cb === 'function') cb(); });
    socket.on('disconnect', () => {
      if (!room) return;
      const previous = room;
      room = null;
      previous.users.delete(socket.id);
      if (previous.owner === socket.id) {
        rooms.delete(previous.id); // Delete only this room, before disconnect callbacks.
        for (const user of [...previous.users.values()]) user.socket.disconnect(true);
      } else if (rooms.has(previous.id)) publish(previous);
    });
  });
  return rooms;
}

function attach(server, app) {
  const { Server } = require('socket.io');
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024 * 1024,
    perMessageDeflate: false,
    destroyUpgrade: false
  });
  const rooms = start(io);
  app.get('/list', (req, res) => {
    const gameId = Number(req.query.game_id);
    const result = Object.create(null);
    for (const room of rooms.values()) {
      if (room.extra.domain !== req.query.domain || room.extra.game_id !== gameId) continue;
      result[room.extra.sessionid] = {
        owner_name: room.extra.player_name, room_name: room.extra.room_name,
        max: room.max, current: room.users.size, password: 0
      };
    }
    res.json(result);
  });
  return { io, rooms };
}
module.exports = { start, attach, MAX_PLAYERS };
