import {
  ActivateAccountResponse,
  CreateAccountResponse,
  DeactivateAccountResponse,
  DeleteAccountResponse,
  GetAccountResponse,
  ListAccountsResponse,
  parseOptionalBooleanParam,
  assertRecord,
  UpdateAccountNameResponse,
} from '@fleece/shared';
import { AccountService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import { parseCreateAccountRequest, parseListAccountsQuery, parseUpdateAccountNameRequest, requireStringParam } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface AccountEndpointsProps {
  readonly accountService: AccountService;
}

/**
 * Virtual account management.
 *
 * Handlers are async and simply throw — Express 5 forwards a rejected promise to the
 * error handler, so there is no try/catch/next boilerplate. Every service method takes
 * one Request and returns one Response, which leaves a handler's whole job as parsing
 * the former and picking a status code for the latter.
 */
export class AccountEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: AccountEndpointsProps) {
    const { accountService } = props;
    this.router = Router();

    this.router.post('/account', async (req, res) => {
      const response: CreateAccountResponse = await accountService.createAccount(parseCreateAccountRequest(req.body));
      res.status(201).json(response);
    });

    this.router.get('/account', async (req, res) => {
      const response: GetAccountResponse = await accountService.getAccount({ accountId: requireStringParam(req.query, 'accountId') });
      res.status(200).json(response);
    });

    this.router.delete('/account', async (req, res) => {
      const force = parseOptionalBooleanParam(assertRecord(req.query, 'query')['force'], 'force');
      const response: DeleteAccountResponse = await accountService.deleteAccount({ accountId: requireStringParam(req.query, 'accountId'), force });
      res.status(200).json(response);
    });

    this.router.get('/accounts', async (req, res) => {
      const response: ListAccountsResponse = await accountService.listAccounts(parseListAccountsQuery(req.query));
      res.status(200).json(response);
    });

    this.router.put('/account/activate', async (req, res) => {
      const response: ActivateAccountResponse = await accountService.activateAccount({ accountId: requireStringParam(req.query, 'accountId') });
      res.status(200).json(response);
    });

    this.router.put('/account/deactivate', async (req, res) => {
      const response: DeactivateAccountResponse = await accountService.deactivateAccount({ accountId: requireStringParam(req.query, 'accountId') });
      res.status(200).json(response);
    });

    this.router.put('/account/name', async (req, res) => {
      const response: UpdateAccountNameResponse = await accountService.updateAccountName(parseUpdateAccountNameRequest(req.query, req.body));
      res.status(200).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
