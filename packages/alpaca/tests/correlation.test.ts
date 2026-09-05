import { decodeAlpacaOrderCorrelation, encodeAlpacaOrderCorrelation } from '../src/correlation';
import { InvalidRequestError } from '@fleece/shared';

describe('Alpaca order correlation', () => {
  it('round-trips every field', () => {
    const correlation = { virtualAccountId: 'MOMENTUM01', reservationId: 'RES1' };
    expect(decodeAlpacaOrderCorrelation(encodeAlpacaOrderCorrelation(correlation))).toEqual(correlation);
  });

  it('round-trips a partial correlation without inventing the missing fields', () => {
    const encoded = encodeAlpacaOrderCorrelation({ virtualAccountId: 'MOMENTUM01' });
    expect(decodeAlpacaOrderCorrelation(encoded)).toEqual({ virtualAccountId: 'MOMENTUM01', reservationId: undefined });
  });

  it('encodes in the form Alpaca will echo back', () => {
    expect(encodeAlpacaOrderCorrelation({ virtualAccountId: 'ACC1', reservationId: 'R1' })).toBe('_c@a:ACC1;r:R1');
  });

  it('decodes an order placed outside the system as having no correlation', () => {
    // Alpaca generates its own client order id for an order placed on their website,
    // and that is exactly the orphan case the injector handles.
    expect(decodeAlpacaOrderCorrelation('6c256995-071f-4f85-a774-a6fba2d03f5c')).toEqual({});
    expect(decodeAlpacaOrderCorrelation('')).toEqual({});
  });

  it('rejects an id containing a separator rather than producing one that misparses', () => {
    expect(() => encodeAlpacaOrderCorrelation({ virtualAccountId: 'ACC;1' })).toThrow(InvalidRequestError);
    expect(() => encodeAlpacaOrderCorrelation({ reservationId: 'r:1' })).toThrow(InvalidRequestError);
  });

  it('rejects a correlation too long for the field Alpaca provides', () => {
    expect(() => encodeAlpacaOrderCorrelation({ virtualAccountId: 'A'.repeat(200) })).toThrow(InvalidRequestError);
  });

  it('accepts a correlation of exactly the maximum length', () => {
    // '_c@a:' is five characters, so 123 more reaches the 128 limit exactly.
    expect(encodeAlpacaOrderCorrelation({ virtualAccountId: 'A'.repeat(123) })).toHaveLength(128);
  });

  it('ignores segments it does not recognise', () => {
    expect(decodeAlpacaOrderCorrelation('_c@a:ACC1;x:whatever')).toEqual({ virtualAccountId: 'ACC1', reservationId: undefined });
  });

  it('still reads an id written before order groups were removed', () => {
    // `g:` is no longer encoded, but one may still be sitting on a working order at the
    // broker. Skipping the segment rather than refusing the id is the difference between
    // attributing that order and orphaning it to the catch-all account.
    expect(decodeAlpacaOrderCorrelation('_c@a:ACC1;r:R1;g:G1')).toEqual({ virtualAccountId: 'ACC1', reservationId: 'R1' });
  });
});
