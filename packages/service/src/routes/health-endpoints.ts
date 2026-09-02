import { PingResponse } from '@fleece/shared';
import { Router } from 'express';
import type { Express } from 'express';
import { Endpoints } from './endpoints';

export interface HealthEndpointsProps {
  readonly version: string;
  readonly startedAt: number;
}

/**
 * Unauthenticated, so a load balancer or `curl` can tell a service that is up from
 * one that is merely refusing them.
 */
export class HealthEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: HealthEndpointsProps) {
    this.router = Router();

    const ping = (_req: unknown, res: { status(code: number): { json(body: PingResponse): void } }): void => {
      const response: PingResponse = {
        status: 'ok',
        version: props.version,
        uptimeSeconds: Math.floor((Date.now() - props.startedAt) / 1000),
      };
      res.status(200).json(response);
    };

    this.router.get('/ping', ping);
    this.router.get('/health', ping);
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
