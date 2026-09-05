import { assertInteger, assertNonEmptyString, assertOneOf, assertRecord, PingRequest, PingResponse, TrackBrokerOrdersRequest, TrackBrokerOrdersResponse } from '@fleece/shared';
import { HttpClient, HttpClientProps } from './http-client';

/**
 * A typed client for the tracking service.
 *
 * Separate from `FleeceClient` because they are different services on different ports
 * with different tokens — the API reads the ledger, this one accepts claims about orders
 * — and one client covering both would let a caller configure the wrong base URL for
 * half its calls and only find out at runtime.
 *
 * They share `HttpClient`, so a failure surfaces the same way from either: the service's
 * typed errors rebuilt on this side, and `ServiceUnreachableError` when nothing answered.
 *
 * Nothing here needs reviving. `FleeceClient` rebuilds its responses field by field
 * because they carry decimals as strings, and a cast would promise a shape the JSON does
 * not have. The tracking service returns no decimals at all.
 */
export class TrackingClient {
  private readonly http: HttpClient;

  constructor(props: HttpClientProps) {
    this.http = new HttpClient(props);
  }

  async ping(_request: PingRequest = {}): Promise<PingResponse> {
    const payload = assertRecord(await this.http.request('GET', '/ping'), 'response');
    return {
      status: assertOneOf(payload['status'], 'status', ['ok'] as const),
      version: assertNonEmptyString(payload['version'], 'version'),
      uptimeSeconds: assertInteger(payload['uptimeSeconds'], 'uptimeSeconds'),
    };
  }

  /**
   * Claims some broker orders for a virtual account.
   *
   * Idempotent, and safe to send before the orders exist: the service remembers a claim
   * for an order it has not seen and ignores a repeat for one it has. It cannot move an
   * order already booked — a claim is the last answer consulted, not an override — so
   * sending one late is harmless and sending one twice does nothing.
   *
   * Returning does not mean the orders are booked. The claim is queued behind whatever
   * the broker's feeds are already applying, which is what keeps the two from deciding
   * the same order concurrently.
   */
  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<TrackBrokerOrdersResponse> {
    await this.http.request('PUT', '/track', { body: request });
    return {};
  }
}
