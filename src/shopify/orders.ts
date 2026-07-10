import { shopifyGraphql } from "./apiClient.js";
import type { EtsyReceipt } from "../etsy/types.js";
import { moneyToDecimalString } from "../etsy/types.js";
import type { ResolvedVariant } from "./variantLookup.js";
import type { OrderCustomerRef } from "./customers.js";

export interface ShippingAddressInput {
  address1: string;
  address2?: string;
  city?: string;
  provinceCode?: string;
  zip?: string;
  countryCode?: string;
  firstName?: string;
  lastName?: string;
}

/** MailingAddressInput shape (countryCode/provinceCode) used for the order-level shippingAddress. */
export function buildShippingAddress(receipt: EtsyReceipt): ShippingAddressInput | undefined {
  if (!receipt.first_line) return undefined;
  return {
    address1: receipt.first_line,
    address2: receipt.second_line ?? undefined,
    city: receipt.city ?? undefined,
    provinceCode: receipt.state ?? undefined,
    zip: receipt.zip ?? undefined,
    countryCode: receipt.country_iso ?? undefined,
    firstName: receipt.name?.split(" ").slice(0, -1).join(" ") || receipt.name,
    lastName: receipt.name?.split(" ").slice(-1).join(" ") || "",
  };
}

const MUTATION = /* GraphQL */ `
  mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface OrderCreateResult {
  orderCreate: {
    order: { id: string; name: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

export interface ResolvedLineItem {
  variant: ResolvedVariant;
  quantity: number;
  unitPrice: string; // decimal string in shop currency
}

/** Maps a fully-resolved Etsy receipt into the Shopify orderCreate input shape. */
export function buildOrderInput(
  receipt: EtsyReceipt,
  lines: ResolvedLineItem[],
  currencyCode: string,
  shippingAddress: ShippingAddressInput | undefined,
  customer: OrderCustomerRef | undefined
) {
  return {
    email: receipt.buyer_email ?? undefined,
    note: `Synced from Etsy receipt #${receipt.receipt_id}${
      receipt.message_from_buyer ? `\nBuyer note: ${receipt.message_from_buyer}` : ""
    }`,
    tags: ["etsy-sync"],
    processedAt: new Date(receipt.created_timestamp * 1000).toISOString(),
    currency: currencyCode,
    financialStatus: "PAID",
    shippingAddress,
    customer,
    lineItems: lines.map((line) => ({
      variantId: line.variant.variantId,
      sku: line.variant.sku,
      quantity: line.quantity,
      // Etsy orders here are all physical goods needing a shipping label. Left unset,
      // this defaults to false rather than inheriting the variant's own setting, which
      // silently auto-closes the fulfillment order and blocks buying a shipping label.
      requiresShipping: true,
      priceSet: {
        shopMoney: { amount: line.unitPrice, currencyCode },
      },
    })),
    shippingLines:
      receipt.total_shipping_cost.amount > 0
        ? [
            {
              title: "Shipping",
              priceSet: {
                shopMoney: { amount: moneyToDecimalString(receipt.total_shipping_cost), currencyCode },
              },
            },
          ]
        : undefined,
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        amountSet: {
          shopMoney: { amount: moneyToDecimalString(receipt.grandtotal), currencyCode },
        },
      },
    ],
  };
}

export async function createOrder(orderInput: ReturnType<typeof buildOrderInput>): Promise<{
  orderId: string;
  orderName: string;
} | { userErrors: Array<{ field?: string[] | null; message: string }> }> {
  const data = await shopifyGraphql<OrderCreateResult>(MUTATION, {
    order: orderInput,
    options: { sendReceipt: false, sendFulfillmentReceipt: false },
  });

  if (data.orderCreate.userErrors.length > 0) {
    return { userErrors: data.orderCreate.userErrors };
  }
  if (!data.orderCreate.order) {
    return { userErrors: [{ message: "orderCreate returned no order and no userErrors" }] };
  }
  return { orderId: data.orderCreate.order.id, orderName: data.orderCreate.order.name };
}
