#!/usr/bin/env python3
"""Real stdin/setup integration plus replacement failure injection (stdlib only)."""
import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
import statusline
import statusline_settings as launch
import pwd
import shlex
import sys
from cache_ping_state import limited


# Fixtures own these inputs; never inherit the resident house's configuration.
for key in ('EMBERVY_HOME', 'EMBERVY_LOOP_SERVICE', 'EMBERVY_SYSTEMD_SCOPE',
            'CLAUDE_CONFIG_DIR', 'EMBERVY_CACHE_PING_STATUS_FILE'):
    os.environ.pop(key, None)


class EnvironmentIsolationTests(unittest.TestCase):
    def test_suite_with_inherited_house_environment(self):
        # Select the functional classes to avoid recursively running this test.
        result = subprocess.run(
            [sys.executable, '-B', '-m', 'unittest',
             'statusline_test.StatuslineTests', 'statusline_test.SetupTests'],
            cwd=SCRIPTS, capture_output=True, timeout=60,
            env={**os.environ, 'EMBERVY_LOOP_SERVICE': 'irgendwas-loop',
                 'EMBERVY_SYSTEMD_SCOPE': 'invalid-house-scope',
                 'EMBERVY_HOME': '/nonexistent/resident-house',
                 'CLAUDE_CONFIG_DIR': '/nonexistent/resident-config',
                 'EMBERVY_CACHE_PING_STATUS_FILE': '/nonexistent/resident-cache',
                 'HOME': '/nonexistent/resident-user'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(b'\nOK\n', result.stderr)


class StatuslineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statusline-house-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.state = self.home / "state"
        self.state.mkdir()
        self.file = self.state / "claude-statusline.json"
        self.env = {**os.environ, "EMBERVY_HOME": str(self.home), "HOME": str(self.home / "user"),
                    "CLAUDE_CONFIG_DIR": str(self.home / "user/.claude"), "EMBERVY_CACHE_PING_STATUS_FILE": ""}

    def payload(self, used=100):
        return {"model": {"id": "claude-example", "display_name": "Example", "secret": "MODEL_PRIVATE"},
                "rate_limits": {"five_hour": {"used_percentage": used, "resets_at": 1900000000},
                                "seven_day": {"used_percentage": 42, "resets_at": 1900000001}},
                "workspace": {"current_dir": "PRIVATE_WORKSPACE"}, "session_id": "PRIVATE_SESSION",
                "cost": {"total_cost_usd": "PRIVATE_COST"}, "extra": "PRIVATE_EXTRA"}

    def run_writer(self, raw, **env):
        result = subprocess.run(["bash", str(SCRIPTS / "statusline.sh")], input=raw, capture_output=True,
                                env={**self.env, **env}, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        return result.stdout.decode()

    def test_allowlist_permissions_and_cache_ping(self):
        for used in (100, 45):
            data = self.payload(used)
            before = time.time()
            line = self.run_writer(json.dumps(data).encode())
            stored = json.loads(self.file.read_text())
            self.assertEqual(set(stored), {"timestamp", "rate_limits", "model"})
            self.assertEqual(stored["rate_limits"], data["rate_limits"])
            self.assertEqual(stored["model"], "claude-example")
            self.assertTrue(before <= stored["timestamp"] <= time.time())
            self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("PRIVATE", self.file.read_text())
            self.assertEqual(limited(self.file), used == 100)
            self.assertEqual(line, f"Example | five_hour {used}% | seven_day 42%\n")

    def test_bad_empty_oversize_and_non_object_do_not_replace(self):
        self.run_writer(json.dumps(self.payload()).encode())
        original = self.file.read_bytes()
        for raw in (b"", b"{", b"[]", b"null", b"NaN", b'{"x":NaN}', b"x" * (statusline.MAX_INPUT + 1),
                    b'{"model":"fallback","rate_limits":[]}', b"[" * 3000):
            with self.subTest(raw=raw[:30]):
                self.run_writer(raw)
                self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(list(self.state.iterdir()), [self.file])

    def test_atomic_replace_keeps_old_inode_and_restricts_new_mode(self):
        self.file.write_text('{"old":true}')
        self.file.chmod(0o644)
        with self.file.open() as old:
            self.run_writer(json.dumps(self.payload()).encode())
            self.assertEqual(old.read(), '{"old":true}')
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.state.iterdir()), [self.file])

    def test_replace_failure_preserves_complete_previous_file_and_cleans_tmp(self):
        self.file.write_text('{"old":true}')
        def fail(source, target):
            staged = Path(source)
            self.assertEqual(staged.parent, self.file.parent)
            self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(staged.read_text()), {"new": True})
            self.assertEqual(self.file.read_text(), '{"old":true}')
            raise OSError("injected rename failure")
        with patch.object(statusline.os, "replace", side_effect=fail):
            with self.assertRaises(OSError):
                statusline.atomic_snapshot(self.file, {"new": True})
        self.assertEqual(list(self.state.iterdir()), [self.file])
        self.assertEqual(self.file.read_text(), '{"old":true}')

    def test_failed_write_outputs_only_safe_model(self):
        self.file.mkdir()
        self.assertEqual(self.run_writer(json.dumps(self.payload()).encode()), "Example\n")
        self.assertTrue(self.file.is_dir())
        self.assertEqual(list(self.state.iterdir()), [self.file])

    def test_absent_limits_clear_previous_observation(self):
        self.run_writer(json.dumps(self.payload()).encode())
        self.assertEqual(self.run_writer(b'{"model":{"id":"only-model"}}'), "only-model\n")
        self.assertIsNone(json.loads(self.file.read_text())["rate_limits"])
        self.assertFalse(limited(self.file))

    def test_controls_are_not_sent_to_terminal_or_model_storage(self):
        self.assertEqual(self.run_writer(b'{"model":"A\\n\\u001bB\\r"}'), "AB\n")
        self.assertEqual(json.loads(self.file.read_text())["model"], "AB")

    def test_env_file_override_matches_cache_ping_precedence(self):
        (self.home / ".env").write_text(f"EMBERVY_CACHE_PING_STATUS_FILE='{self.state}/root.json'\n")
        app = self.home / "Claude/app"
        app.mkdir(parents=True)
        (app / ".env").write_text(f"EMBERVY_CACHE_PING_STATUS_FILE='{self.state}/app.json'\n")
        self.run_writer(json.dumps(self.payload()).encode())
        self.assertFalse(self.file.exists())
        self.assertFalse((self.state / "root.json").exists())
        self.assertTrue(limited(self.state / "app.json"))

    def test_invalid_input_never_creates_a_snapshot(self):
        for raw in (b"", b"not-json", b"x" * (statusline.MAX_INPUT + 1)):
            self.assertEqual(self.run_writer(raw), "\n")
            self.assertFalse(self.file.exists())

    def test_missing_python_is_silent(self):
        # An empty PATH also makes setup helpers unavailable: the outer Bash
        # still guarantees a single empty line and exit 0.
        result = subprocess.run(["/bin/bash", str(SCRIPTS / "statusline.sh")], input=b"{}",
                                env={**self.env, "PATH": "/nonexistent"}, capture_output=True, timeout=5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"\n", b""))
        self.assertFalse(self.file.exists())

    def test_input_deadline_does_not_wait_forever_for_eof(self):
        child = subprocess.Popen(["bash", str(SCRIPTS / "statusline.sh")], env=self.env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write(b'{"model":"unfinished"')
            child.stdin.flush()
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertEqual(child.stdout.read(), b"\n")
            self.assertEqual(child.stderr.read(), b"")
            self.assertFalse(self.file.exists())
        finally:
            child.kill() if child.poll() is None else None
            child.wait()
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()

    def test_outside_state_override_is_not_written(self):
        outside = self.home / "outside.json"
        self.assertEqual(self.run_writer(json.dumps(self.payload()).encode(), EMBERVY_CACHE_PING_STATUS_FILE=str(outside)), "Example\n")
        self.assertFalse(outside.exists())


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statusline setup 'house-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.settings = self.home / "state/claude-settings.json"
        self.settings.parent.mkdir()
        self.settings.write_text('{"permissions":{"allow":["Read"]},"custom":true}\n')
        self.env = {**os.environ, "HOME": str(self.home / "user"), "CLAUDE_CONFIG_DIR": str(self.home / "user/.claude"),
                    "EMBERVY_HOME": str(self.home)}
        scripts = self.home / "Claude/scripts"
        scripts.mkdir(parents=True)
        for name in ("statusline.sh", "statusline.py"):
            (scripts / name).write_bytes((SCRIPTS / name).read_bytes())
        self.loop = scripts / "start-claude-loop.sh"
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude --settings state/claude-settings.json "$@"\n')
        self.unit = self.home / "loop.service"
        self.unit.write_text('[Service]\nExecStart=/bin/bash ' + shlex.quote(str(self.loop)) + '\n')
        fakebin = self.home / "bin"
        fakebin.mkdir()
        systemctl = fakebin / "systemctl"
        systemctl.write_text('#!' + sys.executable + '\nimport os, pathlib, sys, shlex\n'
            'if "show" in sys.argv:\n'
            ' print("LoadState=loaded\\nNeedDaemonReload=no\\nUser=' + pwd.getpwuid(os.geteuid()).pw_name + '")\n'
            'elif "cat" in sys.argv:\n'
            ' print("[Service]")\n'
            ' for key in ("HOME", "CLAUDE_CONFIG_DIR", "EMBERVY_HOME"):\n'
            '  print("Environment=" + shlex.quote(key + "=" + os.environ[key]))\n'
            ' print(pathlib.Path(os.environ["UNIT_FIXTURE"]).read_text())\n'
            'else: sys.exit(1)\n')
        systemctl.chmod(0o700)
        self.env.update(PATH=str(fakebin) + os.pathsep + os.environ['PATH'], UNIT_FIXTURE=str(self.unit))
        shared = self.home / "shared/scripts"
        shared.mkdir(parents=True)
        for name in ("env-file.sh", "legacy-names.sh"):
            (shared / name).write_bytes((SCRIPTS / "../../shared/scripts" / name).read_bytes())

    def setup(self, mode, *args):
        return subprocess.run(["python3", "-B", str(SCRIPTS / "setup-statusline.py"), mode, "--home", str(self.home), *args],
                              env=self.env, capture_output=True, timeout=5)

    def test_service_names_from_cli_environment_and_house_files(self):
        original = self.settings.read_bytes()
        cases = [('custom-loop', 'custom-loop.service'),
                 ('custom-loop.service', 'custom-loop.service'),
                 ('worker@house', 'worker@house.service')]
        cases += [(name, None) for name in (
            'foo.timer', 'foo.socket', 'foo.target', 'foo.mount', 'foo.automount',
            'foo.path', 'foo.device', 'foo.swap', 'foo.slice', 'foo.scope',
            'foo.snapshot', 'foo.busname', '', 'bad name', 'bad/name', 'bad;name')]
        for source in ('cli', 'environment', '.env', 'Claude/app/.env'):
            for name, expected in cases:
                with self.subTest(source=source, name=name):
                    args = []
                    envfile = None
                    if source == 'cli':
                        args = ['--unit', name]
                        self.env['EMBERVY_LOOP_SERVICE'] = 'fallback.service'
                    elif source == 'environment':
                        self.env['EMBERVY_LOOP_SERVICE'] = name
                    else:
                        envfile = self.home / source
                        envfile.parent.mkdir(parents=True, exist_ok=True)
                        envfile.write_text('EMBERVY_LOOP_SERVICE=' + shlex.quote(name) + '\n')
                    try:
                        result = self.setup('--check', *args)
                        self.assertEqual(result.returncode, 1 if expected else 2,
                                         result.stdout + result.stderr)
                        if expected:
                            self.assertIn(('1. Unit: ' + expected + ' (system)').encode(), result.stdout)
                        else:
                            self.assertIn(b'invalid loop service name', result.stderr)
                        self.assertEqual(self.settings.read_bytes(), original)
                        self.assertEqual(len(list(self.settings.parent.iterdir())), 1)
                    finally:
                        self.env.pop('EMBERVY_LOOP_SERVICE', None)
                        if envfile is not None:
                            envfile.unlink()

    def test_check_apply_backup_idempotence_and_installed_command(self):
        original = self.settings.read_bytes()
        self.assertEqual(self.setup("--check").returncode, 1)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertEqual(len(list(self.settings.parent.iterdir())), 1)
        result = self.setup("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.settings.read_bytes()
        data = json.loads(installed)
        self.assertEqual(data["permissions"], {"allow": ["Read"]})
        self.assertTrue(data["custom"])
        backups = list(self.settings.parent.glob("*.statusline-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        inode = self.settings.stat().st_ino
        self.assertEqual(self.setup("--apply").returncode, 0)
        self.assertEqual(self.setup("--check").returncode, 0)
        self.assertEqual(self.settings.read_bytes(), installed)
        self.assertEqual(self.settings.stat().st_ino, inode)
        self.assertEqual(len(list(self.settings.parent.glob("*.statusline-backup-*"))), 1)
        cmd = subprocess.run(["bash", "-c", data["statusLine"]["command"]], env=self.env,
                             input=b'{"model":{"id":"installed"}}', capture_output=True, timeout=5)
        self.assertEqual(cmd.returncode, 0)
        self.assertEqual(cmd.stdout, b"installed\n")
        self.assertTrue((self.home / "state/claude-statusline.json").exists())

    def test_existing_statusline_in_any_source_is_preserved(self):
        paths = [self.settings, self.home / ".claude/settings.json", self.home / ".claude/settings.local.json",
                 self.home / "user/.claude/settings.json"]
        for path in paths:
            for value in ({"type": "command", "command": "house-custom"}, None, ""):
                with self.subTest(path=path, value=value):
                    before = self.settings.read_bytes()
                    path.parent.mkdir(parents=True, exist_ok=True)
                    raw = json.dumps({"statusLine": value}).encode()
                    path.write_bytes(raw)
                    self.assertEqual(self.setup("--check").returncode, 0)
                    self.assertEqual(self.setup("--apply").returncode, 0)
                    self.assertEqual(path.read_bytes(), raw)
                    if path != self.settings:
                        self.assertEqual(self.settings.read_bytes(), before)
                        path.unlink()
                    self.settings.write_bytes(before)
        self.assertEqual(len(list(self.settings.parent.iterdir())), 1)

    def test_invalid_json_is_never_touched(self):
        for raw in (b"{", b"[]", b"null", b'{"x":NaN}', b'{"x":1,"x":2}'):
            self.settings.write_bytes(raw)
            self.assertEqual(self.setup("--apply").returncode, 2)
            self.assertEqual(self.settings.read_bytes(), raw)
            self.assertEqual(len(list(self.settings.parent.iterdir())), 1)

    def test_invalid_other_source_refuses_to_override(self):
        project = self.home / ".claude/settings.local.json"
        project.parent.mkdir()
        project.write_text("{")
        before = self.settings.read_bytes()
        self.assertEqual(self.setup("--apply").returncode, 2)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertEqual(project.read_text(), "{")

    def test_missing_settings_can_be_created(self):
        self.settings.unlink()
        self.assertEqual(self.setup("--apply").returncode, 0)
        self.assertEqual(set(json.loads(self.settings.read_text())), {"statusLine"})
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)

    def test_without_settings_uses_project_and_is_idempotent(self):
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude "$@"\n')
        original = self.settings.read_bytes()
        project = self.home / '.claude/settings.json'
        result = self.setup('--check')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(('without --settings; Claude Code reads ' + str(project)).encode(), result.stdout)
        self.assertFalse(project.exists())
        result = self.setup('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'next start of Claude Code', result.stdout)
        self.assertIn(b'first turn:', result.stdout)
        installed, inode = project.read_bytes(), project.stat().st_ino
        self.assertIn('statusLine', json.loads(installed))
        self.assertEqual(self.setup('--apply').returncode, 0)
        self.assertEqual(project.read_bytes(), installed)
        self.assertEqual(project.stat().st_ino, inode)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertFalse(list(project.parent.glob('*.statusline-backup-*')))

    def test_without_settings_backs_up_existing_project_json(self):
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude "$@"\n')
        project = self.home / '.claude/settings.json'
        project.parent.mkdir()
        original = b'{"permissions":{"allow":["Read"]}}\n'
        project.write_bytes(original)
        result = self.setup('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(project.read_text())['permissions'], {'allow': ['Read']})
        backups = list(project.parent.glob('*.statusline-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertEqual(self.setup('--apply').returncode, 0)
        self.assertEqual(len(list(project.parent.glob('*.statusline-backup-*'))), 1)

    def test_without_settings_preserves_custom_statusline_everywhere(self):
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude "$@"\n')
        self.test_existing_statusline_in_any_source_is_preserved()

    def test_unit_arguments_wrapper_and_product_loop(self):
        self.loop.write_bytes((SCRIPTS / 'start-claude-loop.sh').read_bytes())
        wrapper = self.loop.with_name('loop-wrapper.sh')
        wrapper.write_bytes((SCRIPTS / 'loop-wrapper.sh').read_bytes())
        for args, expected in [('', self.home / '.claude/settings.json'),
                               (' --settings state/claude-settings.json --setting-sources project,local', self.settings)]:
            with self.subTest(args=args):
                self.unit.write_text('[Service]\nExecStart=/bin/bash ' + shlex.quote(str(wrapper)) + args + '\n')
                result = self.setup('--check')
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(('Setup needed: ' + str(expected)).encode(), result.stdout)
                self.assertIn(b'Wrapper:', result.stdout)

    def test_explicit_arbitrary_path_is_the_only_written_settings(self):
        chosen = self.home / 'actual settings.json'
        chosen.write_text('{"custom":42}\n')
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude --settings=' + shlex.quote(str(chosen)) + '\n')
        before = self.settings.read_bytes()
        result = self.setup('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(chosen.read_text())
        self.assertEqual(data['custom'], 42)
        self.assertIn('statusLine', data)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertFalse((self.home / '.claude').exists())
        self.assertEqual(len(list(self.home.glob('actual settings.json.statusline-backup-*'))), 1)

    def test_modified_product_argument_flow_is_not_guessed(self):
        source = (SCRIPTS / 'start-claude-loop.sh').read_text()
        self.loop.write_text(source.replace('PASS_ARGS=()', 'PASS_ARGS=()\nPASS_ARGS+=(--settings unknown.json)'))
        result = self.setup('--apply')
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn(b'unrecognized product loop argument construction', result.stderr)
        self.assertFalse((self.home / 'unknown.json').exists())
        self.assertEqual(len(list(self.settings.parent.iterdir())), 1)

    def test_scalar_array_and_argument_files(self):
        self.home.joinpath('arguments.env').write_text('FLAGS="--settings state/claude-settings.json"\n')
        self.home.joinpath('arguments.txt').write_text('--settings state/claude-settings.json\n')
        forms = [
            'FLAGS=(--settings state/claude-settings.json)\nclaude "${FLAGS[@]}"',
            'SETTINGS="state/claude-settings.json"\nclaude --settings "$SETTINGS"',
            'source "$EMBERVY_HOME/arguments.env"\nclaude $FLAGS',
            'FLAGS=$(cat "$EMBERVY_HOME/arguments.txt")\nclaude $FLAGS',
        ]
        for form in forms:
            with self.subTest(form=form):
                self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\n' + form + '\n')
                result = self.setup('--check')
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(('with --settings ' + str(self.settings)).encode(), result.stdout)

    def test_unit_environment_file_and_dropin(self):
        envfile = self.home / 'unit.env'
        envfile.write_text('FLAGS="--settings state/claude-settings.json"\n')
        self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\nclaude "$@"\n')
        self.unit.write_text('[Service]\nExecStart=/bad/old\n\n# /drop-in.conf\n[Service]\nExecStart=\n'
                             'EnvironmentFile=' + shlex.quote(str(envfile)) + '\nExecStart=/bin/bash ' +
                             shlex.quote(str(self.loop)) + ' $FLAGS\n')
        result = self.setup('--check')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(('with --settings ' + str(self.settings)).encode(), result.stdout)

    def test_unresolved_or_ambiguous_launch_writes_nothing(self):
        forms = ['claude $UNKNOWN', 'claude --settings', 'claude --settings one --settings two',
                 'claude --settings "$(get-settings)"', 'eval "$COMMAND"',
                 'claude --settings \'{"statusLine":null}\'',
                 'if true; then\n FLAGS="--settings alternate"\nfi\nclaude $FLAGS',
                 'claude --setting-sources user', 'claude\nclaude --settings other',
                 'FLAGS=one\nFLAGS=two\nclaude --settings "$FLAGS"',
                 'claude $FLAGS\nFLAGS="--settings wrong"', 'IFS=/\nclaude --settings state/file',
                 'UNUSED=x; set -- --settings wrong\nclaude "$@"', 'claude *',
                 'FLAGS=$LATER\nLATER="--settings wrong"\nclaude $FLAGS']
        before = self.settings.read_bytes()
        for form in forms:
            with self.subTest(form=form):
                self.loop.write_text('#!/bin/bash\ncd "$EMBERVY_HOME"\n' + form + '\n')
                result = self.setup('--apply')
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn(b'Statusline setup refused:', result.stderr)
                self.assertEqual(self.settings.read_bytes(), before)
                self.assertFalse((self.home / '.claude').exists())
                self.assertEqual(len(list(self.settings.parent.iterdir())), 1)

    def test_missing_unit_and_unrecognized_wrapper_refuse(self):
        before = self.settings.read_bytes()
        self.unit.write_text('[Service]\nExecStart=/bin/bash /some/wrapper.sh\n')
        self.assertEqual(self.setup('--apply').returncode, 2)
        self.unit.unlink()
        self.assertEqual(self.setup('--apply').returncode, 2)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertEqual(len(list(self.settings.parent.iterdir())), 1)

    def test_settings_override_cannot_bypass_discovery(self):
        result = subprocess.run(['python3', '-B', str(SCRIPTS / 'setup-statusline.py'), '--apply',
                                 '--home', str(self.home), '--settings', 'unused.json'],
                                env=self.env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.home / 'unused.json').exists())

    def test_parent_symlink_is_refused(self):
        target = self.home / 'elsewhere'
        target.mkdir()
        (self.home / '.claude').symlink_to(target, target_is_directory=True)
        self.assertEqual(self.setup('--apply').returncode, 2)
        self.assertEqual(list(target.iterdir()), [])

    def test_real_proc_argv_agreement_and_conflict_write_nothing(self):
        before = self.settings.read_bytes()
        for cli_args, code in [(['--settings', str(self.settings)], 1), ([], 2),
                               (['--settings', 'other.json'], 2)]:
            with self.subTest(cli_args=cli_args):
                child = subprocess.Popen(['claude', '-c', 'import time; time.sleep(30)', *cli_args],
                                         executable=sys.executable, cwd=self.home, env=self.env,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    result = self.setup('--check' if code == 1 else '--apply')
                    self.assertEqual(result.returncode, code, result.stdout + result.stderr)
                    self.assertIn(('PID ' + str(child.pid)).encode(), result.stdout)
                    self.assertEqual(self.settings.read_bytes(), before)
                    self.assertEqual(len(list(self.settings.parent.iterdir())), 1)
                    self.assertFalse((self.home / '.claude').exists())
                finally:
                    child.terminate()
                    child.wait(timeout=5)

    def test_live_process_comparison(self):
        env = {'HOME': str(self.home / 'user'), 'CLAUDE_CONFIG_DIR': str(self.home / 'user/.claude')}
        argv = [str(self.loop)]
        with redirect_stdout(io.StringIO()), patch.dict(os.environ, self.env), patch.object(launch, 'unit_launch', return_value=argv):
            for live, good in [(['--settings', str(self.settings)], True),
                               (['--settings=state/claude-settings.json'], True),
                               ([], False), (['--settings', 'other.json'], False)]:
                with self.subTest(live=live), patch.object(launch, 'running_claudes', return_value=[('42', live, self.home, env)]):
                    if good:
                        self.assertEqual(launch.discover(self.home)[0], self.settings)
                    else:
                        with self.assertRaisesRegex(ValueError, 'disagree'):
                            launch.discover(self.home)

    def test_symlink_is_not_replaced_or_followed(self):
        other = self.home / "other.json"
        other.write_text("{}")
        self.settings.unlink()
        self.settings.symlink_to(other)
        self.assertEqual(self.setup("--apply").returncode, 2)
        self.assertTrue(self.settings.is_symlink())
        self.assertEqual(other.read_text(), "{}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
