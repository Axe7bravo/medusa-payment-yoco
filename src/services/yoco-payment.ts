import { AbstractPaymentProvider } from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"
import {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { randomUUID } from "crypto"
import {
  YocoOptions,
  YocoOptionsSchema,
  YocoCheckout,
  YocoRefund,
  YocoWebhookEvent,
  YocoError,
  YocoPaymentError,
  YocoErrorCode,
} from "../types"

const YOCO_API = "https://payments.yoco.com/api"
const MIN_AMOUNT_CENTS = 200

class YocoPaymentService extends AbstractPaymentProvider<YocoOptions> {
  static identifier = "yoco"

  protected options_: YocoOptions
  protected logger_: Logger

  constructor(container: Record<string, unknown>, options: YocoOptions) {
    super(container, options)

    const validationResult = YocoOptionsSchema.safeParse(options)
    if (!validationResult.success) {
      const errors = validationResult.error.issues
        .map((e: any) => `${e.path.join(".")}: ${e.message}`)
        .join(", ")
      throw new Error(`[Yoco] Configuration validation failed: ${errors}`)
    }

    this.options_ = validationResult.data
    this.logger_ = container.logger as Logger
  }

  private async api<T>(
    endpoint: string,
    method = "GET",
    body?: object,
    idempotencyKey?: string
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options_.secretKey}`,
    }

    if (method === "POST" && idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey
    }

    try {
      const res = await fetch(`${YOCO_API}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })

      const data = await res.json()

      if (!res.ok) {
        throw YocoPaymentError.fromYocoError(data as YocoError)
      }

      return data as T
    } catch (error) {
      if (error instanceof YocoPaymentError) throw error
      throw new YocoPaymentError("Network error", YocoErrorCode.NETWORK_ERROR, error)
    }
  }

  private mapStatus(status: string): "authorized" | "captured" | "canceled" | "pending" {
    const map: Record<string, "authorized" | "captured" | "canceled" | "pending"> = {
      completed: "authorized",
      cancelled: "canceled",
      expired: "canceled",
    }
    return map[status] || "pending"
  }

async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
  const { amount, context } = input

  try {
    const amountInCents = Math.round(Number(amount) * 100)
    const tester = context?.idempotency_key
    // GREEDY ID RESOLVER: Medusa v2 can put the ID in several places depending on the flow
    const sessionId = String(
      (context as any)?.idempotency_key ||    // Standard Cart ID
      (context as any)?.cart_id ||        // Fallback Cart ID
      (context as any)?.id ||             // Generic ID
      (context as any)?.customer?.id ||   // Customer ID (if logged in)
      `fallback_${randomUUID()}`          // Absolute fallback to prevent empty string
    )

    // Log this to your terminal so you can verify what is being sent
    this.logger_.info(`[Yoco] Initiating payment for ID: ${sessionId}`)
    this.logger_.info(`[Yoco] context: ${tester}`)

    const checkoutPayload: any = {
      amount: amountInCents,
      currency: "ZAR",
      metadata: {
        session_id: sessionId, // This is what the webhook looks for
      },
      externalId: sessionId,
    }

    if (this.options_.successUrl) checkoutPayload.successUrl = this.options_.successUrl
    if (this.options_.cancelUrl) checkoutPayload.cancelUrl = this.options_.cancelUrl

    const checkout = await this.api<YocoCheckout>("/checkouts", "POST", checkoutPayload, `init-${randomUUID()}`)

    return {
      id: checkout.id,
      status: "pending",
      data: {
        yocoCheckoutId: checkout.id,
        redirectUrl: checkout.redirectUrl,
        session_id: sessionId, // PERSIST THIS HERE
      },
    }
  } catch (err) {
    this.logger_.error(`[Yoco] Initiation failed: ${(err as Error).message}`)
    throw err
  }
}

async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
  const { amount, data, context } = input

  try {
    const amountInCents = Math.round(Number(amount) * 100)
    
    // Check context for resource_id (this is where the Cart ID appears in v2 updates)
    const realCartId = (context as any)?.resource_id || (context as any)?.cart_id
    
    // If we find a real cart ID, use it. Otherwise, keep the one we had.
    const sessionId = realCartId ? String(realCartId) : String((data as any)?.session_id)

    this.logger_.info(`[Yoco] Updating payment. ID is now: ${sessionId}`)

    const checkoutPayload: any = {
      amount: amountInCents,
      currency: "ZAR",
      metadata: { session_id: sessionId },
      externalId: sessionId,
    }

    const checkout = await this.api<YocoCheckout>("/checkouts", "POST", checkoutPayload, `upd-${randomUUID()}`)

    return {
      data: {
        ...data,
        yocoCheckoutId: checkout.id,
        redirectUrl: checkout.redirectUrl,
        session_id: sessionId 
      },
    }
  } catch (err) {
    throw new Error(`[Yoco] Update failed: ${(err as Error).message}`)
  }
}

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const id = input.data?.yocoCheckoutId as string
    if (!id) return { status: "pending" }
    try {
      const checkout = await this.api<YocoCheckout>(`/checkouts/${id}`)
      return { status: this.mapStatus(checkout.status) }
    } catch {
      return { status: "pending" }
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const id = input.data?.yocoCheckoutId as string
    if (!id) return { status: "pending", data: input.data }
    try {
      const checkout = await this.api<YocoCheckout>(`/checkouts/${id}`)
      return {
        status: this.mapStatus(checkout.status),
        data: { ...input.data, yocoPaymentId: checkout.paymentId },
      }
    } catch {
      return { status: "pending", data: input.data }
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: { ...input.data, capturedAt: new Date().toISOString() } }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const id = input.data?.yocoCheckoutId as string
    const amount = input.amount ? Math.round(Number(input.amount) * 100) : undefined
    const refund = await this.api<YocoRefund>(`/checkouts/${id}/refund`, "POST", amount ? { amount } : {})
    return { data: { ...input.data, yocoRefundId: refund.refundId } }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: { ...input.data, cancelledAt: new Date().toISOString() } }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const id = input.data?.yocoCheckoutId as string
    if (!id) return { data: input.data }
    const checkout = await this.api<YocoCheckout>(`/checkouts/${id}`)
    return {
      status: checkout.status === "completed" ? "authorized" : "pending",
      data: { ...input.data, yocoStatus: checkout.status },
    } as unknown as RetrievePaymentOutput
  }

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const event = payload.data as unknown as YocoWebhookEvent
    const sessionId = (event.payload.metadata?.session_id as string) || (event.payload as any).externalId || ""

    if (event.type === "payment.succeeded") {
      return { action: "authorized", data: { session_id: sessionId, amount: event.payload.amount } }
    }
    return { action: "not_supported" }
  }
}

export default YocoPaymentService