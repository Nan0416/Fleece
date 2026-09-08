import type { Express } from 'express';

/** A group of related routes. Each group binds itself onto the app. */
export interface Endpoints {
  bind(app: Express): void;
}
