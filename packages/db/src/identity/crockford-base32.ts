/**
 * Crockford base32.
 *
 * Chosen over standard base32 for one reason: it is designed to survive being
 * read aloud, written down and typed back in. The alphabet omits I, L, O and U
 * so that 1/I/l and 0/O cannot be confused, and U is excluded so that random
 * output cannot spell an obscenity.
 *
 * Specification: https://www.crockford.com/base32.html
 */

/** Encoding alphabet. Note the absence of I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Check-symbol alphabet: the 32 encoding symbols plus five that can only ever
 * appear in the check position, giving a prime modulus of 37.
 */
const CHECK_ALPHABET = `${ALPHABET}*~$=U`;

const CHECK_MODULUS = 37n;
const BITS_PER_SYMBOL = 5n;
const SYMBOL_MASK = 31n;

/**
 * Folds the characters a human is likely to substitute back onto the symbol
 * they meant, uppercases, and drops separators and whitespace.
 */
export function normalizeSymbols(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

/** Encodes a non-negative integer into exactly `length` symbols, zero-padded. */
export function encodeSymbols(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    encoded = ALPHABET.charAt(Number(remaining & SYMBOL_MASK)) + encoded;
    remaining >>= BITS_PER_SYMBOL;
  }

  return encoded;
}

/** Decodes symbols back to an integer, or null if any symbol is not in the alphabet. */
export function decodeSymbols(encoded: string): bigint | null {
  let value = 0n;

  for (const symbol of encoded) {
    const index = ALPHABET.indexOf(symbol);
    if (index === -1) {
      return null;
    }
    value = (value << BITS_PER_SYMBOL) | BigInt(index);
  }

  return value;
}

/**
 * Computes the check symbol for a value.
 *
 * The modulus is prime and larger than the alphabet, which is what makes every
 * single-symbol substitution detectable: such a substitution shifts the value
 * by `delta * 32^position` where `0 < |delta| < 32`, and since neither factor
 * is divisible by 37, the remainder cannot stay the same.
 */
export function checkSymbol(value: bigint): string {
  return CHECK_ALPHABET.charAt(Number(value % CHECK_MODULUS));
}
