const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { server, notifier } = createApp({
  dbFile: path.join(dataDir, 'runofshow.db'),
  dataDir,
  baseUrl: process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`,
});

server.listen(PORT, () => {
  console.log(`Run-of-show listening on http://localhost:${PORT}`);
  console.log(`WhatsApp: ${notifier.whatsapp ? 'Cloud API enabled' : 'not configured (messages are logged only)'}`);
});
