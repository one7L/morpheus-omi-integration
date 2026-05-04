const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const ROUTE = '/omi-webhook';
const BASE_DIR = '/opt/morpheus/second-brain/_ingest';

// Route mapping
const ROUTES = {
  conversation_created: 'conversations',
  realtime_transcript: 'realtime-transcripts',
  audio_bytes: 'audio',
  unhandled: 'unhandled',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeNDJSON(filepath, entry) {
  ensureDir(path.dirname(filepath));
  fs.appendFileSync(filepath, JSON.stringify(entry) + '\n');
}

function writeJSON(filepath, data) {
  ensureDir(filepath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = data.id || data.conversation?.id || `unknown-${ts}`;
  const filename = `${ts}_${id}.json`;
  const fullPath = path.join(filepath, filename);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  return fullPath;
}

function writeAudio(filepath, data, sampleRate) {
  ensureDir(filepath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${ts}_sr${sampleRate || 'unknown'}.pcm16`;
  const fullPath = path.join(filepath, filename);
  fs.writeFileSync(fullPath, data);
  return fullPath;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // Only handle our route
  if (pathname !== ROUTE) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
    return;
  }

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      service: 'morpheus-omi-webhook',
      version: '3.0.0-full-router',
      routes: Object.keys(ROUTES),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // POST handling
  if (req.method === 'POST') {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const uid = query.uid || 'unknown';
    const sessionId = query.session_id || null;
    const sampleRate = query.sample_rate || null;
    const timestamp = new Date().toISOString();

    // Route 3: Audio bytes (binary)
    if (contentType.includes('octet-stream')) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const audioData = Buffer.concat(chunks);
        const routeDir = ROUTES.audio_bytes;
        const savedFile = writeAudio(path.join(BASE_DIR, routeDir), audioData, sampleRate);

        writeNDJSON(path.join(BASE_DIR, routeDir, `${routeDir}.ndjson`), {
          timestamp, uid, sample_rate: sampleRate,
          bytes: audioData.length, file: savedFile
        });

        console.log(`[${timestamp}] audio_bytes → ${routeDir} | uid=${uid} | ${audioData.length} bytes | sr=${sampleRate}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', routed: routeDir, bytes: audioData.length, file: savedFile, timestamp }));
      });
      return;
    }

    // JSON payloads
    let body = '';
    req.on('data', chunk => { body += chunk; });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);

        // Route 2: Real-time transcript (array + session_id)
        if (Array.isArray(payload) && sessionId) {
          const routeDir = ROUTES.realtime_transcript;
          const entry = { timestamp, uid, session_id: sessionId, segments: payload };

          writeNDJSON(path.join(BASE_DIR, 'omi-webhook-log.ndjson'), { timestamp, source: 'omi-webhook', type: 'realtime_transcript', entry });
          writeNDJSON(path.join(BASE_DIR, routeDir, `${routeDir}.ndjson`), entry);

          console.log(`[${timestamp}] realtime_transcript → ${routeDir} | uid=${uid} | session=${sessionId} | ${payload.length} segments`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', routed: routeDir, segments: payload.length, timestamp }));
          return;
        }

        // Route 1: Memory creation (object with structured field)
        if (typeof payload === 'object' && payload.structured) {
          // Skip discarded conversations
          if (payload.discarded === true) {
            console.log(`[${timestamp}] conversation_created → DISCARDED (low quality) | uid=${uid}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', routed: 'discarded', reason: 'low_quality', timestamp }));
            return;
          }

          const routeDir = ROUTES.conversation_created;
          const masterEntry = { timestamp, source: 'omi-webhook', type: 'conversation_created', uid, payload };

          // Master log
          writeNDJSON(path.join(BASE_DIR, 'omi-webhook-log.ndjson'), masterEntry);

          // Per-type NDJSON
          writeNDJSON(path.join(BASE_DIR, routeDir, `${routeDir}.ndjson`), masterEntry);

          // Individual JSON
          const savedFile = writeJSON(path.join(BASE_DIR, routeDir), payload);

          const title = payload.structured.title || 'N/A';
          const actions = (payload.structured.action_items || []).length;
          const segments = (payload.transcript_segments || []).length;

          console.log(`[${timestamp}] conversation_created → ${routeDir} | uid=${uid} | id=${payload.id || 'N/A'} | "${title}" | ${segments} segments | ${actions} action items`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', routed: routeDir, id: payload.id, title, segments, action_items: actions, file: savedFile, timestamp }));
          return;
        }

        // Unhandled JSON payload
        const routeDir = ROUTES.unhandled;
        writeNDJSON(path.join(BASE_DIR, 'omi-webhook-log.ndjson'), { timestamp, source: 'omi-webhook', type: 'unhandled', payload });
        writeNDJSON(path.join(BASE_DIR, routeDir, `${routeDir}.ndjson`), { timestamp, payload });

        console.log(`[${timestamp}] unhandled → ${routeDir} | type=${typeof payload}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', routed: routeDir, timestamp }));

      } catch (err) {
        console.error(`[${new Date().toISOString()}] Parse error: ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    });
    return;
  }

  // Method not allowed
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'method_not_allowed' }));
});

// Create all ingest directories on startup
Object.values(ROUTES).forEach(dir => {
  ensureDir(path.join(BASE_DIR, dir));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Morpheus OMI Webhook Router v3.0 listening on 0.0.0.0:${PORT}${ROUTE}`);
  console.log(`Routes:`);
  console.log(`  1. conversation_created → conversations/  (Memory Creation trigger)`);
  console.log(`  2. realtime_transcript  → realtime-transcripts/  (Real-Time Transcript)`);
  console.log(`  3. audio_bytes          → audio/  (Raw PCM16 binary)`);
  console.log(`  4. discarded            → skipped (low quality)`);
  console.log(`  5. unhandled            → unhandled/  (catch-all)`);
  console.log(`Ingest dir: ${BASE_DIR}`);
});
