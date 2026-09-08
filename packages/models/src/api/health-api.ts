export interface PingRequest {}

export interface PingResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly uptimeSeconds: number;
}
