//! Signature checks and public key validation.
//!
//! Invariant owned here: no key the hub accepts lets someone without its secret make a signature that verifies.
//! `env::ed25519_verify` is ed25519-dalek's cofactorless `verify`. With a small-order public key A, `[k]A` takes at
//! most eight values, so a signature with `s = 0` and a torsion point as R verifies for about one message in eight
//! without any secret (audit finding F3). The hub refuses such keys, and non-canonical encodings, wherever it stores a
//! key that later verifies signatures: an agent key, a receipt key and the checkout key.

use near_sdk::env;

/// `p = 2^255 - 19` in little-endian, the field modulus. A canonical y coordinate is below it.
const P: [u8; 32] = [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
];

/// The canonical y coordinates of the eight small-order points of edwards25519, little-endian with the sign bit
/// cleared: the identity (y = 1), the point of order 2 (y = p - 1), the two of order 4 (y = 0) and the four of order
/// 8 (two y values, each with both signs). The same list as libsodium's `ge25519_has_small_order`, minus the
/// non-canonical encodings that the canonical check refuses anyway. `small_order_list_is_exactly_the_eight_torsion_points`
/// derives it from curve25519-dalek's `EIGHT_TORSION`.
pub const SMALL_ORDER_Y: [[u8; 32]; 5] = [
    [0; 32],
    [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf,
        0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
    ],
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
        0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
    ],
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ],
];

/// The y coordinate of an encoded point: the 32 bytes with the sign bit (the top bit of the last byte) cleared.
fn y_of(key: &[u8; 32]) -> [u8; 32] {
    let mut y = *key;
    y[31] &= 0x7f;
    y
}

/// True when the encoding's y coordinate is below `p`, so that no other 32 bytes encode the same point.
pub fn is_canonical(key: &[u8; 32]) -> bool {
    let y = y_of(key);
    // Little-endian comparison from the most significant byte down.
    for i in (0..32).rev() {
        if y[i] != P[i] {
            return y[i] < P[i];
        }
    }
    false
}

/// True when the key encodes one of the eight small-order points, with either sign.
pub fn has_small_order(key: &[u8; 32]) -> bool {
    let y = y_of(key);
    SMALL_ORDER_Y.contains(&y)
}

/// The rule for every public key the hub stores: canonical and not of small order.
pub fn is_acceptable_public_key(key: &[u8; 32]) -> bool {
    is_canonical(key) && !has_small_order(key)
}

/// Verifies an ed25519 signature over a 32-byte digest, exactly as nearcore does (ed25519-dalek `verify`).
pub fn verify_signature(digest: &[u8; 32], signature: &[u8; 64], key: &[u8; 32]) -> bool {
    env::ed25519_verify(signature, digest, key)
}
