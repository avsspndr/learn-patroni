import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class DashboardServerTests(unittest.TestCase):
    def test_lsn_to_int_accepts_patroni_lsn_and_numeric_position(self):
        self.assertEqual(server.lsn_to_int("1/00000010"), (1 << 32) + 16)
        self.assertEqual(server.lsn_to_int(128), 128)
        self.assertIsNone(server.lsn_to_int("broken"))

    def test_replication_lag_combines_patroni_positions_and_cluster_report(self):
        nodes = [
            {"name": "db1", "reachable": True, "status": {"role": "primary", "xlog": {"location": 1200}}},
            {"name": "db2", "reachable": True, "status": {"role": "replica", "replication_state": "streaming", "xlog": {"received_location": 1100, "replayed_location": 1000}}},
        ]
        cluster = {"topology": {"members": [
            {"name": "db1", "role": "leader"},
            {"name": "db2", "role": "replica", "receive_lag": 50, "replay_lag": 150},
        ]}}
        snapshot = server.replication_lag_snapshot(nodes, cluster, 10)["db2"]
        self.assertEqual(snapshot["receive_lag"], 100)
        self.assertEqual(snapshot["apply_lag"], 100)
        self.assertEqual(snapshot["replay_lag"], 200)
        self.assertEqual(snapshot["primary_lsn"], 1200)

    def test_parse_prometheus_ignores_comments_and_keeps_labels(self):
        metrics = server.parse_prometheus(
            "# HELP patroni_primary role\n"
            "patroni_primary{scope=\"demo\"} 1\n"
            "broken value\n"
        )
        self.assertEqual(metrics, {'patroni_primary{scope="demo"}': 1.0})

    @patch.object(server, "patroni_action")
    def test_restart_all_nodes_is_rejected_before_patroni_call(self, patroni_action):
        status, result = server.execute_action({
            "action": "postgres_restart",
            "nodes": list(server.PATRONI_NODES),
        })
        self.assertEqual(status, 409)
        self.assertFalse(result["ok"])
        patroni_action.assert_not_called()

    @patch.object(server, "patroni_action")
    def test_restart_one_node_uses_restart_endpoint(self, patroni_action):
        patroni_action.return_value = {"ok": True, "status": 202, "message": "scheduled"}
        node = next(iter(server.PATRONI_NODES))
        status, result = server.execute_action({"action": "postgres_restart", "nodes": [node]})
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        patroni_action.assert_called_once_with(server.PATRONI_NODES[node], "/restart")

    @patch.object(server, "tcp_endpoint")
    @patch.object(server, "collect_etcd")
    @patch.object(server, "collect_cluster_details")
    @patch.object(server, "collect_node")
    def test_collect_cluster_keeps_bounded_state_history(self, collect_node, collect_details, collect_etcd, tcp_endpoint):
        names = list(server.PATRONI_NODES)
        collect_node.side_effect = [
            {"name": names[0], "url": server.PATRONI_NODES[names[0]], "reachable": True, "status": {"role": "primary", "state": "running", "timeline": 2, "patroni": {"scope": "demo"}}, "metrics": {}},
            {"name": names[1], "url": server.PATRONI_NODES[names[1]], "reachable": True, "status": {"role": "replica", "state": "running", "timeline": 2}, "metrics": {}},
        ]
        collect_details.return_value = {
            "topology": {"scope": "demo", "members": [
                {"name": names[0], "role": "leader", "timeline": 2},
                {"name": names[1], "role": "replica", "timeline": 2, "replay_lag": 128},
            ]},
            "history": [], "config": {}, "source": "test", "error": None,
        }
        tcp_endpoint.return_value = {"available": True, "latency_ms": 1}
        collect_etcd.return_value = {"reachable": True, "health": True, "members": [{}], "metrics": {}}
        server.STATE_HISTORY.clear()

        result = server.collect_cluster()

        self.assertEqual(result["state_history"][-1]["leader"], names[0])
        self.assertEqual(result["state_history"][-1]["lags"], {names[1]: 128})
        self.assertTrue(result["state_history"][-1]["write_available"])
        self.assertTrue(result["etcd"]["health"])
        self.assertLessEqual(server.STATE_HISTORY.maxlen, 180)

    @patch.object(server, "request")
    def test_collect_etcd_exposes_health_membership_and_metrics(self, request):
        request.side_effect = [
            ({"health": "true", "reason": ""}, 1.2),
            ("etcd_server_has_leader 1\n", 0.8),
            ({"members": [{"name": "etcd"}]}, 0.7),
        ]
        result = server.collect_etcd()
        self.assertTrue(result["health"])
        self.assertEqual(result["members"], [{"name": "etcd"}])
        self.assertEqual(result["metrics"]["etcd_server_has_leader"], 1)
        self.assertEqual(result["expected_members"], server.ETCD_EXPECTED_MEMBERS)


if __name__ == "__main__":
    unittest.main()
