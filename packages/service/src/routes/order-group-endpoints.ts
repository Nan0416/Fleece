import {
  AppendDocumentsResponse,
  CloseOrderGroupResponse,
  CreateOrderGroupResponse,
  DeleteOrderGroupResponse,
  GetOrderGroupResponse,
  ListOrderGroupsResponse,
} from '@fleece/shared';
import { OrderGroupService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import { parseAppendDocumentsRequest, parseCreateOrderGroupRequest, parseListOrderGroupsQuery, requireStringParam } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface OrderGroupEndpointsProps {
  readonly orderGroupService: OrderGroupService;
}

export class OrderGroupEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: OrderGroupEndpointsProps) {
    const { orderGroupService } = props;
    this.router = Router();

    this.router.post('/order-group', async (req, res) => {
      const response: CreateOrderGroupResponse = await orderGroupService.createOrderGroup(parseCreateOrderGroupRequest(req.body));
      res.status(201).json(response);
    });

    /**
     * By group id only. The legacy route also accepted `correlationId` and returned
     * the first match, a shape its own source marked "todo: deprecate" — searching by
     * correlation belongs on the listing, which returns all of them.
     */
    this.router.get('/order-group', async (req, res) => {
      const response: GetOrderGroupResponse = await orderGroupService.getOrderGroup({ groupId: requireStringParam(req.query, 'groupId') });
      res.status(200).json(response);
    });

    this.router.delete('/order-group', async (req, res) => {
      const response: DeleteOrderGroupResponse = await orderGroupService.deleteOrderGroup({ groupId: requireStringParam(req.query, 'groupId') });
      res.status(200).json(response);
    });

    this.router.put('/order-group/close', async (req, res) => {
      const response: CloseOrderGroupResponse = await orderGroupService.closeOrderGroup({ groupId: requireStringParam(req.query, 'groupId') });
      res.status(200).json(response);
    });

    this.router.put('/order-group/documents', async (req, res) => {
      const response: AppendDocumentsResponse = await orderGroupService.appendDocuments(parseAppendDocumentsRequest(req.body));
      res.status(200).json(response);
    });

    this.router.get('/order-groups', async (req, res) => {
      const response: ListOrderGroupsResponse = await orderGroupService.listOrderGroups(parseListOrderGroupsQuery(req.query));
      res.status(200).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
