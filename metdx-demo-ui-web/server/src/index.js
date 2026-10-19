import { configFromEnv } from './proxy.js';
import { createServer } from './server.js';

const config = configFromEnv();
const server = createServer(config);
server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `metdx-demo-ui-web server on :${config.port}` +
      (config.staticDir ? ` (static: ${config.staticDir})` : '') +
      ` allowed=${config.allowedHosts.join(',')} trusted=${config.trustedInternalHosts.join(',')}`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
