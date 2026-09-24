const { createNetplayServer } = require('./server');
const port = Number(process.env.NETPLAY_PORT || 4000);
const { server } = createNetplayServer();
server.listen(port, '127.0.0.1', () => console.log('Netplay independiente en localhost:' + port));
