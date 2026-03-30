import type { InterfaceRouteHandler } from './base.js';

export class InterfaceRouteRegistry {
  private readonly routes = new Map<string, InterfaceRouteHandler>();

  register(handler: InterfaceRouteHandler): void {
    this.routes.set(handler.routeId, handler);
  }

  unregister(routeId: string): void {
    this.routes.delete(routeId);
  }

  get(routeId: string): InterfaceRouteHandler | undefined {
    return this.routes.get(routeId);
  }

  list(): InterfaceRouteHandler[] {
    return Array.from(this.routes.values());
  }
}

const globalInterfaceRouteRegistry = new InterfaceRouteRegistry();

export function getInterfaceRouteRegistry(): InterfaceRouteRegistry {
  return globalInterfaceRouteRegistry;
}
