import {
  DeleteBrokerOrderResponse,
  GetBrokerOrderResponse,
  GetOrderFillProgressResponse,
  ListBrokerOrderLegsResponse,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersResponse,
} from '@fleece/shared';
import { BrokerOrderService, LedgerService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import { parseListBrokerOrdersQuery, requireStringParam } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface BrokerOrderEndpointsProps {
  readonly brokerOrderService: BrokerOrderService;
  /** Fill progress is the ledger's view of an order, so it comes from the ledger. */
  readonly ledgerService: LedgerService;
}

/**
 * Broker orders are read-only over HTTP, apart from deletion.
 *
 * They are created and updated by the injector as events arrive from the broker,
 * which holds the ledger directly. Exposing a write path here would let a caller
 * assert that an order exists that no broker ever saw.
 */
export class BrokerOrderEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: BrokerOrderEndpointsProps) {
    const { brokerOrderService, ledgerService } = props;
    this.router = Router();

    this.router.get('/broker-order', async (req, res) => {
      const response: GetBrokerOrderResponse = await brokerOrderService.getBrokerOrder({ brokerOrderId: requireStringParam(req.query, 'brokerOrderId') });
      res.status(200).json(response);
    });

    this.router.delete('/broker-order', async (req, res) => {
      const response: DeleteBrokerOrderResponse = await brokerOrderService.deleteBrokerOrder({ brokerOrderId: requireStringParam(req.query, 'brokerOrderId') });
      res.status(200).json(response);
    });

    this.router.get('/broker-orders', async (req, res) => {
      const response: ListBrokerOrdersResponse = await brokerOrderService.listBrokerOrders(parseListBrokerOrdersQuery(req.query));
      res.status(200).json(response);
    });

    // The contracts of one spread. Takes the parent's id without requiring a row for
    // it, since `parent_broker_order_id` groups rather than resolves.
    this.router.get('/broker-order-legs', async (req, res) => {
      const response: ListBrokerOrderLegsResponse = await brokerOrderService.listBrokerOrderLegs({ parentBrokerOrderId: requireStringParam(req.query, 'parentBrokerOrderId') });
      res.status(200).json(response);
    });

    // What the ledger has booked against an order, and whether the stored counter still
    // agrees with the transactions it counts. There is no orphan endpoint any more:
    // orders nobody claimed are the ones in a configured catch-all account, so they come
    // from `/broker-orders?accountId=...` like any other search.
    this.router.get('/broker-order-fill-progress', async (req, res) => {
      const response: GetOrderFillProgressResponse = await ledgerService.getOrderFillProgress({ referenceId: requireStringParam(req.query, 'referenceId') });
      res.status(200).json(response);
    });

    this.router.get('/broker-order-records', async (req, res) => {
      const response: ListBrokerOrderRecordsResponse = await brokerOrderService.listRecords({ brokerOrderId: requireStringParam(req.query, 'brokerOrderId') });
      res.status(200).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
