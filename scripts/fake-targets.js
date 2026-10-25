// Fake services to monitor, each misbehaving in a way real services do.
//   /healthy   always 200
//   /broken    always 500
//   /slow      answers after 10s (longer than any sane timeout)
//   /flaky     alternates 200 / 500 every request (flapping)
//   /switch    200 or 503, flipped with: curl -X POST localhost:4000/switch/down   (or /up)
import http from 'node:http';

const PORT = Number(process.env.PORT) || 4000;
let switchUp = true;
let flakyCount = 0;

http.createServer((req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(body); };

  if (req.method === 'POST' && req.url.startsWith('/switch/')) {
    switchUp = req.url === '/switch/up';
    console.log(`switch is now ${switchUp ? 'UP' : 'DOWN'}`);
    return reply(200, `switch ${switchUp ? 'up' : 'down'}\n`);
  }
  switch (req.url) {
    case '/healthy': return reply(200, 'ok');
    case '/broken': return reply(500, 'boom');
    case '/slow': return setTimeout(() => reply(200, 'finally'), 10_000);
    case '/flaky': return reply(flakyCount++ % 2 ? 500 : 200, 'maybe');
    case '/switch': return reply(switchUp ? 200 : 503, switchUp ? 'up' : 'down');
    default: return reply(404, 'unknown');
  }
}).listen(PORT, () => console.log(`fake targets on http://localhost:${PORT}`));
