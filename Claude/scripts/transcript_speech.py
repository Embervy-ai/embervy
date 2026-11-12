"""Shared speech selection for transcript exports."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def is_room_tool(name):
    return name == "room" or name.endswith("__room")


def is_peer_tool(name):
    return name == "peer" or name.endswith("__peer")


def blocks(entry):
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def real_user(entry):
    return entry.get("type") == "user" and not any(
        block.get("type") == "tool_result" for block in blocks(entry)
    )


AUTOMATIC_PROMPT = re.compile(r'^\s*(?:\[silent\]\s*)?\[gateway(?::[a-z-]+)?\]|^\s*\[system:cache-ping\]')
CONTINUATION_NOTICE = '[Your previous response had no visible output. Please continue and produce a user-visible response.]'


def strip_transcript_tags(text, reminders_only=False):
    tags = ('system-reminder',) if reminders_only else (
        'system-reminder', 'local-command-caveat', 'local-command-stdout',
        'command-name', 'command-message', 'command-args',
    )
    for tag in tags:
        text = re.sub(rf'<{tag}>.*?</{tag}>', '', text, flags=re.DOTALL)
    return text.strip()


def result_text(result):
    content = (result or {}).get("content", "")
    if isinstance(content, list):
        content = "\n".join(part.get("text", "") for part in content
                            if isinstance(part, dict) and isinstance(part.get("text"), str))
    return content if isinstance(content, str) else ""


def not_delivered(result):
    """A send the tool itself reported as failed reached nobody. Without a result the send stays,
    since an interrupted turn may still have delivered it."""
    if not result:
        return False
    return bool(result.get("is_error")) or re.match(
        r'\s*(?:error\b|failed\b|failure\b|NOT (?:delivered|sent)\b)', result_text(result), re.IGNORECASE) is not None


def is_channel_message(content):
    # A channel notification starts with its wrapper; a meta entry that only quotes one is not a message.
    return isinstance(content, str) and re.match(
        r'\s*(?:<system-reminder>.*?</system-reminder>\s*)*<channel\b', content, re.DOTALL) is not None


def user_speech(entry, user_label=None, room_names=None):
    """Return inbound speaker/text pairs without choosing an export format."""
    message = entry.get('message')
    if entry.get('type') != 'user' or not isinstance(message, dict) or message.get('role') != 'user':
        return []
    content = message.get('content')
    if not isinstance(content, str):
        return []
    # Claude Code marks channel messages as meta too; only meta without a channel is harness noise.
    if entry.get('isMeta') is True and not is_channel_message(content):
        return []
    if user_label is None:
        user_label = os.environ.get('USER_LABEL', 'User')
    if room_names is None:
        room_names = {os.environ.get(key, '').strip() for key in ('EMBERVY_ROOM_NAME', 'ROOM_NAME')} - {''}
    content = strip_transcript_tags(content)
    bodies = []
    depth = 0
    start = 0
    opening = ''
    # Balance real wrappers so a nested closing tag cannot truncate the body.
    for tag in re.finditer(r'</?channel\b[^>]*>', content):
        if tag.group().startswith('</'):
            if depth:
                depth -= 1
                if not depth:
                    bodies.append((opening, content[start:tag.start()]))
        else:
            if not depth:
                start = tag.end()
                opening = tag.group()
            depth += 1
    if depth:
        bodies.append((opening, content[start:]))
    if bodies:
        bodies = [(head, re.sub(r'</?channel\b[^>]*>', '', body)) for head, body in bodies
                  # A scheduled prompt is the installation's own, whatever its words.
                  if not re.search(r'\bkind="scheduled"', head)]
    else:
        bodies = [('', content)]
    pairs = []
    interruption = r'\[Request interrupted by user(?: for tool use)?\](?: for tool use)?'
    hook = r'(?:Stop hook feedback:|(?:PreToolUse|PostToolUse):[^\r\n]*\bhook error\b)'
    task = re.compile(r'(<task-notification\b[^>]*>.*?</task-notification>)', re.DOTALL)
    for head, body in bodies:
        # The channel names a room message as such, even where no room name is configured.
        in_room = re.search(r'\bkind="room"', head) is not None
        body = body.strip()
        if not body or body == CONTINUATION_NOTICE or AUTOMATIC_PROMPT.match(body) or re.match(hook, body):
            continue
        for part in task.split(body):
            part = part.strip()
            if task.fullmatch(part):
                summary = ''
                for field in ('summary', 'status'):
                    match = re.search(rf'<{field}\b[^>]*>(.*?)</{field}>', part, re.DOTALL)
                    if match:
                        summary = ' '.join(re.sub(r'<[^>]*>', '', match.group(1)).split())
                        if summary:
                            break
                summary = summary or 'A background task changed state.'
                pairs.append(('System', summary if len(summary) <= 240 else summary[:239] + '…'))
                continue
            if re.match(hook, part):
                continue
            part = ''.join(line for line in part.splitlines(keepends=True)
                           if not re.fullmatch(interruption, line.strip()) and not re.match(hook, line.lstrip())).strip()
            if not part or part == CONTINUATION_NOTICE or AUTOMATIC_PROMPT.match(part):
                continue
            prefix = re.match(r'^\[([^\]/\r\n]+)/([^\]/\r\n]+)\]', part)
            speaker = user_label
            if prefix and (prefix.group(1) == 'Direct' or prefix.group(1) in room_names or in_room):
                speaker = prefix.group(2).strip() or user_label
            pairs.append((speaker, part))
    return pairs


def app_tool_names():
    library = Path(__file__).resolve().parents[2] / "shared/scripts/legacy-names.sh"
    try:
        result = subprocess.run(
            ["bash", "-c", '. "$1"; embervy_app_tool_names reply send voice_reply email', "speech", str(library)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
        )
        return set(result.stdout.decode("utf-8").split())
    except (OSError, UnicodeError, subprocess.SubprocessError):
        return {"mcp__app__" + tool for tool in ("reply", "send", "voice_reply", "email")}


class TranscriptSpeech:
    def __init__(self):
        names = app_tool_names()
        self.gateway_tools = {name for name in names if not name.endswith("__email")}
        self.reply_tools = set(filter(None, os.environ.get(
            "REPLY_TOOL_NAMES", ",".join(name for name in names if name.endswith(("__reply", "__send")))
        ).split(","))) | {name for name in names if name.endswith("__voice_reply")}
        self.email_tools = set(filter(None, os.environ.get(
            "EMAIL_TOOL_NAMES", ",".join(name for name in names if name.endswith("__email"))
        ).split(",")))
        state = Path(os.environ.get("EMBERVY_GATEWAY_STATE_DIR") or
                     str(Path(os.environ.get("EMBERVY_HOME") or "/opt/embervy") / "state"))
        self.uuids = self.read_log(state / "gateway-sent-uuids.log")
        self.hashes = self.read_log(state / "gateway-sent-hashes.log")
        data = Path(os.environ.get("EMBERVY_APP_DATA_DIR") or
                    str(Path(os.environ.get("EMBERVY_HOME") or "/opt/embervy") / "Claude/app/data"))
        self.outbox = self.read_outbox(data / "email-outbox.jsonl")

    @staticmethod
    def read_outbox(path):
        outbox = {}
        try:
            with path.open(encoding="utf-8") as source:
                for line in source:
                    try:
                        mail = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(mail, dict) and isinstance(mail.get("id"), str):
                        outbox[mail["id"]] = mail
        except (OSError, UnicodeError):
            return {}
        return outbox

    def render_email(self, block, result):
        if result.get("is_error"):
            return ""
        content = result.get("content", "")
        if isinstance(content, list):
            content = "\n".join(part.get("text", "") for part in content
                                if isinstance(part, dict) and part.get("type") == "text"
                                and isinstance(part.get("text"), str))
        match = re.match(r"\A\[Email outgoing\] id=(\S+) status=(\w+)(?=\s|$)",
                         content if isinstance(content, str) else "")
        mail_id, status = match.groups() if match else (None, None)
        if status == "failed":
            return ""
        mail = self.outbox.get(mail_id)
        sent = (mail.get("status") == "sent" or bool(mail.get("sent_at"))) if mail is not None else status == "sent"
        if mail is not None and mail.get("status") == "failed" and not sent:
            return ""
        data = mail if mail is not None else block.get("input") or {}
        to, subject, body = (data.get(key, "") for key in ("to", "subject", "body"))
        if sent:
            return f"[Email to {to}]\nSubject: {subject}\n\n{body}"
        to, subject = (" ".join(str(value).split()) for value in (to, subject))
        return f"[Mail draft to {to}: {subject}, not sent]"

    @staticmethod
    def read_log(path):
        try:
            return set(path.read_text(encoding="utf-8").splitlines()) - {""}
        except (OSError, UnicodeError):
            return set()

    def delivered_plain(self, turn):
        # Match the gateway's whole-turn scan, not individual assistant records.
        if not turn or not real_user(turn[0]):
            return False
        tail = turn[1:]
        ok = {block.get("tool_use_id") for entry in tail for block in blocks(entry)
              if block.get("type") == "tool_result" and not not_delivered(block)}
        content = (turn[0].get("message") or {}).get("content")
        user = "\n".join(block.get("text", "") for block in blocks(turn[0])
                         if block.get("type") == "text") if isinstance(content, list) else (content or "")
        room_turn = bool(re.search(r'<channel\b[^>]*\bkind="room"[^>]*>', user))
        room_delivered = room_turn and any(
            block.get("type") == "tool_use" and is_room_tool(str(block.get("name", "")))
            and block.get("id") and block.get("id") in ok
            for entry in tail for block in blocks(entry)
        )
        delivered, undelivered, plain = [], [], []
        uuid = ""
        for entry in tail:
            for block in blocks(entry):
                if block.get("type") == "tool_use" and block.get("name") in self.gateway_tools:
                    text = str((block.get("input") or {}).get("text") or "").strip()
                    target = delivered if block.get("id") and block.get("id") in ok else undelivered
                    if text and text not in target:
                        target.append(text)
            if entry.get("type") == "assistant":
                uuid = entry.get("uuid") or uuid
                for block in blocks(entry):
                    if block.get("type") == "text" and block.get("text", "").strip():
                        plain.append(block["text"].strip())
        # OWED sends contain only missing replies, never the surrounding terminal prose.
        if delivered or room_delivered or any("[still]" in text for text in plain):
            return False
        missing = [text for text in undelivered if text not in delivered]
        composed = "\n\n".join(missing + plain)
        return bool(plain) and (uuid in self.uuids or
                               hashlib.sha256(composed.encode("utf-8")).hexdigest() in self.hashes)

    def render(self, entry, delivered_plain=False, results=None, owed_delivered=False):
        if entry.get("type") != "assistant" or (entry.get("message") or {}).get("role") != "assistant":
            return ""
        parts = []
        for block in blocks(entry):
            if block.get("type") == "text" and delivered_plain:
                text = block.get("text", "").strip()
                if text:
                    parts.append(f"[App] {text}")
            elif block.get("type") == "tool_use":
                name = str(block.get("name", ""))
                data = block.get("input") or {}
                if not isinstance(data, dict):
                    continue
                text = str(data.get("text") or "").strip()
                # A failed send reached nobody, unless the reply gateway resent it for this turn.
                failed = not_delivered((results or {}).get(block.get("id")))
                if failed and not (name in self.reply_tools and (owed_delivered or delivered_plain)) and \
                        (name in self.reply_tools or is_room_tool(name) or is_peer_tool(name)):
                    continue
                if name in self.reply_tools and text:
                    parts.append(f"[App] {text}")
                elif name in self.email_tools:
                    email = self.render_email(block, (results or {}).get(block.get("id"), {}))
                    if email:
                        parts.append(email)
                elif is_room_tool(name) and text:
                    parts.append(f"[Room] {text}")
                elif is_peer_tool(name) and text:
                    to = str(data.get("to") or "").strip()
                    parts.append(f"[Direct/{to}] {text}" if to else f"[Direct] {text}")
        return "\n\n".join(parts)

    def entries(self, entries):
        entries = [entry for entry in entries if not entry.get("isSidechain", False)]
        results = {block["tool_use_id"]: block for entry in entries for block in blocks(entry)
                   if block.get("type") == "tool_result" and block.get("tool_use_id")}
        turn = []
        for entry in entries:
            if real_user(entry) and turn:
                yield from self.turn_entries(turn, results)
                turn = []
            turn.append(entry)
        yield from self.turn_entries(turn, results)

    def owed_delivered(self, turn):
        """The gateway resends replies whose tool call failed (OWED) and records the send."""
        if not turn or not real_user(turn[0]):
            return False
        ok = {block.get("tool_use_id") for entry in turn[1:] for block in blocks(entry)
              if block.get("type") == "tool_result" and not not_delivered(block)}
        delivered, undelivered, uuid = [], [], ""
        for entry in turn[1:]:
            for block in blocks(entry):
                if block.get("type") == "tool_use" and block.get("name") in self.gateway_tools:
                    text = str((block.get("input") or {}).get("text") or "").strip()
                    target = delivered if block.get("id") and block.get("id") in ok else undelivered
                    if text and text not in target:
                        target.append(text)
            if entry.get("type") == "assistant":
                uuid = entry.get("uuid") or uuid
        missing = [text for text in undelivered if text not in delivered]
        return bool(missing) and (uuid in self.uuids or
                                  hashlib.sha256("\n\n".join(missing).encode("utf-8")).hexdigest() in self.hashes)

    def turn_entries(self, turn, results=None):
        delivered = self.delivered_plain(turn)
        owed = self.owed_delivered(turn)
        for entry in turn:
            yield entry, self.render(entry, delivered, results, owed)
