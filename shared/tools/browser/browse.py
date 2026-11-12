#!/usr/bin/env python3
# Runs a persistent browser behind an authenticated local command server.
"""browse — the agent's browser: one persistent headless Chromium (Playwright).

A daemon holds the browser with its own profile (logins survive restarts)
and listens on 127.0.0.1 only. The CLI sends one command per call; the
first command starts the daemon by itself — never start it by hand.

Daemon:   browse.py daemon
Commands:
  goto <url>              open a page (waits for the DOM + 800 ms)
  read [selector]         page text (or one element's), clipped to 12k chars
  links                   up to 200 links as JSON {t: text, h: href}
  click <sel>             click (CSS selector, text=<substring>, or a ref e12)
  fill <sel> <text>       fill a field
  press <key>             key press (Enter, Tab, Escape, ...)
  shot [path] [--now]     viewport screenshot (settles unless --now)
  film [s] [n] [path]     motion filmstrip (defaults: 4 seconds, 8 frames)
  url                     current URL + title
  back                    go back
  stop                    stop the daemon (frees its RAM; the profile stays)
Structure tools:
  snap [selector]         ARIA snapshot (roles + names as YAML); every element
                          carries a ref [ref=e12] that works as a selector in
                          every command (click e12, fill e12 ..., read e12,
                          shotel e12). Refs hold until the next navigation.
  shotfull [path] [--now] full-page screenshot (scrolls through, then settles)
  shotel <sel> [path] [--now] screenshot of one element (settles unless --now)
  pdf [path]              the page as an A4 PDF
  net [n] [filter]        last n network responses (status, method, URL, type)
  trace start|stop [path] evidence archive (screens + DOM + network) as trace.zip
  state [path]            export the login session as storage_state.json
  role <role> <name>      click by accessibility role (get_by_role)
  eval <js>               evaluate JavaScript in the page

Paths and port (environment, all optional):
  EMBERVY_HOME               the agent's home (default: three folders above this file)
  EMBERVY_BROWSER_HOME       browser state (default $EMBERVY_HOME/state/browser):
                            profile/, venv/, ms-playwright/, default shot/pdf/trace
  EMBERVY_BROWSER_PROFILE    persistent profile (default $EMBERVY_BROWSER_HOME/profile)
  EMBERVY_BROWSER_PORT       daemon port on 127.0.0.1 (default 3055)
  EMBERVY_BROWSER_PYTHON     Python with Playwright for the daemon
                            (default $EMBERVY_BROWSER_HOME/venv/bin/python)
  EMBERVY_BROWSER_LOG        daemon log (default $EMBERVY_HOME/logs/browser.log)
  EMBERVY_BROWSER_UA         user agent override
  PLAYWRIGHT_BROWSERS_PATH  where Chromium lives (default $EMBERVY_BROWSER_HOME/ms-playwright
                            when that folder exists, else Playwright's own default)

Install or update Playwright + Chromium: bash install.sh (next to this file).
"""
import asyncio
import base64
import html
import math
import time
import hmac
import ipaddress
import socket
import threading
from urllib.parse import quote, unquote, urlsplit
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = 3055
MAX_TEXT = 12000
CLIENT_TIMEOUT = 60
TOKEN_HEADER = "X-Browser-Token"
DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
HERE = os.path.dirname(os.path.abspath(__file__))


def setting(env, name: str):
    """Read exact keys so browser settings cannot come from another namespace."""
    return env.get(name)


def limit_setting(env, name: str, default: float) -> float:
    try:
        value = float(setting(env, name) or default)
        if value < 0 or not math.isfinite(value):
            raise ValueError
        return value
    except (TypeError, ValueError):
        return default


def paths(env=None, here: str = HERE) -> dict:
    """Every path and the port, from the environment with defaults under the
    agent's home. Empty values count as unset; a bad port falls back."""
    env = os.environ if env is None else env
    home = setting(env, "EMBERVY_HOME") or os.path.abspath(os.path.join(here, "..", "..", ".."))
    bhome = setting(env, "EMBERVY_BROWSER_HOME") or os.path.join(home, "state", "browser")
    try:
        port = int(setting(env, "EMBERVY_BROWSER_PORT") or DEFAULT_PORT)
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        port = DEFAULT_PORT
    return {
        "home": home,
        "browser_home": bhome,
        "profile": setting(env, "EMBERVY_BROWSER_PROFILE") or os.path.join(bhome, "profile"),
        "browsers": env.get("PLAYWRIGHT_BROWSERS_PATH") or os.path.join(bhome, "ms-playwright"),
        "python": setting(env, "EMBERVY_BROWSER_PYTHON") or os.path.join(bhome, "venv", "bin", "python"),
        "log": setting(env, "EMBERVY_BROWSER_LOG") or os.path.join(home, "logs", "browser.log"),
        "token": os.path.join(bhome, "daemon.token"),
        "shot": os.path.join(bhome, "shot.png"),
        "film": os.path.join(bhome, "film.png"),
        "pdf": os.path.join(bhome, "page.pdf"),
        "trace": os.path.join(bhome, "trace.zip"),
        "storage": os.path.join(bhome, "storage-state.json"),
        "user_agent": setting(env, "EMBERVY_BROWSER_UA") or DEFAULT_UA,
        "port": port,
        "idle_minutes": limit_setting(env, "BROWSE_IDLE_MINUTES", 30),
        "max_mb": limit_setting(env, "BROWSE_MAX_MB", 1024),
    }


def build_cmd(argv: list) -> dict:
    """CLI words -> command: op, first argument, the rest joined as arg2."""
    cmd = {"op": argv[0]}
    if argv[0] in ("shot", "shotfull", "shotel") and argv[-1] == "--now":
        cmd["now"] = True
        argv = argv[:-1]
    if len(argv) > 1:
        cmd["arg"] = argv[1]
    if len(argv) > 2:
        cmd["arg2"] = " ".join(argv[2:])
    return cmd


def settle(page, timeout_ms=4000) -> dict:
    """Share one deadline between fonts, finite animations and two paint frames."""
    started = time.monotonic()
    deadline = started + max(0, timeout_ms) / 1000
    pending = 0
    timed_out = False

    def remaining():
        return max(0, (deadline - time.monotonic()) * 1000)

    fonts_ready = page.evaluate("""async budget => {
        let timer;
        try {
            return await Promise.race([
                document.fonts.ready.then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), budget); })
            ]);
        } finally { clearTimeout(timer); }
    }""", remaining())
    if not fonts_ready:
        timed_out = True
    else:
        while True:
            animations = page.evaluate("""() => document.getAnimations().map(a => ({
                running: a.playState === 'running' || a.pending,
                iterations: Number.isFinite(a.effect.getTiming().iterations)
                    ? a.effect.getTiming().iterations : null
            }))""")
            count = sum(1 for a in animations if a["running"] and a["iterations"] is not None)
            pending = max(pending, count)
            if not count:
                break
            if remaining() <= 0:
                timed_out = True
                break
            page.wait_for_timeout(min(50, remaining()))

    # Hidden pages may never deliver requestAnimationFrame, so paints share the deadline too.
    if not timed_out and remaining() > 0:
        painted = page.evaluate("""async budget => {
            let timer, first, second;
            try {
                return await Promise.race([
                    new Promise(resolve => {
                        first = requestAnimationFrame(() => {
                            second = requestAnimationFrame(() => resolve(true));
                        });
                    }),
                    new Promise(resolve => { timer = setTimeout(() => resolve(false), budget); })
                ]);
            } finally {
                clearTimeout(timer);
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
            }
        }""", remaining())
        timed_out = not painted
    else:
        timed_out = True
    return {"waited_ms": round((time.monotonic() - started) * 1000),
            "pending_animations": pending, "timed_out": timed_out}


def reveal(page, pause_ms=250, max_steps=60) -> int:
    """Visit each viewport from the top, including lazy-loaded height changes."""
    metrics = """() => ({x: window.scrollX, y: window.scrollY,
        viewport: window.innerHeight,
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)})"""
    scroll = "pos => window.scrollTo({left: pos.x, top: pos.y, behavior: 'instant'})"
    original = page.evaluate(metrics)
    steps = 0
    try:
        if max_steps <= 0:
            return steps
        page.evaluate(scroll, {"x": original["x"], "y": 0})
        page.wait_for_timeout(pause_ms)
        current = page.evaluate(metrics)
        while steps < max_steps:
            bottom = max(0, current["height"] - current["viewport"])
            if current["y"] >= bottom or current["viewport"] <= 0:
                break
            y = min(current["y"] + current["viewport"], bottom)
            page.evaluate(scroll, {"x": original["x"], "y": y})
            steps += 1
            page.wait_for_timeout(pause_ms)
            following = page.evaluate(metrics)
            if following["y"] <= current["y"]:
                break
            current = following
        return steps
    finally:
        page.evaluate(scroll, {"x": original["x"], "y": original["y"]})


def film_args(arg="", arg2="", default_path="state/browser/film.png") -> tuple:
    """Keep the CLI's existing first-argument/rest convention, including path spaces."""
    rest = arg2.split(maxsplit=1)
    seconds = float(arg) if arg else 4.0
    frames = int(rest[0]) if rest else 8
    if not math.isfinite(seconds):
        raise ValueError("film seconds must be a finite number")
    return max(1.0, min(20.0, seconds)), max(2, min(16, frames)), rest[1] if len(rest) > 1 else default_path


def film_times(seconds, frames) -> list:
    return [i * seconds / (frames - 1) for i in range(frames)]


def film_html(images, times) -> str:
    cells = "".join(
        f'<figure><figcaption>{stamp:.1f} s</figcaption>'
        f'<img alt="Frame {i + 1}" src="data:image/png;base64,{html.escape(image, quote=True)}"></figure>'
        for i, (image, stamp) in enumerate(zip(images, times))
    )
    return """<!doctype html><html><head><meta charset="utf-8">
        <style>html,body{margin:0;background:#202124;color:#fff;font:24px sans-serif}
        main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:12px}
        figure{margin:0;min-width:0}figcaption{padding:8px}img{display:block;width:100%;height:auto}
        </style></head><body><main>""" + cells + "</main></body></html>"


def film(page, context, seconds, frames, path) -> dict:
    targets = film_times(seconds, frames)
    images, times = [], []
    started = time.monotonic()
    for target in targets:
        delay = target - (time.monotonic() - started)
        if delay > 0:
            page.wait_for_timeout(delay * 1000)
        times.append(round(time.monotonic() - started, 3))
        images.append(base64.b64encode(page.screenshot(type="png", full_page=False)).decode("ascii"))
    grid = context.new_page()
    try:
        grid.set_viewport_size({"width": 2560, "height": 900})
        grid.set_content(film_html(images, times))
        grid.evaluate("() => Promise.all(Array.from(document.images, image => image.decode()))")
        grid.screenshot(path=path, type="png", full_page=True)
    finally:
        grid.close()
    return {"ok": True, "path": path, "frame_times": times}


def write_private(path: str, text: str) -> None:
    """Write a file only its owner can read (the daemon token)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path, 0o600)


def make_server(port: int, token: str, handle):
    """HTTP front of the daemon: 127.0.0.1 only, and every request must carry
    this daemon's token. The token keeps other local installs (a second agent
    on the same server hitting the same port) and web pages open in the
    browser itself (a page can POST to 127.0.0.1) from driving it."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _answer(self, code: int, result: dict) -> None:
            body = json.dumps(result, ensure_ascii=False, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            given = self.headers.get(TOKEN_HEADER, "")
            if not hmac.compare_digest(given.encode(), token.encode()):
                self._answer(403, {"ok": False, "error": "forbidden"})
                return
            length = int(self.headers.get("Content-Length", 0))
            try:
                cmd = json.loads(self.rfile.read(length) or b"{}")
                result = handle(cmd)
            except Exception as exc:
                result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            self._answer(200, result)
            if result.get("stopping"):
                raise KeyboardInterrupt

    return HTTPServer(("127.0.0.1", port), Handler)


def public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id or address.sixtofour or address.teredo:
            return False
        if address.ipv4_mapped:
            return public_address(str(address.ipv4_mapped))
    return (address.is_global and not address.is_private and not address.is_loopback
            and not address.is_link_local and not address.is_multicast
            and not address.is_reserved and not address.is_unspecified)


def chromium_args(port: int) -> list:
    return [
        f"--proxy-server=http://127.0.0.1:{port}",
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--disable-features=DnsOverHttps,UseDnsHttpsSvcbAlpn",
        "--dns-over-https-mode=off",
        "--disable-background-networking",
    ]


def browser_allow(home, env=None):
    env = os.environ if env is None else env
    key = "EMBERVY_BROWSER_ALLOW"
    if key in env:
        return env[key]
    try:
        with open(os.path.join(home, ".env"), "rb") as source:
            remaining = 65536
            while remaining:
                line = source.readline(remaining + 1)
                if not line:
                    break
                if len(line) > remaining:
                    break
                remaining -= len(line)
                text = line.decode("utf-8", errors="replace").strip()
                if text.startswith(key + "="):
                    value = text[len(key) + 1:].strip()
                    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                        value = value[1:-1]
                    return value
    except OSError:
        pass
    return ""


def parse_allow(value, logger):
    entries = []
    for raw in value.split(","):
        entry = raw.strip()
        if not entry:
            continue
        try:
            host, ports = entry, (80, 443)
            if entry.startswith("["):
                host, suffix = entry[1:].split("]", 1)
                if suffix and not suffix.startswith(":"):
                    raise ValueError("invalid port")
                port_text = suffix[1:] if suffix else None
            elif entry.count(":") == 1:
                host, port_text = entry.rsplit(":", 1)
            else:
                port_text = None
            if port_text is not None:
                if not port_text.isascii() or not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
                    raise ValueError("invalid port")
                ports = (int(port_text),)
            if "%" in host:
                raise ValueError("scoped address")
            network = ipaddress.ip_network(host, strict=False)
            if network.prefixlen < (8 if network.version == 4 else 32):
                raise ValueError("network is too broad")
            entries.append((network, ports))
        except ValueError as exc:
            logger(f"ignored EMBERVY_BROWSER_ALLOW entry {entry!r}: {exc}")
    return entries


def metadata_address(address):
    if address.version == 6:
        if address.ipv4_mapped:
            return metadata_address(address.ipv4_mapped)
        if address.sixtofour:
            return metadata_address(address.sixtofour)
        if address.teredo:
            return any(metadata_address(part) for part in address.teredo)
        if address in ipaddress.ip_network("64:ff9b::/96"):
            return metadata_address(ipaddress.IPv4Address(int(address) & 0xffffffff))
    return address in (ipaddress.ip_address("169.254.169.254"),
                       ipaddress.ip_address("fd00:ec2::254"))


class GuardProxy:
    CONNECT_TIMEOUT = 10
    ATTEMPT_TIMEOUT = 3
    IDLE_TIMEOUT = 30
    MAX_CONNECTIONS = 32

    def __init__(self, resolver=None, connector=None, logger=None, allow=""):
        self.resolver = resolver or self.resolve
        self.connector = connector or self.connect
        self.logger = logger or (lambda reason: print(f"browser proxy refused: {reason}", file=sys.stderr, flush=True))
        self.allow = parse_allow(allow, self.logger)
        self.tasks = set()
        self.loop = None

    def allowed(self, value, port):
        address = ipaddress.ip_address(value)
        if metadata_address(address) or getattr(address, "scope_id", None):
            return False
        return ((port in (80, 443) and public_address(value))
                or any(address in network and port in ports for network, ports in self.allow))

    async def resolve(self, host, port):
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        return [record[4][0] for record in records]

    async def connect(self, address, port):
        # A numeric socket address prevents a second hostname lookup after validation.
        family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setblocking(False)
        try:
            await asyncio.get_running_loop().sock_connect(sock, (address, port))
            return await asyncio.open_connection(sock=sock)
        except BaseException:
            sock.close()
            raise

    async def target(self, host, port):
        if (not host or '%' in host or not 1 <= port <= 65535
                or (port not in (80, 443) and not any(port in ports for _, ports in self.allow))):
            raise ValueError("target port is not allowed (add an IP:port to EMBERVY_BROWSER_ALLOW to allow it)")
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            addresses = await asyncio.wait_for(self.resolver(host, port), self.CONNECT_TIMEOUT)
        else:
            addresses = [str(literal)]
        if any(metadata_address(ipaddress.ip_address(address)) for address in addresses):
            raise ValueError(f"{host} is a metadata address and is always blocked")
        if not addresses or not all(self.allowed(address, port) for address in addresses):
            raise ValueError(f"{host} is not a public address on an allowed port "
                             "(add it to EMBERVY_BROWSER_ALLOW to allow it)")
        return addresses

    async def refuse(self, writer, reason):
        self.logger(reason)
        writer.write(("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n"
                      "X-Embervy-Guard: refused\r\n"
                      f"X-Embervy-Guard-Reason: {quote(reason, safe='')}\r\n"
                      "Connection: close\r\n\r\n").encode("ascii"))
        await asyncio.wait_for(writer.drain(), self.IDLE_TIMEOUT)

    async def relay(self, reader, writer):
        while True:
            data = await asyncio.wait_for(reader.read(65536), self.IDLE_TIMEOUT)
            if not data:
                return
            writer.write(data)
            await asyncio.wait_for(writer.drain(), self.IDLE_TIMEOUT)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        upstream = None
        pumps = []
        admitted = len(self.tasks) < self.MAX_CONNECTIONS
        if admitted:
            self.tasks.add(task)
        try:
            if not admitted:
                await self.refuse(writer, "connection limit")
                return
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), self.CONNECT_TIMEOUT)
            lines = header.decode("iso-8859-1").split("\r\n")
            method, raw, version = lines[0].split(" ")
            if version not in ("HTTP/1.0", "HTTP/1.1"):
                raise ValueError("invalid protocol")
            tunnel = method == "CONNECT"
            url = urlsplit("//" + raw if tunnel else raw)
            if url.username is not None or url.password is not None or url.fragment:
                raise ValueError("invalid authority")
            if tunnel:
                if url.path or url.query or url.port is None:
                    raise ValueError("invalid tunnel")
            elif url.scheme not in ("http", "ws"):
                raise ValueError("invalid scheme")
            port = 80 if url.port is None else url.port
            addresses = await self.target(url.hostname, port)
            failures = []
            # Validate the entire answer before connecting, without resolving again.
            # A broken route for one address must not hide other reachable addresses.
            for address in addresses:
                try:
                    remote_reader, upstream = await asyncio.wait_for(
                        self.connector(address, port), self.ATTEMPT_TIMEOUT)
                    break
                except (OSError, asyncio.TimeoutError) as exc:
                    failures.append(f"{address}: {exc!r}")
            else:
                await self.refuse(writer, f"all connection attempts failed for {url.hostname}:{port}: "
                                  + "; ".join(failures))
                return
            if tunnel:
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await asyncio.wait_for(writer.drain(), self.IDLE_TIMEOUT)
            else:
                # Origin form and a canonical Host keep routing tied to the checked authority.
                headers = []
                for line in lines[1:-2]:
                    name, value = line.split(":", 1)
                    if name.lower() not in ("host", "proxy-connection", "proxy-authorization"):
                        headers.append(f"{name}:{value}")
                path = url.path or "/"
                if url.query:
                    path += "?" + url.query
                request = "\r\n".join([f"{method} {path} {version}", f"Host: {url.netloc}"] + headers) + "\r\n\r\n"
                upstream.write(request.encode("iso-8859-1"))
                await asyncio.wait_for(upstream.drain(), self.IDLE_TIMEOUT)
            pumps = [asyncio.create_task(self.relay(reader, upstream)),
                     asyncio.create_task(self.relay(remote_reader, writer))]
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except (ValueError, OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as exc:
            if upstream is None:
                await self.refuse(writer, str(exc) if isinstance(exc, ValueError)
                                  else "invalid, blocked or unavailable target")
        finally:
            for pump in pumps:
                pump.cancel()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
            if upstream:
                upstream.close()
            writer.close()
            self.tasks.discard(task)

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0, limit=32768)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def __enter__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        try:
            asyncio.run_coroutine_threadsafe(self.start(), self.loop).result()
        except BaseException:
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join()
            self.loop.close()
            raise
        return self

    def __exit__(self, *exc):
        try:
            asyncio.run_coroutine_threadsafe(self.stop(), self.loop).result()
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join()
            self.loop.close()


def process_tree_mb(pid=None, proc="/proc"):
    from pathlib import Path
    root = Path(proc)
    if not root.is_dir():
        return None
    pending = [os.getpid() if pid is None else pid]
    seen = set()
    rss_kb = 0
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        process = root / str(current)
        try:
            for line in (process / "status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss_kb += int(line.split()[1])
                    break
        except (OSError, ValueError, IndexError):
            pass  # Processes can disappear while the tree is being read.
        try:
            tasks = list((process / "task").iterdir())
        except OSError:
            continue
        for task in tasks:
            try:
                pending.extend(int(child) for child in (task / "children").read_text().split())
            except (OSError, ValueError):
                continue
    return rss_kb / 1024


class DaemonLifetime:
    def __init__(self, idle_minutes=30, clock=None, max_mb=0, memory_reader=None):
        self.idle_seconds = idle_minutes * 60
        self.max_mb = max_mb
        self.memory_reader = memory_reader or process_tree_mb
        self.clock = clock or time.monotonic
        self.last_command = self.clock()
        self.busy = False
        self.closing = False

    def command(self, handle, cmd):
        if self.closing:
            raise ConnectionError("daemon is stopping")
        self.last_command = self.clock()
        self.busy = True
        try:
            return handle(cmd)
        finally:
            self.busy = False

    def reason(self):
        if self.busy:
            return None
        if self.idle_seconds and self.clock() - self.last_command >= self.idle_seconds:
            return "idle limit reached"
        if self.max_mb:
            measured = self.memory_reader()
            if measured is not None and measured > self.max_mb:
                return f"memory limit exceeded: {measured:.1f} MB > {self.max_mb:g} MB"
        return None

    def check(self):
        reason = self.reason()
        if reason:
            self.closing = True
            print(f"browse daemon stopping: {reason}", flush=True)
            raise KeyboardInterrupt


def daemon(p: dict) -> None:
    import fcntl
    os.makedirs(p["browser_home"], mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(p["browser_home"], "daemon.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        # Keep the profile exclusive until the browser and driver finish closing.
        with GuardProxy(allow=browser_allow(p["home"])) as proxy:
            browser_daemon(p, proxy)


def browser_daemon(p: dict, proxy: GuardProxy) -> None:
    os.makedirs(p["browser_home"], mode=0o700, exist_ok=True)
    os.makedirs(p["profile"], mode=0o700, exist_ok=True)
    os.chmod(p["profile"], 0o700)  # cookies and live sessions live here
    if "PLAYWRIGHT_BROWSERS_PATH" not in os.environ and os.path.isdir(p["browsers"]):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = p["browsers"]
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(f"browse: Playwright is not installed for {sys.executable} — "
              f"run: bash {os.path.join(HERE, 'install.sh')}", file=sys.stderr)
        sys.exit(3)

    token = secrets.token_hex(16)
    state = {"page": None}
    from collections import deque
    net_log: deque = deque(maxlen=300)
    trace_active = {"on": False}

    import re as _re
    REF = _re.compile(r"^e\d+$")
    REF_IN_SNAP = _re.compile(r"\[ref=e\d+\]")

    # Bind before publishing the token so a daemon that loses the port race
    # cannot overwrite the running daemon's token.
    handle_ref = {}
    server = make_server(p["port"], token, lambda cmd: handle_ref["fn"](cmd))

    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(
        p["profile"],
        headless=True,
        viewport={"width": 1280, "height": 900},
        user_agent=p["user_agent"],
        args=chromium_args(proxy.port),
    )

    def on_response(res):
        try:
            net_log.append({
                "status": res.status,
                "method": res.request.method,
                "url": res.url[:300],
                "type": res.request.resource_type,
                "ct": (res.headers.get("content-type") or "")[:60],
            })
        except Exception:
            pass

    def current_page():
        page = state["page"]
        if page is None or page.is_closed():
            page = ctx.pages[0] if ctx.pages and not ctx.pages[0].is_closed() else ctx.new_page()
            page.on("response", on_response)
            state["page"] = page
        return page

    current_page()

    def handle(cmd: dict) -> dict:
        page = current_page()
        op = cmd.get("op")
        arg = cmd.get("arg", "")
        arg2 = cmd.get("arg2", "")

        def resolve(sel: str):
            if REF.match(sel):
                return page.locator(f"aria-ref={sel}")
            if sel.startswith("text="):
                return page.get_by_text(sel[5:], exact=False).first
            return page.locator(sel).first

        if op == "goto":
            response = page.goto(arg, wait_until="domcontentloaded", timeout=30000)
            if response is not None and response.status == 403 and response.headers.get("x-embervy-guard") == "refused":
                reason = unquote(response.headers.get("x-embervy-guard-reason", "target is blocked"))
                return {"ok": False, "url": page.url, "error": f"refused by the browser guard: {reason}"}
            page.wait_for_timeout(800)
            return {"ok": True, "url": page.url, "title": page.title()}
        if op == "read":
            if arg:
                text = resolve(arg).inner_text(timeout=8000)
            else:
                text = page.locator("body").inner_text(timeout=8000)
            text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
            clipped = len(text) > MAX_TEXT
            return {"ok": True, "url": page.url, "title": page.title(),
                    "clipped": clipped, "text": text[:MAX_TEXT]}
        if op == "links":
            links = page.eval_on_selector_all(
                "a[href]",
                "els => els.slice(0, 200).map(e => ({t: e.innerText.trim().slice(0, 80), h: e.href}))",
            )
            return {"ok": True, "links": [l for l in links if l["t"]]}
        if op == "click":
            resolve(arg).click(timeout=8000)
            page.wait_for_timeout(800)
            return {"ok": True, "url": page.url, "title": page.title()}
        if op == "fill":
            resolve(arg).fill(arg2, timeout=8000)
            return {"ok": True}
        if op == "press":
            page.keyboard.press(arg)
            page.wait_for_timeout(800)
            return {"ok": True, "url": page.url}
        if op == "shot":
            path = arg or p["shot"]
            rested = {"skipped": True} if cmd.get("now") else settle(page)
            page.screenshot(path=path, full_page=False)
            return {"ok": True, "path": path, "settle": rested}
        if op == "film":
            seconds, frames, path = film_args(arg, arg2, p["film"])
            return film(page, ctx, seconds, frames, path)
        if op == "url":
            return {"ok": True, "url": page.url, "title": page.title()}
        if op == "back":
            page.go_back(wait_until="domcontentloaded", timeout=15000)
            return {"ok": True, "url": page.url}
        if op == "snap":
            # AI mode exposes element references that later commands use as selectors.
            loc = resolve(arg) if arg else page.locator("body")
            try:
                text = loc.aria_snapshot(timeout=8000, mode="ai")
            except TypeError:  # Some Playwright versions do not accept mode.
                text = loc.aria_snapshot(timeout=8000)
            clipped = len(text) > MAX_TEXT
            return {"ok": True, "url": page.url, "clipped": clipped,
                    "refs": len(REF_IN_SNAP.findall(text)), "text": text[:MAX_TEXT]}
        if op == "shotfull":
            path = arg or p["shot"]
            steps = reveal(page)
            rested = {"skipped": True} if cmd.get("now") else settle(page)
            page.screenshot(path=path, full_page=True)
            return {"ok": True, "path": path, "settle": rested, "reveal_steps": steps}
        if op == "shotel":
            path = arg2 or p["shot"]
            loc = resolve(arg)
            # Scrolling the element into view can itself start the animations we must await.
            if not cmd.get("now"):
                loc.scroll_into_view_if_needed(timeout=8000)
            rested = {"skipped": True} if cmd.get("now") else settle(page)
            loc.screenshot(path=path, timeout=8000)
            return {"ok": True, "path": path, "settle": rested}
        if op == "pdf":
            path = arg or p["pdf"]
            page.pdf(path=path, format="A4", print_background=True)
            return {"ok": True, "path": path}
        if op == "net":
            n = int(arg) if arg else 40
            items = list(net_log)[-n:]
            if arg2:
                items = [i for i in items if arg2 in i["url"]]
            return {"ok": True, "count": len(items), "responses": items}
        if op == "trace":
            if arg == "start":
                ctx.tracing.start(screenshots=True, snapshots=True, sources=False)
                trace_active["on"] = True
                return {"ok": True, "tracing": True}
            if arg == "stop":
                path = arg2 or p["trace"]
                if not trace_active["on"]:
                    return {"ok": False, "error": "no trace running"}
                ctx.tracing.stop(path=path)
                trace_active["on"] = False
                return {"ok": True, "path": path, "view": f"playwright show-trace {path}"}
            return {"ok": False, "error": "trace start | trace stop [path]"}
        if op == "state":
            # Exported cookies and local storage grant login access, so only the owner may read them.
            path = arg or p["storage"]
            ctx.storage_state(path=path)
            os.chmod(path, 0o600)
            return {"ok": True, "path": path}
        if op == "role":
            page.get_by_role(arg, name=arg2, exact=False).first.click(timeout=8000)
            page.wait_for_timeout(800)
            return {"ok": True, "url": page.url, "title": page.title()}
        if op == "eval":
            return {"ok": True, "result": page.evaluate(arg)}
        if op == "stop":
            return {"ok": True, "stopping": True}
        return {"ok": False, "error": f"unknown op {op}"}

    lifetime = DaemonLifetime(idle_minutes=p["idle_minutes"], max_mb=p["max_mb"])
    handle_ref["fn"] = lambda cmd: lifetime.command(handle, cmd)
    # HTTPServer runs this hook between requests on the Playwright thread.
    server.service_actions = lifetime.check
    write_private(p["token"], token)
    print(f"browse daemon on 127.0.0.1:{p['port']}, profile {p['profile']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.remove(p["token"])
        except OSError:
            pass
        server.server_close()
        try:
            ctx.close()
        finally:
            pw.stop()


class Forbidden(Exception):
    """The port answers, but not with this install's token."""


def send(cmd: dict, p: dict) -> dict:
    try:
        with open(p["token"]) as f:
            token = f.read().strip()
    except OSError:
        token = ""
    req = urllib.request.Request(
        f"http://127.0.0.1:{p['port']}/",
        data=json.dumps(cmd).encode(),
        headers={"Content-Type": "application/json", TOKEN_HEADER: token},
    )
    try:
        with urllib.request.urlopen(req, timeout=CLIENT_TIMEOUT) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            try:
                with open(p["token"]) as f:
                    current_token = f.read().strip()
            except OSError:
                current_token = ""
            if current_token != token:
                raise ConnectionError("daemon changed during request") from None
            raise Forbidden() from None
        raise


def is_timeout(exc: BaseException) -> bool:
    return isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError)


def fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(2)


def autostart(p: dict):
    """Daemon not running — start it with the Python that has Playwright."""
    import subprocess
    python = p["python"] if os.access(p["python"], os.X_OK) else sys.executable
    os.makedirs(os.path.dirname(p["log"]), exist_ok=True)
    with open(p["log"], "ab") as log:
        return subprocess.Popen(
            [python, os.path.abspath(__file__), "daemon"],
            stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
        )


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    p = paths()
    if sys.argv[1] == "daemon":
        daemon(p)
        return
    cmd = build_cmd(sys.argv[1:])
    wrong_port = (f"127.0.0.1:{p['port']} answers, but not with this install's key — "
                  f"another agent's browser? Set EMBERVY_BROWSER_PORT to a free port in .env")
    try:
        result = send(cmd, p)
    except Forbidden:
        fail(wrong_port)
    except Exception as exc:
        if is_timeout(exc):
            fail(f"no answer within {CLIENT_TIMEOUT} s — the page may still be loading; try url, or stop")
        if cmd["op"] == "stop":
            print(json.dumps({"ok": True, "note": "daemon was not running"}))
            return
        import time
        child = autostart(p)
        for _ in range(30):
            time.sleep(1)
            try:
                result = send(cmd, p)
                break
            except Exception as retry_exc:  # Startup can answer before its token file is ready.
                if is_timeout(retry_exc):
                    fail(f"no answer within {CLIENT_TIMEOUT} s — the page may still be loading; try url, or stop")
                if child.poll() is not None:
                    child = autostart(p)
                continue
        else:
            fail(f"browser daemon did not start — see {p['log']}; "
                 f"install or repair: bash {os.path.join(HERE, 'install.sh')}")
    if "text" in result:
        meta = {k: v for k, v in result.items() if k != "text"}
        print(json.dumps(meta, ensure_ascii=False))
        print(result["text"])
    else:
        print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
