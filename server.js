const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROUTE = '/omi-webhook';
const LOG_FILE = '/opt/morpheus/second-brain/_ingest/omi-webhook-log.ndjson';

// Ensure log directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const server = http.createServer((req, res) => {
  // Only accept POST on the webhook route
  if (req.method === 'POST' && req.url === ROUTE) {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const timestamp = new Date().toISOString();

      // Parse and enrich the payload
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        payload = { raw: body };
      }

      const entry = {
        timestamp,
        source: 'omi-webhook',
        payload
      };

      // Append as NDJSON line
      const line = JSON.stringify(entry) + '\n';
      fs.appendFile(LOG_FILE, line, (err) => {
        if (err) {
          console.error(`[${timestamp}] ERROR writing to log: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        } else {
          console.log(`[${timestamp}] Received OMI webhook — logged to ${LOG_FILE}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', timestamp }));
        }
      });
    });

  } else if (req.method === 'GET' && req.url === ROUTE) {
    // Health check endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      service: 'omi-webhook',
      route: ROUTE,
      log: LOG_FILE,
      timestamp: new Date().toISOString()
    }));

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OMI Webhook Listener running on http://0.0.0.0:${PORT}${ROUTE}`);
  console.log(`Logging to: ${LOG_FILE}`);
});
