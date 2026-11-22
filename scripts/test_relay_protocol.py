import base64
import unittest

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from decrypt_relay import decrypt_record, derive_key

TEST_PASSWORD = "unit-test-only-not-a-secret"


class RelayProtocolTests(unittest.TestCase):
    def test_utf8_record_round_trip(self):
        password = TEST_PASSWORD
        salt = b"0123456789abcdef"
        iv = b"0123456789ab"
        key = derive_key(password, salt, 20000)
        ciphertext = AESGCM(key).encrypt(iv, "中文消息：本地 Codex 已收到".encode("utf-8"), None)
        record = {
            "crypto": {
                "salt_b64": base64.b64encode(salt).decode("ascii"),
                "iv_b64": base64.b64encode(iv).decode("ascii"),
                "iterations": 20000,
            },
            "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
        }
        self.assertEqual(decrypt_record(record, password), "中文消息：本地 Codex 已收到")

    def test_wrong_password_is_rejected(self):
        password = TEST_PASSWORD
        salt = b"0123456789abcdef"
        iv = b"0123456789ab"
        ciphertext = AESGCM(derive_key(password, salt, 20000)).encrypt(iv, b"secret", None)
        record = {
            "crypto": {
                "salt_b64": base64.b64encode(salt).decode("ascii"),
                "iv_b64": base64.b64encode(iv).decode("ascii"),
                "iterations": 20000,
            },
            "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
        }
        with self.assertRaises(Exception):
            decrypt_record(record, "wrong-password")


if __name__ == "__main__":
    unittest.main()
