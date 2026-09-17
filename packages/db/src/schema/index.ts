/**
 * Database schema barrel.
 *
 * Tables are added per epic so that every migration maps to a tracked task:
 *   TP-040 warranty, TP-050 lifecycle_event, TP-060 ownership.
 */

export {
  type Issuer,
  type IssuerVerificationStatus,
  issuer,
  issuerVerificationStatus,
  type NewIssuer,
} from "./issuer.js";
export {
  type NewProduct,
  type Product,
  type ProductCategory,
  type ProductStatus,
  product,
  productCategory,
  productStatus,
} from "./product.js";
