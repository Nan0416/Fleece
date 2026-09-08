import { LoggerFactory } from '@fleece/utilities';
import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { Endpoints } from './endpoints';

/**
 * What a dependency factory builds: the three things an Express app is assembled from.
 *
 * Both apps' factories return exactly this, which is why it lives here rather than
 * beside either of them — the factory decides *what* goes in, this decides the order it
 * goes in, and neither needs to know the other's routes.
 */
export interface Dependencies {
  readonly middleware: ReadonlyArray<RequestHandler>;
  readonly endpoints: ReadonlyArray<Endpoints>;
  readonly errorHandler: ErrorRequestHandler;
}

export interface HttpAppProps extends Dependencies {
  /** Names this app's logger, so two processes' lines are told apart in one log. */
  readonly name: string;
  /**
   * Cap on a JSON body, as `express.json`'s `limit`. Required rather than defaulted:
   * the right cap is a fact about what an app accepts, and a default here would be a
   * second place for it to be wrong.
   */
  readonly jsonBodyLimit: string;
  /** Accept form-encoded bodies as well as JSON. Off unless an app serves a browser. */
  readonly urlencoded?: boolean;
}

/** Assembles the Express app. Knows nothing about what the routes actually do. */
export class HttpApp {
  private readonly app: express.Express;
  private readonly logger: ReturnType<typeof LoggerFactory.getLogger>;

  constructor(private readonly props: HttpAppProps) {
    this.app = express();
    this.logger = LoggerFactory.getLogger(props.name);
  }

  init(): express.Express {
    this.app.use(express.json({ limit: this.props.jsonBodyLimit }));
    if (this.props.urlencoded === true) {
      this.app.use(express.urlencoded({ extended: true }));
    }

    for (const middleware of this.props.middleware) {
      this.app.use(middleware);
    }
    for (const endpoints of this.props.endpoints) {
      endpoints.bind(this.app);
    }
    // Registered last: Express only routes to an error handler declared after the
    // routes that can fail.
    this.app.use(this.props.errorHandler);

    this.logger.info('Express application initialised.');
    return this.app;
  }
}
