import { Decimal } from '@fleece/shared';

/**
 * The account-wide buying power that per-symbol trackers draw on.
 *
 * Split out from the tracker so the two can refer to each other without a cycle: a
 * symbol tracker consumes buying power, and the account needs to know when a
 * reservation is finished with it.
 */
export interface BuyingPowerLedger {
  readonly availableBuyingPower: Decimal;
  /** Negative consumes, positive releases. */
  onAvailableBuyingPowerChange(delta: Decimal): void;
  onReservationComplete(reservationId: string): void;
}
