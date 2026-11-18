"""Read-only, deliberately bounded launch inspection. Never source or run house shell code.

Unknown shell/systemd constructs are errors, not evidence for the default settings.
"""
import os
from pathlib import Path
import pwd
import re
import shlex
import subprocess


class Unsafe(ValueError):
    pass


def no_symlinks(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise Unsafe(f"refusing symlink: {part}")
    return path


def text(path):
    path = no_symlinks(path)
    if path.stat().st_size > 1024 * 1024:
        raise Unsafe(f"launch input too large: {path}")
    return path.read_text()


def data_env(path, optional=False):
    if optional and not path.exists():
        no_symlinks(path)
        return {}
    result = {}
    for line in text(path).splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$', line)
        if match:
            value = shlex.split(match[2], comments=True)
            result[match[1]] = " ".join(value)
    return result


def words(value):
    # Retain quotes: an unquoted scalar splits, a quoted settings path does not.
    tokens = re.findall(r'''(?:[^\s'"]+|'[^']*'|"[^"]*")+''', value)
    if " ".join(tokens).replace(" ", "") != value.replace(" ", "").replace("\t", ""):
        raise Unsafe("unsupported shell quoting")
    for token in tokens:
        shlex.split(token)  # also rejects unbalanced quotes
    return tokens


class Shell:
    def __init__(self, source, env, args, home):
        self.source = source.replace("\\\n", " ")
        self.env = dict(env)
        self.args = list(args)
        self.home = home
        self.resolving = set()
        self.defs = {}
        self.locations = {}
        self.available_at = (float('inf'), 0)
        self.exported = set(re.findall(r'^\s*export\s+([A-Za-z_]\w*)=', self.source, re.M))
        for index, line in enumerate(self.source.splitlines()):
            m = re.match(r'^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*?)(?:;\s*export\s+\1)?\s*$', line)
            if m:
                self.defs.setdefault(m[1], []).append(m[2])
                self.locations[m[1]] = (index, 0)

    def scalar(self, value):
        if any(c in value for c in ('`', '\n')) or '$(' in value:
            raise Unsafe(f"unsupported dynamic shell value: {value}")
        def sub(m):
            name = m[1] or m[3]
            fallback = m[2]
            if name in self.defs:
                values = self.variable(name)
                if len(values) != 1:
                    raise Unsafe(f"scalar used as array: {name}")
                found = values[0]
            else:
                found = self.env.get(name)
            if not found and fallback is not None:
                return fallback
            if found is None:
                raise Unsafe(f"unresolved launch variable: {name}")
            return found
        result = re.sub(r'\$\{([A-Za-z_]\w*)(?::-([^{}]*))?\}|\$([A-Za-z_]\w*)', sub, value)
        if '$' in result:
            raise Unsafe(f"unresolved shell expansion: {value}")
        return result

    def expand(self, value):
        result = []
        for token in words(value):
            if token in ('"$@"', '${PASS_ARGS[@]+"${PASS_ARGS[@]}"}', '"${PASS_ARGS[@]}"'):
                result.extend(self.args)
                continue
            array = re.fullmatch(r'"?\$\{(\w+)\[@\]\}"?', token)
            if array:
                result.extend(self.variable(array[1]))
                continue
            parts = re.findall(r'''[^'"\s]+|'[^']*'|"[^"]*"''', token)
            if any(not part.startswith(('"', "'")) and any(c in part for c in '*?[') for part in parts):
                raise Unsafe("unquoted glob in launch input")
            expanded = ''
            for part in parts:
                expanded += part[1:-1] if part.startswith("'") else self.scalar(part[1:-1] if part.startswith('"') else part)
            if any(c in expanded for c in (';', '|', '&', '<', '>', '`', '\n')):
                raise Unsafe("unsupported shell operator in launch arguments")
            if not token.startswith(('"', "'")) and '$' in token:
                if any(c in expanded for c in '*?['):
                    raise Unsafe("glob in launch variable")
                result.extend(expanded.split())
            else:
                result.append(expanded)
        return result

    def variable(self, name):
        if name in self.resolving:
            raise Unsafe(f"recursive launch variable: {name}")
        if name in self.locations and (self.locations[name] >= self.available_at or
                any(self.locations[name] >= self.locations[parent] for parent in self.resolving)):
            raise Unsafe(f"launch variable referenced before its definition: {name}")
        self.resolving.add(name)
        try:
            definitions = self.defs.get(name, [])
            # Relevant shell state must have a single, unconditional definition.
            if len(definitions) > 1 or re.search(rf'\b{re.escape(name)}\s*\+=|\bread\b[^\n]*\b{re.escape(name)}\b', self.source):
                raise Unsafe(f"ambiguous/mutated launch variable: {name}")
            if not definitions:
                if name not in self.env:
                    raise Unsafe(f"unresolved launch variable: {name}")
                return [self.env[name]]
            value = definitions[0]
            if value.startswith('(') and value.endswith(')'):
                return self.expand(value[1:-1])
            cat = re.fullmatch(r'\$\(cat\s+(.+)\)', value)
            if cat:
                paths = self.expand(cat[1])
                if len(paths) != 1:
                    raise Unsafe("ambiguous argument file")
                path = absolute(paths[0], self.home)
                print(f"Argument file: {path}")
                return [text(path).strip()]
            return self.expand(value)
        finally:
            self.resolving.remove(name)


def absolute(value, cwd):
    if not value or value.startswith(('~', '{')):
        raise Unsafe("settings must be a file path, not inline JSON or a shell expression")
    return no_symlinks(Path(value) if Path(value).is_absolute() else cwd / value)


def settings_arg(argv, cwd, home):
    found = []
    sources = None
    for i, arg in enumerate(argv):
        if arg == '--':
            break
        if arg in ('--settings', '--setting-sources'):
            if i + 1 == len(argv) or argv[i + 1].startswith('--'):
                raise Unsafe(f"missing value for {arg}")
            value = argv[i + 1]
        elif arg.startswith(('--settings=', '--setting-sources=')):
            arg, value = arg.split('=', 1)
        else:
            continue
        if arg == '--settings':
            found.append(absolute(value, cwd))
        else:
            sources = value.split(',')
    if len(found) > 1:
        raise Unsafe("multiple --settings arguments")
    if not found and sources is not None and 'project' not in sources:
        raise Unsafe("without --settings but project settings are disabled by --setting-sources")
    return found[0] if found else home / '.claude/settings.json', bool(found)


def run_systemctl(scope, *args):
    command = ['systemctl', *(['--user'] if scope == 'user' else []), *args]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Unsafe(f"cannot inspect loop unit: {error}") from error
    if result.returncode:
        raise Unsafe("cannot inspect loop unit with systemctl; check service name/scope and runtime user")
    return result.stdout


def service_name(unit):
    """Accept systemd's implicit service suffix, but never another unit type."""
    if not re.fullmatch(r'[\w@.:-]+', unit):
        raise Unsafe("invalid loop service name")
    if not unit.endswith('.service'):
        if unit.rsplit('.', 1)[-1] in {
            'automount', 'busname', 'device', 'mount', 'path', 'scope',
            'slice', 'snapshot', 'socket', 'swap', 'target', 'timer',
        } and '.' in unit:
            raise Unsafe("invalid loop service name")
        unit += '.service'
    if not re.fullmatch(r'[\w@.:-]+\.service', unit):
        raise Unsafe("invalid loop service name")
    return unit


def unit_launch(home, env, unit, scope):
    if not re.fullmatch(r'[\w@.:-]+\.service', unit):
        raise Unsafe("invalid loop service name")
    print(f"1. Unit: {unit} ({scope}); effective fragment and drop-ins via systemctl cat")
    status = dict(line.split('=', 1) for line in run_systemctl(scope, 'show', '--no-pager',
                  '-p', 'LoadState', '-p', 'NeedDaemonReload', '-p', 'User', '--', unit).splitlines() if '=' in line)
    if status.get('LoadState') != 'loaded' or status.get('NeedDaemonReload') != 'no':
        raise Unsafe("unit is not loaded or needs daemon-reload; loaded and on-disk launch may differ")
    user = status.get('User') or ('root' if scope == 'system' else pwd.getpwuid(os.geteuid()).pw_name)
    if user not in (str(os.geteuid()), pwd.getpwuid(os.geteuid()).pw_name):
        raise Unsafe(f"run setup as unit runtime user {user}")
    # The setup caller's environment is NOT the service environment.
    env.clear()
    env['HOME'] = pwd.getpwuid(os.geteuid()).pw_dir
    if scope == 'user':
        for line in run_systemctl(scope, 'show-environment').splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                env[key] = ' '.join(shlex.split(value))
    source = run_systemctl(scope, 'cat', '--no-pager', '--', unit).replace('\\\n', ' ')
    directives = {}
    section = None
    for line in source.splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('['):
            section = line
        elif section == '[Service]' and '=' in line:
            key, value = line.split('=', 1)
            if value == '':
                directives[key] = []
            else:
                directives.setdefault(key, []).append(value)
    for key in ('RootDirectory', 'RootImage', 'ExecStartPre', 'ExecCondition', 'PassEnvironment', 'UnsetEnvironment', 'BindPaths', 'BindReadOnlyPaths'):
        if directives.get(key):
            raise Unsafe(f"unsupported launch-affecting unit directive: {key}")
    for assignment in directives.get('Environment', []):
        for item in shlex.split(assignment):
            key, value = item.split('=', 1)
            env[key] = value
    for entry in directives.get('EnvironmentFile', []):
        for item in shlex.split(entry):
            optional = item.startswith('-')
            path = Path(item.lstrip('-'))
            if not path.is_absolute() or '%' in item or any(c in item for c in '*?['):
                raise Unsafe("unsupported systemd EnvironmentFile path")
            print(f"Unit environment file: {path}")
            env.update(data_env(path, optional))
    if any(env.get(key) for key in ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS')):
        raise Unsafe("unit environment changes shell startup/evaluation")
    starts = directives.get('ExecStart', [])
    if len(starts) != 1:
        raise Unsafe("expected exactly one effective ExecStart")
    if '%' in starts[0] or '\\' in starts[0]:
        raise Unsafe("unsupported systemd specifier/escape in ExecStart")
    # systemd expands ${VAR} as one argument, $VAR as several, without running a shell.
    argv = Shell('', env, [], home).expand(starts[0])
    cwd = directives.get('WorkingDirectory', [str(home)])[-1]
    if cwd != str(home) and cwd != '~':
        raise Unsafe(f"unit WorkingDirectory differs from house: {cwd}")
    return argv


def loop_launch(home, env, argv):
    loop = home / 'Claude/scripts/start-claude-loop.sh'
    wrapper = home / 'Claude/scripts/loop-wrapper.sh'
    if argv and Path(argv[0]).name in ('bash', 'sh'):
        argv = argv[1:]
    if not argv:
        raise Unsafe("empty loop command")
    if Path(argv[0]) == wrapper:
        source = text(wrapper)
        # Only the shipped, argument-preserving wrapper shape is supported.
        required = ['LOOP_SCRIPT="$EMBERVY_HOME/Claude/scripts/start-claude-loop.sh"',
                    "printf -v LOOP_COMMAND '%q ' bash \"$LOOP_SCRIPT\" \"$@\"",
                    '"$LOOP_COMMAND"']
        if not all(s in source for s in required) or len(re.findall(r'^\s*LOOP_SCRIPT=', source, re.M)) != 1:
            raise Unsafe(f"unrecognized wrapper forwarding: {wrapper}")
        if re.search(r'^\s*(?:set --|shift\b|(?:exec )?claude\b|LOOP_COMMAND=)', source, re.M):
            raise Unsafe("wrapper mutates launch arguments")
        if env.get('EMBERVY_HOME', '/opt/embervy') != str(home):
            raise Unsafe("wrapper environment does not select this house")
        env.setdefault('EMBERVY_HOME', '/opt/embervy')
        env.update(data_env(home / '.env', optional=True))
        env.update(data_env(home / 'Claude/app/.env', optional=True))
        print(f"Wrapper: {wrapper} forwards its arguments to {loop}")
        argv = [str(loop), *argv[1:]]
    if Path(argv[0]) != loop:
        raise Unsafe(f"unit does not directly start the house loop or its supported wrapper: {argv[0]}")
    print(f"2. Loop: {loop}; resolve Claude arguments (never execute shell code)")
    source = text(loop)
    product = 'os.execvpe("claude", ["claude"] + sys.argv[2:]' in source
    if product:
        if env.get('EMBERVY_HOME', '/opt/embervy') != str(home):
            raise Unsafe("loop environment does not select this house")
        env.setdefault('EMBERVY_HOME', '/opt/embervy')
        env.update(data_env(home / 'Claude/app/.env', optional=True))
    if env.get('EMBERVY_HOME', str(home)) != str(home):
        raise Unsafe("launch environment points to another EMBERVY_HOME")
    shell = Shell(source, env, argv[1:], home)
    # Product loop uses a Python exec shim, keeping the CLI's PID and terminal.
    if product:
        # Its known root initializer was checked against the unit above.
        shell.defs.pop('EMBERVY_HOME', None)
        expected = {
            'CLAUDE_ARGS=(--dangerously-load-development-channels "${CHANNEL_ARGS[@]}" ${BACKEND_MODEL_ARGS[@]+"${BACKEND_MODEL_ARGS[@]}"})',
            'CLAUDE_ARGS+=(--continue)',
            'CLAUDE_ARGS+=(--append-system-prompt-file "$BRIDGE")',
        }
        mutations = {line.strip() for line in source.splitlines() if re.match(r'\s*CLAUDE_ARGS\+?=', line)}
        pass_filter = 'for arg in "$@"; do\n  case "$arg" in\n    --continue|-c) INITIAL_MODE="continue" ;;\n    *) PASS_ARGS+=("$arg") ;;\n  esac\ndone'
        pass_mutations = {line.strip() for line in source.splitlines() if re.search(r'\bPASS_ARGS\+?=', line)}
        channel_mutations = {line.strip() for line in source.splitlines() if re.search(r'\bCHANNEL_ARGS\+?=', line)}
        if (mutations != expected or pass_filter not in source or
                pass_mutations != {'PASS_ARGS=()', '*) PASS_ARGS+=("$arg") ;;'} or
                channel_mutations != {'CHANNEL_ARGS=()', 'CHANNEL_ARGS+=("server:$c")'}):
            raise Unsafe("unrecognized product loop argument construction")
        if '\' "$MAIN_BRIDGE_TOKEN_FILE" "${CLAUDE_ARGS[@]}" "${PASS_ARGS[@]}" <&0 &' not in source:
            raise Unsafe("unrecognized Claude exec shim arguments")
        # Only model/channel/bridge flags may be generated inside this loop.
        for line in source.splitlines():
            if re.match(r'\s*BACKEND_MODEL_ARGS\+?=', line) and not re.match(r'\s*BACKEND_MODEL_ARGS=\((?:--model .*|)\)$', line):
                raise Unsafe("unrecognized backend arguments")
        args = [arg for arg in argv[1:] if arg not in ('--continue', '-c')]
    else:
        # Small legacy loops: literals, scalar/array variables, source files and cat
        # argument files. Do not silently ignore an unrecognized shell statement.
        for line in source.splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            allowed = (re.match(r'^(?:export\s+)?[A-Za-z_]\w*=', line) or
                       re.match(r'^(?:cd|source|\.)\s+', line) or
                       re.match(r'^(?:(?:exec|command)\s+)?(?:[^\s]*/)?claude(?:\s|$)', line) or
                       re.fullmatch(r'(?:while (?:true|:); do|do|done|sleep [0-9]+|set -[eu]+)', line))
            if not allowed:
                raise Unsafe(f"unsupported legacy loop statement: {line.split()[0]}")
        for index, line in enumerate(source.splitlines()):
            match = re.match(r'^\s*(?:source|\.)\s+(.+?)\s*$', line)
            if match:
                shell.available_at = (index, 0)
                paths = shell.expand(match[1])
                shell.available_at = (float('inf'), 0)
                if len(paths) != 1:
                    raise Unsafe("unresolved shell source file")
                path = absolute(paths[0], home)
                print(f"Loop argument source: {path}")
                # Source only literal assignments as DATA, never execute it.
                content = text(path)
                if any(line.strip() and not line.lstrip().startswith('#') and not re.match(r'^\s*(?:export\s+)?\w+=', line) for line in content.splitlines()):
                    raise Unsafe(f"non-data shell source: {path}")
                extra = Shell(content, env, [], home)
                shell.exported.update(extra.exported)
                for key, values in extra.defs.items():
                    shell.defs.setdefault(key, []).extend(values)
                    shell.locations[key] = (index, extra.locations[key][0] + 1)
        launches = re.findall(r'^[ \t]*(?:(?:exec|command)[ \t]+)?(?:[^\s]*/)?claude(?:[ \t]+(.*))?$', source, re.M)
        if len(launches) != 1:
            raise Unsafe("expected one statically recognizable Claude launch in loop")
        launch_line = next(i for i, line in enumerate(source.splitlines())
                           if re.match(r'^[ \t]*(?:(?:exec|command)[ \t]+)?(?:[^\s]*/)?claude(?:[ \t]|$)', line))
        if any(re.match(r'^\s*(?:(?:export\s+)?\w+=|cd\s|source\s|\.\s)', line)
               for line in source.splitlines()[launch_line + 1:]):
            raise Unsafe("launch inputs are changed after Claude starts")
        if any(key in shell.defs for key in ('IFS', 'GLOBIGNORE', 'BASH_ENV', 'ENV', 'SHELLOPTS')):
            raise Unsafe("loop changes shell expansion/startup rules")
        # Even unused assignments may contain commands that change the launch.
        for key in shell.defs:
            shell.variable(key)
        args = shell.expand(launches[0])
        if '--version' in args or '--help' in args:
            raise Unsafe("found only a Claude informational command, not an interactive launch")
        for key in ('HOME', 'CLAUDE_CONFIG_DIR'):
            if key in shell.defs and (key in env or key in shell.exported):
                values = shell.variable(key)
                if len(values) != 1:
                    raise Unsafe(f"ambiguous exported config variable: {key}")
                env[key] = values[0]
    cds = re.findall(r'^\s*cd\s+(.+?)\s*$', source, re.M)
    if len(cds) != 1 or shell.expand(cds[0]) != [str(home)]:
        raise Unsafe("cannot establish Claude working directory as the house")
    return args, env


def running_claudes(home, unit):
    """Read argv as NUL-separated data. Ignore other houses, never print prompts/env."""
    result = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.geteuid():
                continue
            argv = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
            is_claude = bool(argv) and (Path(argv[0]).name == 'claude' or
                (Path(argv[0]).name == 'node' and len(argv) > 1 and '@anthropic-ai/claude-code/' in argv[1]))
            if not is_claude:
                continue
            cwd = (proc / 'cwd').resolve(strict=True)
            group = (proc / 'cgroup').read_text()
            if cwd != home and home not in cwd.parents and not re.search(r'/' + re.escape(unit) + r'(?:/|$)', group, re.M):
                continue
            env = dict(item.split('=', 1) for item in (proc / 'environ').read_bytes().decode().split('\0') if '=' in item)
            result.append((proc.name, argv[1:], cwd, env))
        except (FileNotFoundError, ProcessLookupError):
            continue  # exited during observation
        except PermissionError as error:
            raise Unsafe(f"cannot inspect process {proc.name}; run as runtime user") from error
    return result


def discover(home, requested=None, unit=None, scope=None):
    env = {'HOME': str(Path.home()), 'EMBERVY_HOME': str(home)}
    if os.environ.get('CLAUDE_CONFIG_DIR'):
        env['CLAUDE_CONFIG_DIR'] = os.environ['CLAUDE_CONFIG_DIR']
    for path in (home / '.env', home / 'Claude/app/.env'):
        env.update(data_env(path, optional=True))
    if unit is None:
        unit = env.get('EMBERVY_LOOP_SERVICE', os.environ.get('EMBERVY_LOOP_SERVICE', 'embervy-loop.service'))
    unit = service_name(unit)
    scope = scope or env.get('EMBERVY_SYSTEMD_SCOPE') or os.environ.get('EMBERVY_SYSTEMD_SCOPE', 'system')
    if scope not in ('system', 'user'):
        raise Unsafe("unknown systemd scope")
    argv = unit_launch(home, env, unit, scope)
    args, env = loop_launch(home, env, argv)
    target, explicit = settings_arg(args, home, home)
    config = absolute(env.get('CLAUDE_CONFIG_DIR') or str(Path(env['HOME']) / '.claude'), home)
    print("3. Running Claude Code: compare /proc argv, cwd and config directory")
    processes = running_claudes(home, unit)
    for pid, live_args, cwd, live_env in processes:
        live_target, live_explicit = settings_arg(live_args, cwd, home)
        print(f"PID {pid}: {'with --settings ' if live_explicit else 'without --settings; project file '}{live_target}")
        live_config = absolute(live_env.get('CLAUDE_CONFIG_DIR') or str(Path(live_env.get('HOME', '/')) / '.claude'), cwd)
        if (live_target, live_explicit, live_config, cwd) != (target, explicit, config, home):
            raise Unsafe("running Claude and loop disagree on settings/config/cwd; no file selected")
    if not processes:
        print("No running Claude Code in this house; checked the next loop start.")
    if requested and absolute(requested, home) != target:
        raise Unsafe(f"--settings assertion differs from discovered target: {target}")
    if explicit:
        print(f"this house starts Claude Code with --settings {target}")
    else:
        print(f"without --settings; Claude Code reads {target}")
    return target, config
