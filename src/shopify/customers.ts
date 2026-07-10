import { shopifyGraphql } from "./apiClient.js";
import type { ShippingAddressInput } from "./orders.js";

const CREATE_CUSTOMER = /* GraphQL */ `
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_CUSTOMER_ADDRESS = /* GraphQL */ `
  mutation AddCustomerAddress($customerId: ID!, $address: MailingAddressInput!) {
    customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
      userErrors {
        field
        message
      }
    }
  }
`;

interface CreateCustomerResult {
  customerCreate: {
    customer: { id: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

interface AddAddressResult {
  customerAddressCreate: {
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

export type OrderCustomerRef =
  | { toAssociate: { id: string } }
  | {
      toUpsert: {
        email: string;
        firstName?: string;
        lastName?: string;
        addresses: Array<{
          address1?: string;
          address2?: string;
          city?: string;
          province?: string;
          zip?: string;
          country?: string;
          firstName?: string;
          lastName?: string;
        }>;
      };
    };

/**
 * Resolves what to pass as `customer` on orderCreate. Etsy's buyer_email is normally
 * unavailable (restricted, separately-approved field), and Shopify requires either an
 * email or an existing customer id to upsert a customer inline via orderCreate — so
 * without an email, the customer has to be created as its own step first, then linked
 * by id (toAssociate), rather than built inline (toUpsert) like the email case can be.
 */
export async function resolveOrderCustomer(params: {
  buyerEmail: string | null;
  shippingAddress?: ShippingAddressInput;
}): Promise<OrderCustomerRef | undefined> {
  const { buyerEmail, shippingAddress } = params;
  if (!shippingAddress) return undefined;

  if (buyerEmail) {
    return {
      toUpsert: {
        email: buyerEmail,
        firstName: shippingAddress.firstName,
        lastName: shippingAddress.lastName,
        addresses: [
          {
            address1: shippingAddress.address1,
            address2: shippingAddress.address2,
            city: shippingAddress.city,
            province: shippingAddress.provinceCode,
            zip: shippingAddress.zip,
            country: shippingAddress.countryCode,
            firstName: shippingAddress.firstName,
            lastName: shippingAddress.lastName,
          },
        ],
      },
    };
  }

  const customerId = await createCustomer(shippingAddress);
  await addCustomerAddress(customerId, shippingAddress);
  return { toAssociate: { id: customerId } };
}

async function createCustomer(shippingAddress: ShippingAddressInput): Promise<string> {
  const data = await shopifyGraphql<CreateCustomerResult>(CREATE_CUSTOMER, {
    input: { firstName: shippingAddress.firstName, lastName: shippingAddress.lastName },
  });
  if (data.customerCreate.userErrors.length > 0 || !data.customerCreate.customer) {
    throw new Error(`customerCreate failed: ${JSON.stringify(data.customerCreate.userErrors)}`);
  }
  return data.customerCreate.customer.id;
}

async function addCustomerAddress(customerId: string, shippingAddress: ShippingAddressInput): Promise<void> {
  const data = await shopifyGraphql<AddAddressResult>(ADD_CUSTOMER_ADDRESS, {
    customerId,
    address: shippingAddress,
  });
  if (data.customerAddressCreate.userErrors.length > 0) {
    throw new Error(`customerAddressCreate failed: ${JSON.stringify(data.customerAddressCreate.userErrors)}`);
  }
}
