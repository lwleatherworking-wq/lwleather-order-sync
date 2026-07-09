import { shopifyGraphql } from "./apiClient.js";

const QUERY = /* GraphQL */ `
  query ShopCurrency {
    shop {
      currencyCode
    }
  }
`;

interface ShopResult {
  shop: { currencyCode: string };
}

let cachedCurrency: string | undefined;

export async function getShopCurrencyCode(): Promise<string> {
  if (cachedCurrency) return cachedCurrency;
  const data = await shopifyGraphql<ShopResult>(QUERY);
  cachedCurrency = data.shop.currencyCode;
  return cachedCurrency;
}
