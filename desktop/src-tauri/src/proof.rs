//! The shell's check that the server answering is its own (D2): only a server holding this start's APP_SECRET can
//! answer a fresh challenge with HMAC-SHA256(secret, challenge). Matches the server's GET /app/hello.
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn expected(secret: &str, challenge: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(challenge.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 32 random bytes as 64 lowercase hex characters: a challenge, or this start's secret.
pub fn random_hex() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_servers_test_vector() {
        // The same vector as src/web/localMode.test.ts ("/app/hello answers the challenge with an HMAC of the key").
        assert_eq!(expected(&"s".repeat(40), &"ab".repeat(32)), "37a85455aabcc6be6a2858724eedc808f442dcf49c52a8752dd900a9e54e4ab3");
    }

    #[test]
    fn random_hex_is_64_lowercase_hex_characters_and_differs_each_time() {
        let a = random_hex();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, random_hex());
    }
}
