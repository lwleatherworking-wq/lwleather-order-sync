export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

/** Converts an Etsy Money object to a decimal string suitable for Shopify's Decimal scalar. */
export function moneyToDecimalString(money: EtsyMoney): string {
  return (money.amount / money.divisor).toFixed(2);
}

export interface EtsyTransaction {
  transaction_id: number;
  title: string | null;
  quantity: number;
  receipt_id: number;
  listing_id: number | null;
  product_id: number | null;
  sku: string | null;
  price: EtsyMoney;
  shipping_cost: EtsyMoney;
}

export interface EtsyShipment {
  receipt_shipping_id: number | null;
  carrier_name: string;
  tracking_code: string;
}

export interface EtsyReceipt {
  receipt_id: number;
  status: "paid" | "completed" | "open" | "payment processing" | "canceled" | "fully refunded" | "partially refunded";
  name: string;
  first_line: string | null;
  second_line: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  formatted_address: string | null;
  country_iso: string | null;
  buyer_email: string | null;
  message_from_buyer: string | null;
  is_paid: boolean;
  is_shipped: boolean;
  created_timestamp: number;
  updated_timestamp: number;
  grandtotal: EtsyMoney;
  subtotal: EtsyMoney;
  total_shipping_cost: EtsyMoney;
  total_tax_cost: EtsyMoney;
  discount_amt: EtsyMoney;
  shipments: EtsyShipment[];
  transactions: EtsyTransaction[];
}

export interface EtsyReceiptsResponse {
  count: number;
  results: EtsyReceipt[];
}

export interface EtsyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}
