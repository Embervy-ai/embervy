"""Unit tests for browse.py — configuration, guard, settle, reveal and film.
Stdlib only; needs neither Playwright nor Chromium.
Run: python3 -m unittest shared/tools/browser/test_browse.py
"""
# Tests browser guards and capture commands without a browser installation.
import http.client
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browse  # noqa: E402


class InstallerTest(unittest.TestCase):
    HERE = Path(__file__).resolve().parent
    SPEC = "playwright==1.64.0"

    def test_installer_uses_only_the_exact_playwright_pin(self):
        script = (self.HERE / "install.sh").read_text(encoding="utf-8")
        requirements = re.findall(r"\bplaywright\s*[<>=!~][^\s\"']*", script, re.IGNORECASE)
        self.assertEqual(requirements, [self.SPEC])
        self.assertIn(f'PLAYWRIGHT_SPEC="{self.SPEC}"', script)
        self.assertNotIn("EMBERVY_PLAYWRIGHT_SPEC", script)
        self.assertIn('--upgrade "$PLAYWRIGHT_SPEC"', script)

    def test_documented_playwright_pins_match_the_installer(self):
        for path in (self.HERE / "README.md", self.HERE.parents[2] / "INSTALL.md"):
            with self.subTest(path=path):
                text = path.read_text(encoding="utf-8")
                requirements = re.findall(r"\bplaywright\s*[<>=!~][^\s`]*", text, re.IGNORECASE)
                self.assertEqual(requirements, [self.SPEC])

    def test_installer_has_valid_bash_syntax(self):
        result = subprocess.run(
            ["bash", "-n", str(self.HERE / "install.sh")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class PathsTest(unittest.TestCase):
    HERE = "/srv/agent/shared/tools/browser"

    def test_defaults_live_under_the_agent_home(self):
        p = browse.paths({}, here=self.HERE)
        self.assertEqual(p["home"], "/srv/agent")
        self.assertEqual(p["browser_home"], "/srv/agent/state/browser")
        self.assertEqual(p["profile"], "/srv/agent/state/browser/profile")
        self.assertEqual(p["python"], "/srv/agent/state/browser/venv/bin/python")
        self.assertEqual(p["browsers"], "/srv/agent/state/browser/ms-playwright")
        self.assertEqual(p["log"], "/srv/agent/logs/browser.log")
        self.assertEqual(p["token"], "/srv/agent/state/browser/daemon.token")
        self.assertEqual(p["shot"], "/srv/agent/state/browser/shot.png")
        self.assertEqual(p["port"], browse.DEFAULT_PORT)
        for key in ("film", "pdf", "trace", "storage"):
            self.assertTrue(p[key].startswith("/srv/agent/state/browser/"), key)

    def test_home_moves_everything(self):
        p = browse.paths({"EMBERVY_HOME": "/opt/x"}, here=self.HERE)
        self.assertEqual(p["browser_home"], "/opt/x/state/browser")
        self.assertEqual(p["log"], "/opt/x/logs/browser.log")

    def test_explicit_overrides_win(self):
        env = {
            "EMBERVY_HOME": "/opt/x",
            "EMBERVY_BROWSER_HOME": "/data/b",
            "EMBERVY_BROWSER_PROFILE": "/data/profile",
            "EMBERVY_BROWSER_PYTHON": "/usr/bin/python3",
            "EMBERVY_BROWSER_LOG": "/var/log/b.log",
            "EMBERVY_BROWSER_PORT": "4011",
            "PLAYWRIGHT_BROWSERS_PATH": "/data/pw",
            "EMBERVY_BROWSER_UA": "test-agent",
        }
        p = browse.paths(env, here=self.HERE)
        self.assertEqual(p["browser_home"], "/data/b")
        self.assertEqual(p["profile"], "/data/profile")
        self.assertEqual(p["python"], "/usr/bin/python3")
        self.assertEqual(p["log"], "/var/log/b.log")
        self.assertEqual(p["port"], 4011)
        self.assertEqual(p["browsers"], "/data/pw")
        self.assertEqual(p["user_agent"], "test-agent")
        self.assertEqual(p["shot"], "/data/b/shot.png")

    def test_settings_read_only_the_requested_key(self):
        class Settings(dict):
            def __init__(self, values):
                super().__init__(values)
                self.reads = []

            def get(self, name, default=None):
                self.reads.append(name)
                return super().get(name, default)

        for value in (None, "", "4111"):
            env = Settings({} if value is None else {"EMBERVY_BROWSER_PORT": value})
            self.assertEqual(browse.setting(env, "EMBERVY_BROWSER_PORT"), value)
            self.assertEqual(env.reads, ["EMBERVY_BROWSER_PORT"])

    def test_empty_values_count_as_unset(self):
        p = browse.paths({"EMBERVY_HOME": "", "EMBERVY_BROWSER_HOME": "", "EMBERVY_BROWSER_PORT": ""}, here=self.HERE)
        self.assertEqual(p["home"], "/srv/agent")
        self.assertEqual(p["port"], browse.DEFAULT_PORT)

    def test_bad_port_falls_back(self):
        for bad in ("abc", "0", "70000", "-5"):
            self.assertEqual(browse.paths({"EMBERVY_BROWSER_PORT": bad}, here=self.HERE)["port"], browse.DEFAULT_PORT, bad)


class LifetimeTest(unittest.TestCase):
    def test_idle_uses_clock_and_command_arrivals(self):
        now = [0.0]
        lifetime = browse.DaemonLifetime(idle_minutes=2, clock=lambda: now[0])
        now[0] = 119
        self.assertIsNone(lifetime.reason())
        lifetime.command(lambda cmd: {"ok": True}, {})
        now[0] = 238
        self.assertIsNone(lifetime.reason())
        now[0] = 239
        self.assertIn("idle", lifetime.reason())

    def test_zero_disables_idle(self):
        now = [0.0]
        lifetime = browse.DaemonLifetime(idle_minutes=0, clock=lambda: now[0])
        now[0] = 10**9
        self.assertIsNone(lifetime.reason())

    def test_idle_never_ends_a_running_command(self):
        now = [0.0]
        lifetime = browse.DaemonLifetime(idle_minutes=1, clock=lambda: now[0])

        def command(cmd):
            now[0] = 120
            self.assertIsNone(lifetime.reason())
            return {"ok": True}

        self.assertEqual(lifetime.command(command, {}), {"ok": True})
        self.assertIn("idle", lifetime.reason())

    def test_command_failure_clears_busy(self):
        lifetime = browse.DaemonLifetime(idle_minutes=1, clock=lambda: 0)

        def command(cmd):
            raise ValueError("command failed")

        with self.assertRaises(ValueError):
            lifetime.command(command, {})
        self.assertFalse(lifetime.busy)

    def test_idle_settings(self):
        self.assertEqual(browse.paths({})["idle_minutes"], 30)
        for value, expected in (("0", 0), ("2.5", 2.5), ("", 30),
                                ("bad", 30), ("-1", 30), ("nan", 30), ("inf", 30)):
            self.assertEqual(browse.paths({"BROWSE_IDLE_MINUTES": value})["idle_minutes"], expected)

    def test_clean_idle_end_removes_token_and_keeps_profile(self):
        from types import ModuleType
        from unittest.mock import Mock, patch
        api = ModuleType("playwright.sync_api")
        api.sync_playwright = Mock()
        pw = api.sync_playwright.return_value.start.return_value
        ctx = pw.chromium.launch_persistent_context.return_value
        page = Mock()
        page.is_closed.return_value = False
        ctx.pages = [page]
        server = Mock()

        def serve():
            server.service_actions()

        server.serve_forever.side_effect = serve
        with tempfile.TemporaryDirectory() as home, \
                patch.dict(sys.modules, {"playwright.sync_api": api}), \
                patch.object(browse, "make_server", return_value=server), \
                patch.object(browse.DaemonLifetime, "reason", return_value="idle limit reached"):
            p = browse.paths({"EMBERVY_HOME": home})
            browse.browser_daemon(p, Mock(port=1234))
            self.assertFalse(os.path.exists(p["token"]))
            self.assertTrue(os.path.isdir(p["profile"]))
        ctx.close.assert_called_once_with()
        pw.stop.assert_called_once_with()
        server.server_close.assert_called_once_with()


class MemoryLifetimeTest(unittest.TestCase):
    def test_memory_decision_includes_measured_size(self):
        measured = [1024.0]
        lifetime = browse.DaemonLifetime(idle_minutes=0, max_mb=1024,
                                        memory_reader=lambda: measured[0])
        self.assertIsNone(lifetime.reason())
        measured[0] = 1025.5
        self.assertIn("1025.5 MB", lifetime.reason())

    def test_zero_disables_memory_reads(self):
        from unittest.mock import Mock
        reader = Mock(side_effect=AssertionError("memory should not be read"))
        lifetime = browse.DaemonLifetime(idle_minutes=0, max_mb=0, memory_reader=reader)
        self.assertIsNone(lifetime.reason())
        reader.assert_not_called()

    def test_memory_never_ends_a_running_command(self):
        from unittest.mock import Mock
        reader = Mock(return_value=2048)
        lifetime = browse.DaemonLifetime(idle_minutes=0, max_mb=1024, memory_reader=reader)

        def command(cmd):
            self.assertIsNone(lifetime.reason())
            reader.assert_not_called()
            return {"ok": True}

        self.assertEqual(lifetime.command(command, {}), {"ok": True})
        self.assertIn("memory", lifetime.reason())
        reader.assert_called_once_with()

    def test_unavailable_memory_is_silent(self):
        from unittest.mock import patch
        lifetime = browse.DaemonLifetime(idle_minutes=0, max_mb=1, memory_reader=lambda: None)
        with patch("builtins.print") as output:
            lifetime.check()
        output.assert_not_called()

    def test_memory_settings(self):
        self.assertEqual(browse.paths({})["max_mb"], 1024)
        for value, expected in (("0", 0), ("256", 256), ("", 1024),
                                ("bad", 1024), ("-1", 1024), ("nan", 1024), ("inf", 1024)):
            self.assertEqual(browse.paths({"BROWSE_MAX_MB": value})["max_mb"], expected)

    def test_process_tree_includes_all_threads_and_counts_each_pid_once(self):
        from pathlib import Path
        with tempfile.TemporaryDirectory() as proc:
            root = Path(proc)
            for pid, rss, tasks in (
                (10, 1024, {10: "11 99", 20: "12"}),
                (11, 2048, {11: "13"}),
                (12, 4096, {12: "13"}),
                (13, 8192, {13: "10"}),
            ):
                process = root / str(pid)
                process.mkdir()
                (process / "status").write_text(f"VmRSS:\t{rss} kB\n")
                for tid, children in tasks.items():
                    task = process / "task" / str(tid)
                    task.mkdir(parents=True)
                    (task / "children").write_text(children)
            self.assertEqual(browse.process_tree_mb(pid=10, proc=proc), 15)

    def test_missing_proc_is_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(browse.process_tree_mb(proc=os.path.join(root, "missing")))

    def test_memory_end_logs_one_line(self):
        from unittest.mock import patch
        lifetime = browse.DaemonLifetime(idle_minutes=0, max_mb=1, memory_reader=lambda: 2.5)
        with patch("builtins.print") as output, self.assertRaises(KeyboardInterrupt):
            lifetime.check()
        output.assert_called_once_with("browse daemon stopping: memory limit exceeded: 2.5 MB > 1 MB", flush=True)


class RestartTest(unittest.TestCase):
    def test_daemon_lock_prevents_overlapping_profile_users(self):
        from unittest.mock import Mock, patch
        calls = []

        def run(p, proxy):
            calls.append(p)
            if len(calls) == 1:
                browse.daemon(p)

        with tempfile.TemporaryDirectory() as home, \
                patch.object(browse, "GuardProxy", return_value=Mock()) as proxy, \
                patch.object(browse, "browser_allow", return_value=[]), \
                patch.object(browse, "browser_daemon", side_effect=run):
            proxy.return_value.__enter__ = Mock()
            proxy.return_value.__exit__ = Mock(return_value=False)
            p = browse.paths({"EMBERVY_HOME": home})
            browse.daemon(p)
            self.assertEqual(len(calls), 1)
            browse.daemon(p)
            self.assertEqual(len(calls), 2)

    def test_no_command_runs_after_exit_decision(self):
        from unittest.mock import Mock, patch
        now = [0]
        lifetime = browse.DaemonLifetime(idle_minutes=1, clock=lambda: now[0])
        now[0] = 60
        with patch("builtins.print"), self.assertRaises(KeyboardInterrupt):
            lifetime.check()
        handle = Mock()
        with self.assertRaises(ConnectionError):
            lifetime.command(handle, {})
        handle.assert_not_called()

    def test_autostart_returns_the_detached_child(self):
        import subprocess
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as home, patch.object(subprocess, "Popen") as spawn:
            p = browse.paths({"EMBERVY_HOME": home})
            child = browse.autostart(p)
        self.assertIs(child, spawn.return_value)
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])
        self.assertEqual(spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_cli_restarts_child_that_exits_during_shutdown(self):
        from unittest.mock import Mock, patch
        child = Mock()
        child.poll.return_value = 0
        with patch.object(sys, "argv", ["browse.py", "url"]), \
                patch.object(browse, "send", side_effect=[ConnectionRefusedError(),
                                                        ConnectionRefusedError(), {"ok": True}]), \
                patch.object(browse, "autostart", return_value=child) as start, \
                patch.object(browse.time, "sleep"), patch("builtins.print"):
            browse.main()
        self.assertEqual(start.call_count, 2)

    def test_cli_does_not_spawn_again_while_child_is_starting(self):
        from unittest.mock import Mock, patch
        child = Mock()
        child.poll.return_value = None
        with patch.object(sys, "argv", ["browse.py", "url"]), \
                patch.object(browse, "send", side_effect=[ConnectionRefusedError(),
                                                        ConnectionRefusedError(), {"ok": True}]), \
                patch.object(browse, "autostart", return_value=child) as start, \
                patch.object(browse.time, "sleep"), patch("builtins.print"):
            browse.main()
        start.assert_called_once()

    def test_cli_does_not_retry_a_timed_out_command(self):
        from unittest.mock import patch
        with patch.object(sys, "argv", ["browse.py", "url"]), \
                patch.object(browse, "send", side_effect=TimeoutError()), \
                patch.object(browse, "autostart") as start, patch("builtins.print"), \
                self.assertRaises(SystemExit) as stopped:
            browse.main()
        self.assertEqual(stopped.exception.code, 2)
        start.assert_not_called()

    def test_changed_token_is_retried_instead_of_reported_as_wrong_port(self):
        from unittest.mock import patch
        for initially_present in (False, True):
            with self.subTest(initially_present=initially_present), tempfile.TemporaryDirectory() as home:
                p = {"port": 3055, "token": os.path.join(home, "daemon.token")}
                if initially_present:
                    browse.write_private(p["token"], browse.secrets.token_hex(16))

                def reply(request, timeout):
                    browse.write_private(p["token"], browse.secrets.token_hex(16))
                    raise browse.urllib.error.HTTPError(request.full_url, 403, "forbidden", {}, None)

                with patch.object(browse.urllib.request, "urlopen", side_effect=reply), \
                        self.assertRaises(ConnectionError):
                    browse.send({"op": "url"}, p)


class DaemonEndTest(unittest.TestCase):
    def run_end(self, mode, close_error=False):
        from pathlib import Path
        from types import ModuleType
        from unittest.mock import Mock, patch
        api = ModuleType("playwright.sync_api")
        api.sync_playwright = Mock()
        pw = api.sync_playwright.return_value.start.return_value
        ctx = Mock()
        page = Mock()
        page.is_closed.return_value = False
        ctx.pages = [page]
        server = Mock()
        now, memory = [0.0], [0.0]
        owner_thread = threading.get_ident()
        events = []
        lifetime_type = browse.DaemonLifetime

        def policy(**kwargs):
            return lifetime_type(clock=lambda: now[0], memory_reader=lambda: memory[0], **kwargs)

        def launch(profile, **kwargs):
            (Path(profile) / "marker").write_text("persistent")
            return ctx

        def serve():
            if mode == "idle":
                now[0] = 60
            else:
                memory[0] = 2.5
            server.service_actions()
            self.fail("the request loop continued after its exit decision")

        def close():
            self.assertEqual(threading.get_ident(), owner_thread)
            self.assertFalse(os.path.exists(p["token"]))
            server.server_close.assert_called_once_with()
            events.append("context")
            if close_error:
                raise RuntimeError("close failed")

        def stop():
            self.assertEqual(threading.get_ident(), owner_thread)
            events.append("driver")

        pw.chromium.launch_persistent_context.side_effect = launch
        ctx.close.side_effect = close
        pw.stop.side_effect = stop
        server.serve_forever.side_effect = serve
        with tempfile.TemporaryDirectory() as home, \
                patch.dict(sys.modules, {"playwright.sync_api": api}), \
                patch.object(browse, "make_server", return_value=server), \
                patch.object(browse, "DaemonLifetime", side_effect=policy), \
                patch("builtins.print") as output:
            p = browse.paths({"EMBERVY_HOME": home, "BROWSE_IDLE_MINUTES": "1", "BROWSE_MAX_MB": "1"})
            if close_error:
                with self.assertRaisesRegex(RuntimeError, "close failed"):
                    browse.browser_daemon(p, Mock(port=1234))
            else:
                self.assertIsNone(browse.browser_daemon(p, Mock(port=1234)))
            self.assertFalse(os.path.exists(p["token"]))
            self.assertEqual((Path(p["profile"]) / "marker").read_text(), "persistent")
        self.assertEqual(events, ["context", "driver"])
        ctx.close.assert_called_once_with()
        pw.stop.assert_called_once_with()
        lines = [call.args[0] for call in output.call_args_list
                 if call.args[0].startswith("browse daemon stopping:")]
        self.assertEqual(len(lines), 1)
        self.assertIn(mode, lines[0])
        if mode == "memory":
            self.assertIn("2.5 MB", lines[0])

    def test_idle_cleanup_stays_on_daemon_thread(self):
        self.run_end("idle")

    def test_memory_cleanup_stays_on_daemon_thread(self):
        self.run_end("memory")

    def test_driver_stops_even_if_context_close_fails(self):
        self.run_end("idle", close_error=True)


class CliTest(unittest.TestCase):
    def test_build_cmd(self):
        self.assertEqual(browse.build_cmd(["url"]), {"op": "url"})
        self.assertEqual(browse.build_cmd(["goto", "about:blank"]), {"op": "goto", "arg": "about:blank"})
        self.assertEqual(browse.build_cmd(["fill", "e12", "hello", "world"]),
                         {"op": "fill", "arg": "e12", "arg2": "hello world"})


class TokenGateTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = temporary.name
        self.seen = []

        def handle(cmd):
            self.seen.append(cmd)
            return {"ok": True, "echo": cmd.get("op")}

        self.server = browse.make_server(0, "right-token", handle)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.p = {"port": self.server.server_port, "token": os.path.join(self.tmp, "daemon.token")}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_right_token_passes(self):
        browse.write_private(self.p["token"], "right-token")
        self.assertEqual(browse.send({"op": "url"}, self.p), {"ok": True, "echo": "url"})
        self.assertEqual(self.seen, [{"op": "url"}])

    def test_wrong_or_missing_token_is_refused(self):
        browse.write_private(self.p["token"], "someone-elses")
        with self.assertRaises(browse.Forbidden):
            browse.send({"op": "eval", "arg": "1"}, self.p)
        os.remove(self.p["token"])
        with self.assertRaises(browse.Forbidden):
            browse.send({"op": "eval", "arg": "1"}, self.p)
        self.assertEqual(self.seen, [], "a refused request must never reach the browser")

    def test_plain_post_without_header_is_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.p["port"], timeout=5)
        conn.request("POST", "/", body='{"op":"goto","arg":"about:blank"}', headers={"Content-Type": "text/plain"})
        self.assertEqual(conn.getresponse().status, 403)
        self.assertEqual(self.seen, [])

    def test_token_file_is_owner_only(self):
        browse.write_private(self.p["token"], "x")
        self.assertEqual(stat.S_IMODE(os.stat(self.p["token"]).st_mode), 0o600)


class AddressTest(unittest.TestCase):
    def test_non_public_classes(self):
        blocked = ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
                   "169.254.169.254", "100.64.0.1", "224.0.0.1", "240.0.0.1",
                   "0.0.0.0", "192.0.2.1", "::", "::1", "fc00::1", "fe80::1",
                   "ff02::1", "2001:db8::1", "100::1", "fe80::1%eth0",
                   "2002:7f00:1::1", "64:ff9b::7f00:1"]
        for address in blocked:
            with self.subTest(address=address):
                self.assertFalse(browse.public_address(address))
                if ":" not in address:
                    self.assertFalse(browse.public_address("::ffff:" + address))
        for address in ("8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"):
            self.assertTrue(browse.public_address(address))

    def test_launch_arguments(self):
        args = browse.chromium_args(4321)
        for flag in ("--proxy-server=http://127.0.0.1:4321", "--proxy-bypass-list=<-loopback>",
                     "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                     "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
                     "--dns-over-https-mode=off"):
            self.assertIn(flag, args)


class ProxyTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import asyncio
        self.addresses = ["8.8.8.8"]
        self.connections = []
        self.resolutions = []
        self.logs = []
        self.upstream_data = bytearray()

        async def resolver(host, port):
            self.resolutions.append((host, port))
            return self.addresses

        class Writer:
            def write(inner, data):
                self.upstream_data.extend(data)

            async def drain(inner):
                pass

            def close(inner):
                pass

        async def connector(address, port):
            self.connections.append((address, port))
            return asyncio.StreamReader(), Writer()

        self.proxy = browse.GuardProxy(resolver, connector, self.logs.append)
        await self.proxy.start()
        self.writers = []

    async def asyncTearDown(self):
        for writer in self.writers:
            writer.close()
            # Reset connections can raise during teardown even though they are closed.
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass
        await self.proxy.stop()

    async def request(self, request):
        import asyncio
        reader, writer = await asyncio.open_connection("127.0.0.1", self.proxy.port)
        self.writers.append(writer)
        writer.write(request.encode())
        await writer.drain()
        return reader, writer

    async def status(self, target):
        import asyncio
        reader, _ = await self.request(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n")
        return await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)

    async def test_private_dns_and_mixed_answers_are_refused(self):
        for answers in (["127.0.0.1"], ["8.8.8.8", "::1"], []):
            self.addresses = answers
            self.assertIn(b"403", await self.status("example.test:443"))
        self.assertEqual(self.connections, [])
        self.assertEqual(len(self.logs), 3)

    async def test_ipv6_failure_falls_back_to_ipv4(self):
        self.addresses = ["2606:4700:4700::1111", "8.8.8.8"]
        connector = self.proxy.connector

        async def fallback(address, port):
            if address == self.addresses[0]:
                self.connections.append((address, port))
                raise OSError(101, "Network is unreachable")
            return await connector(address, port)

        self.proxy.connector = fallback
        self.assertIn(b"200", await self.status("example.test:443"))
        self.assertEqual(self.connections, [(address, 443) for address in self.addresses])
        self.assertEqual(self.logs, [])

    async def test_all_connection_failures_are_logged(self):
        self.addresses = ["2606:4700:4700::1111", "8.8.8.8"]

        async def failing(address, port):
            self.connections.append((address, port))
            raise OSError(101 if ":" in address else 111, "connection failed")

        self.proxy.connector = failing
        self.assertIn(b"403", await self.status("example.test:443"))
        self.assertEqual(self.connections, [(address, 443) for address in self.addresses])
        self.assertEqual(len(self.logs), 1)
        for detail in ("example.test:443", *self.addresses, "101", "111", "connection failed"):
            self.assertIn(detail, self.logs[0])

    async def test_blocked_answer_prevents_all_connection_attempts(self):
        self.addresses = ["2606:4700:4700::1111", "8.8.8.8", "127.0.0.1"]
        self.assertIn(b"403", await self.status("example.test:443"))
        self.assertEqual(self.connections, [])
        self.assertIn("not a public address", self.logs[0])

    async def test_timed_out_address_falls_back(self):
        import asyncio
        self.addresses = ["2606:4700:4700::1111", "8.8.8.8"]
        self.proxy.ATTEMPT_TIMEOUT = 0.01
        connector = self.proxy.connector

        async def slow(address, port):
            if address == self.addresses[0]:
                self.connections.append((address, port))
                await asyncio.sleep(10)
            return await connector(address, port)

        self.proxy.connector = slow
        self.assertIn(b"200", await self.status("example.test:443"))
        self.assertEqual(self.connections, [(address, 443) for address in self.addresses])

    async def test_allowed_loopback_connection_is_pinned(self):
        self.assertIn(b"X-Embervy-Guard: refused\r\n", await self.status("127.0.0.1:3030"))
        self.proxy.allow = browse.parse_allow("127.0.0.1:3030", self.logs.append)
        self.assertIn(b"200", await self.status("127.0.0.1:3030"))
        self.assertIn(b"403", await self.status("127.0.0.1:3031"))
        self.assertEqual(self.connections, [("127.0.0.1", 3030)])

    async def test_public_dns_is_pinned(self):
        self.assertIn(b"200", await self.status("example.test:443"))
        self.assertEqual(self.connections, [("8.8.8.8", 443)])
        self.assertEqual(self.resolutions, [("example.test", 443)])

    async def test_ports_and_literals(self):
        for target in ("example.test:0", "example.test:22", "example.test:8080", "127.0.0.1:80", "[::1]:443"):
            self.assertIn(b"403", await self.status(target))
        self.assertEqual(self.connections, [])
        self.assertEqual(self.resolutions, [])
        self.assertIn(b"200", await self.status("8.8.8.8:80"))
        self.assertEqual(self.connections, [("8.8.8.8", 80)])

    async def test_http_and_websocket_use_checked_ip(self):
        import asyncio
        for scheme in ("http", "ws"):
            await self.request(f"GET {scheme}://example.test/path?q=1 HTTP/1.1\r\nHost: wrong.test\r\nUpgrade: websocket\r\n\r\n")
            for _ in range(100):
                if len(self.connections) == (1 if scheme == "http" else 2):
                    break
                await asyncio.sleep(0.01)
        self.assertEqual(self.connections, [("8.8.8.8", 80), ("8.8.8.8", 80)])
        self.assertIn(b"GET /path?q=1 HTTP/1.1\r\nHost: example.test\r\n", self.upstream_data)
        self.assertNotIn(b"wrong.test", self.upstream_data)

    async def test_connection_limit(self):
        self.proxy.MAX_CONNECTIONS = 1
        self.assertIn(b"200", await self.status("example.test:443"))
        self.assertIn(b"403", await self.status("example.test:443"))
        self.assertEqual(len(self.connections), 1)


class AllowTest(unittest.IsolatedAsyncioTestCase):
    async def test_local_ports_and_pinning(self):
        with self.assertRaises(ValueError):
            await browse.GuardProxy().target("127.0.0.1", 3030)
        proxy = browse.GuardProxy(allow="127.0.0.1:3030")
        self.assertEqual(await proxy.target("127.0.0.1", 3030), ["127.0.0.1"])
        with self.assertRaises(ValueError):
            await proxy.target("127.0.0.1", 3031)

    async def test_networks_and_ipv6(self):
        proxy = browse.GuardProxy(allow="192.168.1.0/24:8080,100.64.0.0/10,[::1]:3030,[fd12::/32]:8080")
        for host, port in (("192.168.1.20", 8080), ("100.101.102.103", 80),
                           ("100.101.102.103", 443), ("::1", 3030), ("fd12::1", 8080)):
            self.assertEqual(await proxy.target(host, port), [host])
        for host, port in (("192.168.1.20", 80), ("100.101.102.103", 8080), ("::1", 443)):
            with self.assertRaises(ValueError):
                await proxy.target(host, port)

    async def test_every_dns_answer_must_pass(self):
        async def resolver(host, port):
            return ["127.0.0.1", "127.0.0.2"]
        proxy = browse.GuardProxy(resolver=resolver, allow="127.0.0.1:3030")
        with self.assertRaises(ValueError):
            await proxy.target("example.test", 3030)

    async def test_bad_entries_do_not_discard_good_entries(self):
        logs = []
        proxy = browse.GuardProxy(logger=logs.append,
                                 allow="0.0.0.0/0,10.0.0.0/7,::/0,fd00::/31,nonsense,localhost,127.0.0.1:3030")
        self.assertEqual(len(logs), 6)
        self.assertTrue(all("ignored EMBERVY_BROWSER_ALLOW" in line for line in logs))
        self.assertEqual(await proxy.target("127.0.0.1", 3030), ["127.0.0.1"])

    async def test_metadata_never_passes(self):
        hosts = ("169.254.169.254", "fd00:ec2::254", "::ffff:169.254.169.254",
                 "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1")
        proxy = browse.GuardProxy(allow=",".join(hosts))
        for host in hosts:
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, "metadata"):
                await proxy.target(host, 80)

    async def test_refusal_headers_are_safe(self):
        from unittest.mock import AsyncMock, Mock
        writer = Mock()
        writer.drain = AsyncMock()
        proxy = browse.GuardProxy(logger=lambda reason: None)
        await proxy.refuse(writer, "host\r\ninjected: header")
        header = writer.write.call_args.args[0]
        self.assertIn(b"X-Embervy-Guard: refused\r\n", header)
        self.assertNotIn(b"\r\ninjected:", header)


class AllowSourceTest(unittest.TestCase):
    def test_environment_precedence_and_file(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, ".env"), "w") as output:
                output.write("OTHER=ignored\nEMBERVY_BROWSER_ALLOW='127.0.0.1:3030,100.101.102.103'\n")
            with patch.dict(os.environ, {"EMBERVY_HOME": home}, clear=True):
                self.assertEqual(browse.browser_allow(browse.paths()["home"]), "127.0.0.1:3030,100.101.102.103")
                os.environ["EMBERVY_BROWSER_ALLOW"] = "[::1]:3030"
                self.assertEqual(browse.browser_allow(home), "[::1]:3030")
                os.environ["EMBERVY_BROWSER_ALLOW"] = ""
                self.assertEqual(browse.browser_allow(home), "")

    def test_file_read_is_bounded(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(browse.browser_allow(home, {}), "")
            with open(os.path.join(home, ".env"), "w") as output:
                output.write("#" * 65536 + "\nEMBERVY_BROWSER_ALLOW=127.0.0.1\n")
            self.assertEqual(browse.browser_allow(home, {}), "")


class NavigationTest(unittest.TestCase):
    def test_goto_guard_response_and_normal_responses(self):
        from types import ModuleType
        from unittest.mock import Mock, patch
        api = ModuleType("playwright.sync_api")
        api.sync_playwright = Mock()
        pw = api.sync_playwright.return_value.start.return_value
        ctx = pw.chromium.launch_persistent_context.return_value
        page = Mock()
        page.is_closed.return_value = False
        page.url = "http://127.0.0.1:3030/"
        page.title.return_value = "App"
        ctx.pages = [page]
        results = []

        def make_server(port, token, handle):
            server = Mock()

            def serve():
                for response in (
                    Mock(status=403, headers={"x-embervy-guard": "refused", "x-embervy-guard-reason": browse.quote("127.0.0.1 is not a public address (add it to EMBERVY_BROWSER_ALLOW to allow it)")}),
                    Mock(status=403, headers={}), Mock(status=200, headers={}), None,
                ):
                    page.goto.return_value = response
                    results.append(handle({"op": "goto", "arg": page.url}))
            server.serve_forever.side_effect = serve
            return server

        with tempfile.TemporaryDirectory() as home, patch.dict(sys.modules, {"playwright.sync_api": api}), \
                patch.object(browse, "make_server", side_effect=make_server):
            browse.browser_daemon(browse.paths({"EMBERVY_HOME": home}), Mock(port=1234))
        self.assertFalse(results[0]["ok"])
        self.assertIn("refused by the browser guard: 127.0.0.1", results[0]["error"])
        self.assertIn("EMBERVY_BROWSER_ALLOW", results[0]["error"])
        self.assertTrue(all(result["ok"] for result in results[1:]))
        self.assertEqual(page.wait_for_timeout.call_count, 3)


class FakePage:
    def __init__(self, results=()):
        self.results = iter(results)
        self.calls = []
        self.clock = 0.0

    def evaluate(self, script, arg=None):
        self.calls.append(("evaluate", script, arg))
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return result

    def wait_for_timeout(self, ms):
        self.calls.append(("wait", ms))
        self.clock += ms / 1000

    def screenshot(self, **kwargs):
        self.calls.append(("screenshot", kwargs))
        self.clock += 0.1
        return b"fake png"


class SettleTest(unittest.TestCase):
    def run_settle(self, page, timeout=4000):
        from unittest.mock import patch
        with patch.object(browse.time, "monotonic", side_effect=lambda: page.clock):
            return browse.settle(page, timeout)

    def test_waits_for_running_and_pending_finite_animations(self):
        page = FakePage([True,
                         [{"running": True, "iterations": 1}, {"running": True, "iterations": 2}],
                         [{"running": True, "iterations": 1}], [], True])
        result = self.run_settle(page)
        self.assertEqual(result, {"waited_ms": 100, "pending_animations": 2, "timed_out": False})
        scripts = [c[1] for c in page.calls if c[0] == "evaluate"]
        self.assertIn("document.fonts.ready", scripts[0])
        self.assertIn("document.getAnimations()", scripts[1])
        self.assertIn("a.pending", scripts[1])
        self.assertEqual(scripts[-1].count("= requestAnimationFrame("), 2)

    def test_ignores_infinite_and_paused_animations(self):
        page = FakePage([True, [{"running": True, "iterations": None},
                                {"running": False, "iterations": 1}], True])
        result = self.run_settle(page)
        self.assertEqual(result["pending_animations"], 0)
        self.assertFalse(result["timed_out"])
        self.assertFalse(any(c[0] == "wait" for c in page.calls))
        self.assertIn("Number.isFinite", page.calls[1][1])

    def test_stops_polling_at_shared_timeout_without_raising(self):
        running = [{"running": True, "iterations": 1}]
        page = FakePage([True, running, running, running, running])
        result = self.run_settle(page, 125)
        self.assertTrue(result["timed_out"])
        self.assertEqual(result["pending_animations"], 1)
        self.assertEqual(result["waited_ms"], 125)
        waits = [c[1] for c in page.calls if c[0] == "wait"]
        self.assertEqual(len(waits), 3)
        for actual, expected in zip(waits, (50, 50, 25)):
            self.assertAlmostEqual(actual, expected)

    def test_font_and_frame_timeouts_are_reported(self):
        for values in ([False], [True, [], False]):
            with self.subTest(values=values):
                page = FakePage(values)
                self.assertTrue(self.run_settle(page)["timed_out"])
                self.assertTrue(all("Promise.race" in c[1] for c in page.calls
                                    if c[0] == "evaluate" and "getAnimations" not in c[1]))

    def test_zero_budget_does_not_wait(self):
        page = FakePage([False])
        result = self.run_settle(page, 0)
        self.assertTrue(result["timed_out"])
        self.assertEqual(page.calls[0][2], 0)


class RevealTest(unittest.TestCase):
    @staticmethod
    def metrics(y, height=2700):
        return {"x": 23, "y": y, "viewport": 900, "height": height}

    def test_walks_in_viewports_stops_at_bottom_and_restores_xy(self):
        page = FakePage([self.metrics(450), None, self.metrics(0),
                         None, self.metrics(900), None, self.metrics(1800), None])
        self.assertEqual(browse.reveal(page), 2)
        positions = [c[2] for c in page.calls if c[0] == "evaluate" and c[2] is not None]
        self.assertEqual(positions, [{"x": 23, "y": y} for y in (0, 900, 1800, 450)])
        self.assertEqual([c[1] for c in page.calls if c[0] == "wait"], [250, 250, 250])
        self.assertIn("behavior: 'instant'", page.calls[1][1])

    def test_max_steps_bounds_growing_page(self):
        page = FakePage([self.metrics(200), None, self.metrics(0),
                         None, self.metrics(900, 3600), None, self.metrics(1800, 4500), None])
        self.assertEqual(browse.reveal(page, max_steps=2), 2)
        self.assertEqual(page.calls[-1][2], {"x": 23, "y": 200})

    def test_short_page_stays_at_top(self):
        page = FakePage([self.metrics(0, 500), None, self.metrics(0, 500), None])
        self.assertEqual(browse.reveal(page), 0)

    def test_restores_on_failure(self):
        page = FakePage([self.metrics(200), None, RuntimeError("page changed"), None])
        with self.assertRaisesRegex(RuntimeError, "page changed"):
            browse.reveal(page)
        self.assertEqual(page.calls[-1][2], {"x": 23, "y": 200})


class FilmTest(unittest.TestCase):
    def test_defaults_clamps_and_path(self):
        self.assertEqual(browse.film_args(), (4, 8, "state/browser/film.png"))
        for seconds, rest, expected in (("0", "1", (1, 2)), ("99", "99", (20, 16)),
                                         ("2.5", "5 /tmp/a film.png", (2.5, 5))):
            with self.subTest(seconds=seconds, rest=rest):
                cmd = browse.build_cmd(["film", seconds, *rest.split()])
                result = browse.film_args(cmd["arg"], cmd["arg2"])
                self.assertEqual(result[:2], expected)
                if "film.png" in rest:
                    self.assertEqual(result[2], "/tmp/a film.png")
        self.assertEqual(browse.film_args(default_path="/home/b/film.png")[2], "/home/b/film.png")
        for seconds in ("nan", "inf", "nope"):
            with self.assertRaises(ValueError):
                browse.film_args(seconds)

    def test_even_times_include_both_endpoints(self):
        self.assertEqual(browse.film_times(4, 5), [0, 1, 2, 3, 4])
        times = browse.film_times(4, 8)
        self.assertEqual(len(times), 8)
        for a, b in zip(times, times[1:]):
            self.assertAlmostEqual(b - a, 4 / 7)

    def test_grid_has_one_labelled_cell_per_frame_and_four_columns(self):
        from html.parser import HTMLParser

        class GridParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = []
                self.text = []

            def handle_starttag(self, tag, attrs):
                self.tags.append((tag, dict(attrs)))

            def handle_data(self, data):
                self.text.append(data)

        markup = browse.film_html(["cG5n"] * 8, browse.film_times(3.5, 8))
        parser = GridParser()
        parser.feed(markup)
        for tag in ("figure", "figcaption", "img"):
            self.assertEqual(sum(t == tag for t, _ in parser.tags), 8)
        for stamp in ("0.0 s", "0.5 s", "3.5 s"):
            self.assertIn(stamp, parser.text)
        self.assertIn("repeat(4,", markup)
        self.assertTrue(all(attrs["src"].startswith("data:image/png;base64,")
                            for tag, attrs in parser.tags if tag == "img"))

    def test_capture_uses_deadlines_and_closes_compositor(self):
        from unittest.mock import Mock, patch
        page = FakePage()
        context = Mock()
        with patch.object(browse.time, "monotonic", side_effect=lambda: page.clock):
            result = browse.film(page, context, 2, 3, "/tmp/film.png")
        self.assertEqual(result["frame_times"], [0, 1, 2])
        self.assertEqual(result["path"], "/tmp/film.png")
        self.assertEqual(sum(c[0] == "screenshot" for c in page.calls), 3)
        self.assertTrue(all(c[1]["full_page"] is False for c in page.calls if c[0] == "screenshot"))
        self.assertEqual(len([c for c in page.calls if c[0] == "evaluate"]), 0)
        waits = [c[1] for c in page.calls if c[0] == "wait"]
        for wait in waits:
            self.assertAlmostEqual(wait, 900)
        context.new_page.assert_called_once_with()
        grid = context.new_page.return_value
        grid.screenshot.assert_called_once_with(path="/tmp/film.png", type="png", full_page=True)
        grid.close.assert_called_once_with()

    def test_compositor_closes_on_error(self):
        from unittest.mock import Mock
        context = Mock()
        context.new_page.return_value.set_content.side_effect = RuntimeError("render failed")
        page = FakePage()
        from unittest.mock import patch
        with patch.object(browse.time, "monotonic", side_effect=lambda: page.clock):
            with self.assertRaisesRegex(RuntimeError, "render failed"):
                browse.film(page, context, 1, 2, "film.png")
        context.new_page.return_value.close.assert_called_once_with()


class ScreenshotTest(unittest.TestCase):
    def test_now_parsing_keeps_existing_positions(self):
        for words, expected in (
            (["shot", "--now"], {"op": "shot", "now": True}),
            (["shot", "a b.png", "--now"], {"op": "shot", "arg": "a b.png", "now": True}),
            (["shotfull", "full.png", "--now"], {"op": "shotfull", "arg": "full.png", "now": True}),
            (["shotel", "#card", "--now"], {"op": "shotel", "arg": "#card", "now": True}),
            (["shotel", "#card", "a b.png", "--now"],
             {"op": "shotel", "arg": "#card", "arg2": "a b.png", "now": True}),
        ):
            with self.subTest(words=words):
                self.assertEqual(browse.build_cmd(words), expected)

    def test_handler_settles_default_shots_but_not_now(self):
        from types import ModuleType
        from unittest.mock import Mock, patch
        api = ModuleType("playwright.sync_api")
        api.sync_playwright = Mock()
        context = api.sync_playwright.return_value.start.return_value.chromium.launch_persistent_context.return_value
        page = Mock()
        page.is_closed.return_value = False
        context.pages = [page]
        results, events = [], []
        page.screenshot.side_effect = lambda **kw: events.append("shot")
        page.locator.return_value.first.scroll_into_view_if_needed.side_effect = lambda **kw: events.append("scroll-element")
        page.locator.return_value.first.screenshot.side_effect = lambda **kw: events.append("shotel")

        def make_server(port, token, handle):
            server = Mock()

            def serve():
                for words in (["shot"], ["shot", "--now"], ["shotfull", "full.png"],
                              ["shotfull", "--now"], ["shotel", "#card", "card.png"],
                              ["shotel", "#card", "--now"]):
                    results.append(handle(browse.build_cmd(words)))
                results.append(handle(browse.build_cmd(["film", "0", "99", "/tmp/motion.png"])))
            server.serve_forever.side_effect = serve
            return server

        def rest(page):
            events.append("settle")
            return {"timed_out": False}

        def walk(page):
            events.append("reveal")
            return 3

        with tempfile.TemporaryDirectory() as home, patch.dict(sys.modules, {"playwright.sync_api": api}), \
                patch.object(browse, "make_server", side_effect=make_server), \
                patch.object(browse, "settle", side_effect=rest) as settled, \
                patch.object(browse, "reveal", side_effect=walk), \
                patch.object(browse, "film", return_value={"ok": True}) as filmed:
            browse.browser_daemon(browse.paths({"EMBERVY_HOME": home}), Mock(port=1234))
        self.assertEqual(settled.call_count, 3)
        self.assertEqual(events, ["settle", "shot", "shot", "reveal", "settle", "shot",
                                  "reveal", "shot", "scroll-element", "settle", "shotel", "shotel"])
        for i in (1, 3, 5):
            self.assertEqual(results[i]["settle"], {"skipped": True})
        for i in (0, 2, 4):
            self.assertEqual(results[i]["settle"], {"timed_out": False})
        self.assertEqual(results[2]["reveal_steps"], 3)
        self.assertEqual(results[2]["path"], "full.png")
        self.assertEqual(results[4]["path"], "card.png")
        filmed.assert_called_once_with(page, context, 1, 16, "/tmp/motion.png")


if __name__ == "__main__":
    unittest.main()
