import type { SupplierId } from '../types/supplier.types';

export type AvailabilitySnapshot = Record<SupplierId, { enabled: boolean }>;

/**
 * In-memory on/off switch for each mock supplier.
 *
 * Initial values come from SUPPLIER_A_ENABLED / SUPPLIER_B_ENABLED. A new
 * instance is created for every Express app, so tests never share state.
 * The dev-only failure-simulation endpoint is the only thing that changes
 * it at runtime.
 */
export class SupplierAvailability {
  private readonly state: Record<SupplierId, boolean>;

  constructor(initial: Record<SupplierId, boolean>) {
    this.state = { ...initial };
  }

  isEnabled(supplierId: SupplierId): boolean {
    return this.state[supplierId];
  }

  setEnabled(supplierId: SupplierId, enabled: boolean): void {
    this.state[supplierId] = enabled;
  }

  snapshot(): AvailabilitySnapshot {
    return {
      supplierA: { enabled: this.state.supplierA },
      supplierB: { enabled: this.state.supplierB },
    };
  }
}
