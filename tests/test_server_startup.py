"""Listener startup must not depend on reverse DNS availability."""
import tempfile
import unittest
from unittest.mock import patch

from backend.app import create_server


class ServerStartupTests(unittest.TestCase):
    def test_loopback_listener_does_not_resolve_its_hostname(self):
        config = {"shops": [{"shop_id": "synthetic-a", "name": "Synthetic"}], "clients": []}
        with tempfile.TemporaryDirectory() as directory, patch(
            "socket.getfqdn", side_effect=AssertionError("reverse DNS must not be needed")
        ) as lookup:
            server = create_server(config, directory, "127.0.0.1", 0)
            try:
                self.assertEqual(server.server_name, "127.0.0.1")
                self.assertGreater(server.server_port, 0)
                self.assertEqual(server.server_address, server.socket.getsockname())
                self.assertEqual(server.server_port, server.server_address[1])
                lookup.assert_not_called()
            finally:
                server.server_close()
