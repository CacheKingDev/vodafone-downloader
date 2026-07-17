import { type ZodType, z } from "zod";
import { PortalContractError } from "../../domain/errors.js";

/**
 * Schemas for the portal's responses. Field names follow the spike transcript
 * (design spec section 3). Verify them against the committed fixtures; if the
 * portal differs, change the schema here — this is the single source of truth
 * for what "the portal returned something we understand" means.
 */

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

// userinfo is an ARRAY; assets live under [0].userAssets. Each asset id is a
// URN like urn:vf-de-dxl-tmf:kd:cable:can:<CAN>.
const userAssetSchema = z.object({
  id: z.string().min(1),
});

const userinfoEntrySchema = z.object({
  userAssets: z.array(userAssetSchema),
});

export const userinfoSchema = z.array(userinfoEntrySchema);

const invoiceDocumentMetaSchema = z.object({
  documentId: z.string().min(1),
  category: z.string().nullish(),
  subType: z.string().nullish(),
});

// contractNumber is an ARRAY of strings under productCategory[].
const productCategorySchema = z.object({
  contractNumber: z.array(z.string()).nullish(),
});

const invoiceSchema = z.object({
  number: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  amount: z.number(),
  about: z.string().nullish(),
  documents: z.array(invoiceDocumentMetaSchema),
  referencedBillingAccount: z
    .object({ productCategory: z.array(productCategorySchema).nullish() })
    .nullish(),
});

// The portal wraps the invoices in an object: { customerId, invoices, ... }.
export const invoiceListSchema = z.object({
  invoices: z.array(invoiceSchema),
});

export const invoiceDocumentSchema = z.object({
  mime: z.string(),
  data: z.string().min(1),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type Userinfo = z.infer<typeof userinfoSchema>;
export type PortalInvoice = z.infer<typeof invoiceSchema>;
export type InvoiceList = z.infer<typeof invoiceListSchema>;
export type InvoiceDocumentResponse = z.infer<typeof invoiceDocumentSchema>;

/**
 * Validates a portal response, turning any schema failure into a
 * PortalContractError that names which response failed. A changed portal must
 * fail loudly, not slip through as undefined.
 */
export function parsePortal<T>(schema: ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new PortalContractError(
      `Portal response for ${context} did not match the expected shape: ${result.error.message}`,
    );
  }
  return result.data;
}
