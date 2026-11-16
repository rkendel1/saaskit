/**
 * The payment-provider boundary. The commercial engine knows these shapes only; nothing Stripe-
 * specific crosses into feltkit/. A second provider implements `PaymentProvider` and its own
 * `normalize`/`verify`.
 */

/** A verified provider event, translated to the engine's vocabulary. */
export interface NormalizedEvent {
  provider: string;
  eventId: string;
  /** What happened, provider-neutral. "ignored" for types the engine does not act on. */
  type: "checkout.completed" | "payment.succeeded" | "payment.failed" | "refund.succeeded" | "refund.failed" | "payment_method.updated" | "ignored";
  providerType: string;
  /** When the provider says it happened (ms). */
  created: number;
  accountId?: string;
  invoiceId?: string;
  checkoutId?: string;
  refundId?: string;
  paymentRef?: string;
  refundRef?: string;
  checkoutRef?: string;
  customerRef?: string;
  amount?: number;
  currency?: string;
  failureReason?: string;
  mode?: "payment" | "setup";
  paymentMethod?: { ref: string; brand: string; last4: string; expMonth: number; expYear: number };
}

export interface CheckoutRequest {
  checkoutId: string;
  accountId: string;
  invoiceId?: string;
  mode: "payment" | "setup";
  amount: number;
  currency: string;
  description: string;
  customerRef: string;
  successUrl: string;
  cancelUrl: string;
}
export interface ChargeRequest {
  invoiceId: string;
  accountId: string;
  amount: number;
  currency: string;
  customerRef: string;
  paymentMethodRef: string;
  idempotencyKey: string;
  description: string;
}

/** Thrown by a provider call. `retryable`: safe to repeat with the same idempotency key. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly providerCode?: string) {
    super(message);
  }
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: "live" | "test" | "simulated";
  ensureCustomer(input: { accountId: string; name: string; email?: string; idempotencyKey: string }): Promise<{ customerRef: string }>;
  createCheckout(input: CheckoutRequest, idempotencyKey: string): Promise<{ checkoutRef: string; url: string }>;
  /** Off-session charge of a saved payment method. The outcome arrives as a verified event; the response is evidence of the request only. */
  charge(input: ChargeRequest): Promise<{ paymentRef: string; status: string }>;
  refund(input: { refundId: string; paymentRef: string; amount: number; idempotencyKey: string }): Promise<{ refundRef: string; status: string }>;
  paymentMethod(ref: string): Promise<NormalizedEvent["paymentMethod"] | null>;
  /** Reconciliation: what the provider says a payment's state is now. */
  paymentStatus(paymentRef: string): Promise<{ status: "succeeded" | "failed" | "processing" | "unknown"; amount?: number; currency?: string; invoiceId?: string }>;
}
