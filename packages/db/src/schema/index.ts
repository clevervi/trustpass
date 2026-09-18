/**
 * Database schema barrel.
 *
 * Tables are added per epic so that every migration maps to a tracked task:
 *   TP-060 ownership, TP-040 warranty.
 */

export {
  type Issuer,
  type IssuerVerificationStatus,
  issuer,
  issuerVerificationStatus,
  type NewIssuer,
} from "./issuer.js";
export {
  type LifecycleActorKind,
  type LifecycleEvent,
  type LifecycleEventReason,
  type LifecycleEventType,
  lifecycleActorKind,
  lifecycleEvent,
  lifecycleEventReason,
  lifecycleEventType,
  type NewLifecycleEvent,
} from "./lifecycle-event.js";
export {
  type NewProduct,
  type Product,
  type ProductCategory,
  type ProductOrigin,
  type ProductStatus,
  product,
  productCategory,
  productOrigin,
  productStatus,
} from "./product.js";
