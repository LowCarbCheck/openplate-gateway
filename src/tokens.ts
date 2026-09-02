/**
 * Member token minting — one definition, used by every path that creates one.
 *
 * There are now three: `pnpm mint-token`, `POST /admin/members`, and an invite
 * redemption. Before ADR-0002 there was one, and the format lived in the script.
 * Three copies of "32 random bytes, base64url" would be three chances for one of
 * them to quietly become 16 bytes or `Math.random`, in a value that is the only
 * thing standing between the internet and the payer's provider key.
 *
 * 32 BYTES = 256 BITS, FROM A CSPRNG. Not excess: it removes guessing from the
 * threat model entirely and lets the gateway spend its defences on quotas
 * instead. `randomBytes` is the CSPRNG; `Math.random` is not one and must never
 * appear in this file.
 *
 * NO PREFIX, DELIBERATELY. The format predates ADR-0002 and every member's
 * existing token has this shape; prefixing new ones would split the population
 * for no benefit. Invite tokens DO carry `gi_` (see `invite-store.ts`) —
 * those are short-lived, they are handed to a person, and since M181/05 the
 * prefix BINDS them to this service so one cannot be posted to openplate-sync.
 * A member token is never handed to a person and never travels beside another
 * service's token, so none of that applies to it.
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes = 256 bits. base64url so it survives a URL, a header and a copy-paste. */
export const MEMBER_TOKEN_BYTES = 32;

export function mintMemberToken(): string {
  return randomBytes(MEMBER_TOKEN_BYTES).toString('base64url');
}

/** The digest that is stored. The token itself is never written anywhere. */
export function memberTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
