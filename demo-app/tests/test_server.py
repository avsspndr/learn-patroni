import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class HelpdeskServerTests(unittest.TestCase):
    def test_request_key_is_normalized_and_rejects_invalid_value(self):
        value = uuid.uuid4()
        self.assertEqual(server.normalize_request_key(str(value)), str(value))
        with self.assertRaises(server.ValidationError):
            server.normalize_request_key("not-a-uuid")

    def test_text_validation_trims_value_and_checks_limits(self):
        self.assertEqual(server.validate_text("  Проверить VPN  ", "Тема"), "Проверить VPN")
        with self.assertRaises(server.ValidationError):
            server.validate_text("", "Тема")
        with self.assertRaises(server.ValidationError):
            server.validate_text("1234", "Тема", maximum=3)

    def test_json_serializer_handles_database_values(self):
        timestamp = datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc)
        self.assertEqual(server.json_value(timestamp), timestamp.isoformat())
        value = uuid.uuid4()
        self.assertEqual(server.json_value(value), str(value))

    def test_activity_log_is_bounded_and_counts_results(self):
        server.OPERATION_LOG.clear()
        server.record_operation("create", True, "ok")
        server.record_operation("database_error", False, "failed")
        snapshot = server.activity_snapshot()
        self.assertEqual(snapshot["successes"], 1)
        self.assertEqual(snapshot["failures"], 1)
        self.assertEqual(len(snapshot["operations"]), 2)


if __name__ == "__main__":
    unittest.main()
