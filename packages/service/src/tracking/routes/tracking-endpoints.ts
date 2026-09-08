import { TrackBrokerOrdersResponse } from '@fleece/shared';
import { Router } from 'express';
import type { Express } from 'express';
import { OrderTrackingFacade } from '../order-tracking-facade';
import { parseTrackBrokerOrdersRequest } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

/** All this needs of the facade. It accepts claims and nothing else. */
export type BrokerOrderClaims = Pick<OrderTrackingFacade, 'track'>;

export interface TrackingEndpointsProps {
  readonly orderTracking: BrokerOrderClaims;
}

/**
 * The one thing this service is told rather than discovers: whose an order is.
 *
 * **`PUT`, because a claim is an assertion and not an event.** Claiming the same orders
 * for the same account twice is the same as claiming them once — the facade remembers an
 * association for an order it has not seen and ignores a repeat for one it has — so the
 * verb that says "make this so" is the honest one. `POST` would suggest that sending it
 * twice does something twice.
 *
 * **`202`, because the claim is queued rather than applied.** It goes onto the same queue
 * as the broker's own events, which is what stops an order's events and a claim about
 * that order being decided concurrently. Answering `200` would say the booking had
 * happened, and for an order whose events have not arrived yet, nothing has.
 *
 * There is no endpoint to *read* a claim, and no endpoint to withdraw one. An order's
 * virtual account is written once — everything it produces is keyed by it — so a claim
 * is either the first answer or it is ignored, and `GET /broker-order` on the API is
 * where you look to see which. See `md/GUIDELINES.md` rule 8a.
 */
export class TrackingEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: TrackingEndpointsProps) {
    const { orderTracking } = props;
    this.router = Router();

    this.router.put('/track', (req, res) => {
      orderTracking.track(parseTrackBrokerOrdersRequest(req.body));
      const response: TrackBrokerOrdersResponse = {};
      res.status(202).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
