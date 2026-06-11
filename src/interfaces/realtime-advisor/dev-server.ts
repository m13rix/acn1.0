import { config as loadDotenv } from 'dotenv';
import { RealtimeAdvisorInterfaceRuntime } from './runtime.js';
import type { InterfaceRouteHandler, InterfaceRuntimeContext } from '../base.js';

loadDotenv();

const routes: InterfaceRouteHandler[] = [];
const runtime = new RealtimeAdvisorInterfaceRuntime({
  port: Number(process.env.TELOS_REALTIME_ADVISOR_PORT || 8787),
  host: process.env.TELOS_REALTIME_ADVISOR_HOST || '127.0.0.1',
  autoOpenClient: process.env.TELOS_REALTIME_ADVISOR_OPEN_CLIENT === '1',
});

const context: InterfaceRuntimeContext = {
  registerRoute: (handler) => routes.push(handler),
  unregisterRoute: (routeId) => {
    const index = routes.findIndex((route) => route.routeId === routeId);
    if (index >= 0) {
      routes.splice(index, 1);
    }
  },
  getRegisteredRoutes: () => routes,
  getLoadedAgents: async () => [],
};

async function shutdown(): Promise<void> {
  await runtime.stop();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

await runtime.start(context);
console.log(`Realtime advisor server: ${runtime.getBaseUrl()}`);
