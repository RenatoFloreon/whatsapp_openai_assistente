const { createServer } = require('http');
const app = require('../lib/server');

module.exports = (req, res) => {
  if (req.url.startsWith('/api/webhook')) {
    req.url = req.url.replace('/api', ''); // Corrige rota para Express
  }
  const server = createServer(app);
  server.emit('request', req, res);
};
