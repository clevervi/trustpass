/** How many trailing characters a passport may show. */
const DISCLOSED_CHARACTERS = 4;

/**
 * How much of a serial a public passport may reveal.
 *
 * A full serial on a page anyone can scan lets a third party impersonate the
 * product elsewhere or claim against its warranty. The last few characters let
 * a buyer holding the product confirm the page matches the sticker, while a
 * serial scraped from a marketplace photo of the QR stays unusable.
 */
export type SerialDisclosure =
  | { readonly disclosed: false }
  | {
      readonly disclosed: true;
      readonly suffix: string;
      /**
       * Published deliberately. Rendering four dots for a twelve-character serial
       * is a small misstatement on a page whose whole job is not to misstate, and
       * a serial's length is printed on every box of that model anyway.
       */
      readonly hiddenCharacters: number;
    };

/**
 * Reveals the last four characters only when more characters stay hidden than
 * are shown.
 *
 * The rule is stated as a principle rather than a threshold because the
 * threshold is where this goes wrong. A serial may legally be two characters
 * long, so a naive "show the last four" discloses the whole value; and at
 * exactly eight characters "the last four" is half of it. Revealing half is not
 * masking. The first length that satisfies the principle is nine.
 *
 * Counts code points, not UTF-16 units: the column has no format constraint, and
 * slicing a string by length can split a surrogate pair and emit a replacement
 * character on a public page.
 *
 * Trims first. The API trims on the way in, but the column's only guard is
 * `length(trim(serial)) >= 2`, so a row written by another path may not be.
 */
export function discloseSerial(serial: string): SerialDisclosure {
  const characters = Array.from(serial.trim());
  const hiddenCharacters = characters.length - DISCLOSED_CHARACTERS;

  if (hiddenCharacters <= DISCLOSED_CHARACTERS) {
    return { disclosed: false };
  }

  return {
    disclosed: true,
    suffix: characters.slice(-DISCLOSED_CHARACTERS).join(""),
    hiddenCharacters,
  };
}
