/**
 * Database schema barrel.
 *
 * Tables are added per epic so that every migration maps to a tracked task:
 *   TP-060 ownership, TP-040 warranty.
 */

export { type Actor, actor, actorKind, type NewActor } from "./actor.js";
export {
  type CapacityGrant,
  type CapacityGrantRevocation,
  capacityGrant,
  capacityGrantRevocation,
  type GrantScopeKind,
  grantScopeKind,
  type NewCapacityGrant,
  type NewCapacityGrantRevocation,
} from "./capacity-grant.js";
export {
  type Credential,
  type CredentialKind,
  credential,
  credentialKind,
  type NewCredential,
} from "./credential.js";
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
export { type Membership, membership, type NewMembership } from "./membership.js";
export {
  type NewOrganization,
  type Organization,
  organization,
  type VerificationStatus,
  verificationStatus,
} from "./organization.js";
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
