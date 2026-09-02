import {
  DeleteBrokerOrderResponse,
  GetBrokerOrderResponse,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersByGroupIdResponse,
  ListBrokerOrdersResponse,
  ListOrphanBrokerOrdersResponse,
} from '@fleece/shared';
import { BrokerOrderService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import { parseListBrokerOrdersQuery, requireStringParam } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface BrokerOrderEndpointsProps {
  readonly brokerOrderService: BrokerOrderService;
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
    const { brokerOrderService } = props;
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

    this.router.get('/broker-orders-by-group', async (req, res) => {
      const response: ListBrokerOrdersByGroupIdResponse = await brokerOrderService.listBrokerOrdersByGroupId({ groupId: requireStringParam(req.query, 'groupId') });
      res.status(200).json(response);
    });

    this.router.get('/orphan-broker-orders', async (_req, res) => {
      const response: ListOrphanBrokerOrdersResponse = await brokerOrderService.listOrphanBrokerOrders({});
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
