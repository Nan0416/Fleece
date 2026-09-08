import { LoggerFactory } from '@fleece/shared';
import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { Endpoints } from './routes/endpoints';

const logger = LoggerFactory.getLogger('Service');

export interface ServiceProps {
  readonly middleware: ReadonlyArray<RequestHandler>;
  readonly endpoints: ReadonlyArray<Endpoints>;
  readonly errorHandler: ErrorRequestHandler;
}

/** Assembles the Express app. Knows nothing about what the routes actually do. */
export class Service {
  private readonly app: express.Express;
  private readonly props: ServiceProps;

  constructor(props: ServiceProps) {
    this.app = express();
    this.props = props;
  }

  init(): express.Express {
    // Request bodies here are small; a cap keeps a malformed client from buffering
    // arbitrary memory.
    this.app.use(express.json({ limit: '256kb' }));
    this.app.use(express.urlencoded({ extended: true }));

    for (const middleware of this.props.middleware) {
      this.app.use(middleware);
    }
    for (const endpoints of this.props.endpoints) {
      endpoints.bind(this.app);
    }
    // Registered last: Express only routes to an error handler declared after the
    // routes that can fail.
    this.app.use(this.props.errorHandler);

    logger.info('Express application initialised.');
    return this.app;
  }
}
