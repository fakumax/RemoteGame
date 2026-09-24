const express = require('express');
const http = require('node:http');
const { attach } = require('./functions');
function createNetplayServer() {
  const app = express();
  const server = http.createServer(app);
  return { app, server, ...attach(server, app) };
}
if (require.main === module) {
  const { server } = createNetplayServer();
  server.listen(Number(process.env.NETPLAY_PORT || 4000), '127.0.0.1');
}
module.exports = { createNetplayServer };
