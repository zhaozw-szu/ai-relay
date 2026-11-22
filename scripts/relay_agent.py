"""Local AI Relay Agent for restricted Codex CLI task execution.

The agent is intentionally pull-based. It never accepts a remote absolute path
or builds a shell command from task text. The Worker remains the authority for
conversation state, approval and task leases.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import logging
import os
import signal
import shutil
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class RelayError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class AgentConfig:
    worker_url: str
    agent_id: str
    agent_key: str
    poll_interval_seconds: int = 60
    heartbeat_interval_seconds: int = 30
    lease_seconds: int = 900
    max_task_seconds: int = 1800
    codex_command: tuple[str, ...] = ("codex",)
    working_directories: dict[str, str] | None = None
    state_file: str = "relay_agent_state.json"
    retry_file: str = "relay_agent_outbox.json"
    dead_letter_file: str = "relay_agent_dead_letter.json"
    allow_workspace_write: bool = False

    @classmethod
    def from_file(cls, path: Path) -> "AgentConfig":
        path = path.resolve()
        data = json.loads(path.read_text(encoding="utf-8"))
        command = data.get("codex_command", "codex")
        if isinstance(command, str):
            command = (command,)
        elif isinstance(command, list) and all(isinstance(item, str) and item for item in command):
            command = tuple(command)
        else:
            raise ValueError("codex_command must be a string or a non-empty string list")
        directories = data.get("working_directories", {})
        if not isinstance(directories, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in directories.items()):
            raise ValueError("working_directories must map IDs to local paths")
        for required in ("worker_url", "agent_id", "agent_key"):
            if not isinstance(data.get(required), str) or not data[required].strip():
                raise ValueError(f"{required} is required")
        def local_path(value: Any, default: str) -> str:
            candidate = Path(str(value or default)).expanduser()
            return str(candidate if candidate.is_absolute() else (path.parent / candidate).resolve())

        return cls(
            worker_url=data["worker_url"].rstrip("/"),
            agent_id=data["agent_id"],
            agent_key=data["agent_key"],
            poll_interval_seconds=max(5, int(data.get("poll_interval_seconds", 60))),
            heartbeat_interval_seconds=max(5, int(data.get("heartbeat_interval_seconds", 30))),
            lease_seconds=min(max(30, int(data.get("lease_seconds", 900))), 3600),
            max_task_seconds=min(max(10, int(data.get("max_task_seconds", 1800))), 86400),
            codex_command=command,
            working_directories=directories,
            state_file=local_path(data.get("state_file"), "relay_agent_state.json"),
            retry_file=local_path(data.get("retry_file"), "relay_agent_outbox.json"),
            dead_letter_file=local_path(data.get("dead_letter_file"), "relay_agent_dead_letter.json"),
            allow_workspace_write=bool(data.get("allow_workspace_write", False)),
        )


class WorkerClient:
    def __init__(self, config: AgentConfig, timeout: float = 30):
        self.config = config
        self.timeout = timeout

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            self.config.worker_url + path,
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "ai-relay-agent/1.0",
                "X-Agent-Key": self.config.agent_key,
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RelayError(detail or f"Worker HTTP {error.code}", error.code) from error
        except (URLError, TimeoutError, OSError) as error:
            raise RelayError(f"Worker request failed: {error}") from error

    def heartbeat(self, status: str = "online", current_task_id: str | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/agent/heartbeat", {"agent_id": self.config.agent_id, "status": status, "current_task_id": current_task_id})

    def claim(self) -> dict[str, Any]:
        return self.request("POST", "/api/agent/claim", {"agent_id": self.config.agent_id, "lease_seconds": self.config.lease_seconds})

    def ack(self, task: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/api/agent/tasks/{task['task_id']}/ack", {"agent_id": self.config.agent_id, "lease_token": task["lease_token"]})

    def renew(self, task: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/api/agent/tasks/{task['task_id']}/renew", {"agent_id": self.config.agent_id, "lease_token": task["lease_token"], "lease_seconds": self.config.lease_seconds})

    def result(self, task: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/api/agent/tasks/{task['task_id']}/result", {"agent_id": self.config.agent_id, "lease_token": task["lease_token"], **result})


def resolve_codex_command(command: tuple[str, ...]) -> list[str]:
    executable = command[0]
    # Prefer a native executable on Windows. A .cmd shim cannot be passed to
    # CreateProcess with shell=False reliably.
    resolved = shutil.which(f"{executable}.exe") or shutil.which(executable) or shutil.which(f"{executable}.cmd")
    if resolved and resolved.lower().endswith((".cmd", ".bat")):
        raise RelayError("codex_command resolved to a shell shim; configure a native codex.exe path")
    if resolved and resolved.lower().endswith(".ps1"):
        return ["pwsh", "-NoProfile", "-File", resolved, *command[1:]]
    return [resolved or executable, *command[1:]]


def resolve_working_directory(config: AgentConfig, task: dict[str, Any]) -> Path:
    directory_id = task.get("working_directory_id")
    directories = config.working_directories or {}
    if not directory_id or directory_id not in directories:
        raise RelayError("task working_directory_id is not in the local allowlist")
    path = Path(directories[directory_id]).expanduser().resolve()
    if not path.is_dir():
        raise RelayError(f"allowed working directory does not exist: {directory_id}")
    return path


def _terminate_process_tree(process: Any) -> None:
    """Terminate Codex and descendants without invoking task text through a shell."""
    pid = getattr(process, "pid", None)
    try:
        if os.name == "nt" and pid:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
        elif os.name != "nt" and pid:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (AttributeError, ProcessLookupError, PermissionError):
                pass
    finally:
        try:
            process.kill()
        except (AttributeError, OSError):
            pass


def _secure_file(path: Path) -> None:
    """Best-effort owner-only mode for state, outbox, and dead-letter files."""
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        # Windows ACLs may ignore POSIX mode bits; the file still remains
        # outside the repository and is never included in a task payload.
        pass


def execute_codex(config: AgentConfig, task: dict[str, Any], timeout: int | None = None, cancel_event: threading.Event | None = None, process_callback: Callable[[Any | None], None] | None = None) -> dict[str, Any]:
    sandbox = task.get("sandbox_mode", "read-only")
    if sandbox not in {"read-only", "workspace-write"}:
        raise RelayError("unsupported sandbox mode")
    if sandbox == "workspace-write" and (not config.allow_workspace_write or task.get("approval_status") != "approved"):
        raise RelayError("workspace-write task is not approved or not enabled locally")
    workdir = resolve_working_directory(config, task)
    instruction = task.get("instruction", "")
    if not isinstance(instruction, str) or not instruction.strip():
        raise RelayError("task instruction is empty")
    command = [*resolve_codex_command(config.codex_command), "exec", "--sandbox", sandbox, "--cd", str(workdir), instruction]
    started = time.monotonic()
    popen_kwargs: dict[str, Any] = {
        "cwd": str(workdir),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "shell": False,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **popen_kwargs)
    if process_callback is not None:
        process_callback(process)
    deadline = time.monotonic() + (timeout or config.max_task_seconds)
    lease_lost = False
    timed_out = False
    try:
        try:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    lease_lost = True
                    _terminate_process_tree(process)
                    stdout, stderr = process.communicate()
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    _terminate_process_tree(process)
                    stdout, stderr = process.communicate()
                    break
                try:
                    stdout, stderr = process.communicate(timeout=min(1.0, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except (OSError, ValueError):
            _terminate_process_tree(process)
            raise
    finally:
        if process_callback is not None:
            process_callback(None)
    if lease_lost:
        summary = (stdout or stderr).strip()[-10000:]
        return {
            "status": "failed",
            "result_summary": summary,
            "error": "task lease was lost; Codex execution was terminated",
            "error_code": "lease_lost",
            "duration_seconds": round(time.monotonic() - started, 3),
        }
    duration = round(time.monotonic() - started, 3)
    summary = (stdout or stderr).strip()[-10000:]
    if timed_out:
        return {"status": "timed_out", "result_summary": summary, "error": "Codex CLI timed out", "error_code": "timeout", "duration_seconds": duration}
    if process.returncode != 0:
        return {"status": "failed", "result_summary": summary, "error": f"Codex CLI exited with {process.returncode}", "error_code": "codex_exit", "duration_seconds": duration}
    return {"status": "succeeded", "result_summary": summary, "result": {"stdout": stdout[-20000:], "stderr": stderr[-5000:]}, "duration_seconds": duration}


class RelayAgent:
    def __init__(self, config: AgentConfig, client: WorkerClient | Any | None = None, runner: Callable[..., dict[str, Any]] = execute_codex, logger: logging.Logger | None = None):
        self.config = config
        self.client = client or WorkerClient(config)
        self.runner = runner
        self.logger = logger or logging.getLogger("relay-agent")
        self.stop_event = threading.Event()
        self._heartbeat_stop = threading.Event()
        self._renew_stop = threading.Event()
        self._lease_lost = threading.Event()
        self._active_process: Any | None = None
        self._active_process_lock = threading.Lock()
        self.state_path = Path(config.state_file).expanduser()
        self.retry_path = Path(config.retry_file).expanduser()
        self.dead_letter_path = Path(config.dead_letter_file).expanduser()

    MAX_OUTBOX_ITEMS = 100
    MAX_RETRY_ATTEMPTS = 10

    def stop(self, *_args: Any) -> None:
        self.stop_event.set()

    def _load_queue(self) -> list[dict[str, Any]]:
        if not self.retry_path.exists(): return []
        try:
            value = json.loads(self.retry_path.read_text(encoding="utf-8"))
            if not isinstance(value, list):
                raise ValueError("outbox must contain a JSON list")
            return value
        except (OSError, ValueError):
            self._quarantine_file(self.retry_path, "corrupt")
            return []

    @staticmethod
    def _quarantine_file(path: Path, reason: str) -> None:
        if not path.exists():
            return
        candidate = path.with_name(f"{path.name}.{reason}-{int(time.time() * 1000)}")
        try:
            path.replace(candidate)
        except OSError:
            # Leave the original file in place for manual recovery if it
            # cannot be moved; never overwrite it with an empty queue.
            pass

    def _save_queue(self, queue: list[dict[str, Any]]) -> None:
        self.retry_path.parent.mkdir(parents=True, exist_ok=True)
        if len(queue) > self.MAX_OUTBOX_ITEMS:
            overflow = queue[self.MAX_OUTBOX_ITEMS:]
            queue = queue[:self.MAX_OUTBOX_ITEMS]
            self._append_dead_letters(overflow, "outbox_capacity_exceeded")
        temporary = self.retry_path.with_suffix(self.retry_path.suffix + ".tmp")
        temporary.write_text(json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.retry_path)
        _secure_file(self.retry_path)

    def _append_dead_letters(self, items: list[dict[str, Any]], reason: str) -> None:
        if not items:
            return
        self.dead_letter_path.parent.mkdir(parents=True, exist_ok=True)
        existing: list[dict[str, Any]] = []
        if self.dead_letter_path.exists():
            try:
                value = json.loads(self.dead_letter_path.read_text(encoding="utf-8"))
                if not isinstance(value, list):
                    raise ValueError("dead-letter file must contain a JSON list")
                existing = value
            except (OSError, ValueError):
                self._quarantine_file(self.dead_letter_path, "corrupt")
        for item in items:
            existing.append({"failed_at": time.time(), "reason": reason, **item})
        temporary = self.dead_letter_path.with_suffix(self.dead_letter_path.suffix + ".tmp")
        temporary.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.dead_letter_path)
        _secure_file(self.dead_letter_path)

    def _queue_result(self, task: dict[str, Any], result: dict[str, Any], reason: str) -> None:
        queue = self._load_queue()
        queue.append({"task": task, "result": result, "attempts": 0, "last_error": reason, "queued_at": time.time()})
        self._save_queue(queue)

    def _retry_results(self) -> None:
        queue = self._load_queue()
        remaining: list[dict[str, Any]] = []
        for item in queue:
            try:
                self.client.result(item["task"], item["result"])
            except RelayError as error:
                item["attempts"] = int(item.get("attempts", 0)) + 1
                item["last_error"] = redact(str(error), self.config.agent_key)
                if error.status in {400, 401, 403, 404, 409, 422} or item["attempts"] >= self.MAX_RETRY_ATTEMPTS:
                    self._append_dead_letters([item], "result_retry_failed")
                else:
                    remaining.append(item)
            except (OSError, ValueError) as error:
                item["attempts"] = int(item.get("attempts", 0)) + 1
                item["last_error"] = redact(str(error), self.config.agent_key)
                if item["attempts"] >= self.MAX_RETRY_ATTEMPTS:
                    self._append_dead_letters([item], "result_retry_failed")
                else:
                    remaining.append(item)
        self._save_queue(remaining)

    def _save_active(self, task: dict[str, Any] | None) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        if task is None:
            try: self.state_path.unlink()
            except FileNotFoundError: pass
            return
        # The lease token is local operational state, never logged or committed.
        self.state_path.write_text(json.dumps({"task_id": task.get("task_id"), "saved_at": time.time()}, ensure_ascii=False), encoding="utf-8")
        _secure_file(self.state_path)

    def _renew_loop(self, task: dict[str, Any]) -> None:
        wait_seconds = max(10, min(self.config.lease_seconds // 3, 120))
        while not self._renew_stop.wait(wait_seconds):
            try:
                renewed = self.client.renew(task)
                if isinstance(renewed, dict) and renewed.get("lease_expires_at"):
                    task["lease_expires_at"] = renewed["lease_expires_at"]
            except RelayError as error:
                expires_at = task.get("lease_expires_at")
                try:
                    expires_epoch = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")).timestamp() if expires_at else 0
                except (TypeError, ValueError, OverflowError):
                    expires_epoch = 0
                safety_window = max(5, self.config.heartbeat_interval_seconds)
                explicit_loss = error.status in {401, 403, 404, 409}
                unsafe_to_continue = not expires_epoch or time.time() >= expires_epoch - safety_window
                self.logger.warning("lease renewal failed for %s: %s", task.get("task_id"), redact(str(error), self.config.agent_key))
                if explicit_loss or unsafe_to_continue:
                    self._lease_lost.set()
                    self._terminate_active_process()
                    return

    def _terminate_active_process(self) -> None:
        with self._active_process_lock:
            process = self._active_process
        if process is not None:
            _terminate_process_tree(process)

    def _set_active_process(self, process: Any | None) -> None:
        with self._active_process_lock:
            self._active_process = process

    def _heartbeat_loop(self) -> None:
        while not self._heartbeat_stop.wait(self.config.heartbeat_interval_seconds):
            try: self.client.heartbeat("online")
            except RelayError as error: self.logger.warning("heartbeat failed: %s", redact(str(error), self.config.agent_key))

    def run_once(self) -> bool:
        self._retry_results()
        self.client.heartbeat("online")
        claimed = self.client.claim()
        task = claimed.get("task") if isinstance(claimed, dict) else None
        if not task: return False
        self._save_active(task)
        renew_thread = threading.Thread(target=self._renew_loop, args=(task,), name="relay-lease-renewer", daemon=True)
        self._renew_stop.clear(); self._lease_lost.clear(); renew_thread.start()
        result: dict[str, Any] | None = None
        try:
            try:
                self.client.ack(task)
            except (RelayError, OSError, ValueError) as error:
                self.logger.error("task %s could not be acknowledged: %s", task.get("task_id"), redact(str(error), self.config.agent_key))
                return True
            try:
                if self.runner is execute_codex:
                    result = self.runner(self.config, task, self.config.max_task_seconds, self._lease_lost, self._set_active_process)
                else:
                    result = self.runner(self.config, task, self.config.max_task_seconds)
            except (RelayError, OSError, ValueError) as error:
                result = {"status": "failed", "result_summary": "本地 Agent 执行失败。", "error": redact(str(error), self.config.agent_key), "error_code": "agent_error"}
            result = dict(result or {"status": "failed", "result_summary": "本地 Agent 未返回结果。", "error_code": "agent_error"})
            result.setdefault("result_id", f"result-{task.get('task_id')}-{int(time.time() * 1000)}")
            if self._lease_lost.is_set():
                self._append_dead_letters([{"task": task, "result": result}], "lease_lost_before_result")
            else:
                try:
                    self.client.result(task, result)
                except (RelayError, OSError, ValueError) as error:
                    self.logger.error("task %s result submission failed: %s", task.get("task_id"), redact(str(error), self.config.agent_key))
                    self._queue_result(task, result, redact(str(error), self.config.agent_key))
        finally:
            self._renew_stop.set(); renew_thread.join(timeout=2); self._save_active(None)
            try: self.client.heartbeat("online")
            except RelayError: pass
        return True

    def run_forever(self) -> None:
        self.client.heartbeat("online")
        heartbeat_thread = threading.Thread(target=self._heartbeat_loop, name="relay-heartbeat", daemon=True)
        heartbeat_thread.start()
        try:
            while not self.stop_event.is_set():
                try: self.run_once()
                except RelayError as error: self.logger.warning("poll failed: %s", redact(str(error), self.config.agent_key))
                self.stop_event.wait(self.config.poll_interval_seconds)
        finally:
            self._heartbeat_stop.set(); heartbeat_thread.join(timeout=2)
            try: self.client.heartbeat("offline")
            except RelayError: pass


def redact(value: str, secret: str) -> str:
    if secret: value = value.replace(secret, "[REDACTED]")
    for marker in ("github_pat_", "ghp_", "sk-"):
        if marker in value:
            start = value.find(marker); value = value[:start] + marker + "[REDACTED]"
    return value


def configure_logging(path: str | None, secret: str) -> logging.Logger:
    logger = logging.getLogger("relay-agent"); logger.setLevel(logging.INFO); logger.handlers.clear()
    handler: logging.Handler = logging.FileHandler(path, encoding="utf-8") if path else logging.StreamHandler()
    if path:
        _secure_file(Path(path))
    class RedactingFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            return redact(super().format(record), secret)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(message)s")); logger.addHandler(handler)
    return logger


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the restricted local AI Relay Agent")
    parser.add_argument("--config", required=True, help="local JSON configuration outside the repository")
    parser.add_argument("--once", action="store_true", help="heartbeat, claim and execute at most one task")
    parser.add_argument("--log-file", help="optional UTF-8 log path")
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    config = AgentConfig.from_file(config_path)
    log_path = args.log_file
    if log_path and not Path(log_path).expanduser().is_absolute():
        log_path = str((config_path.parent / Path(log_path)).resolve())
    logger = configure_logging(log_path, config.agent_key)
    agent = RelayAgent(config, logger=logger)
    signal.signal(signal.SIGINT, agent.stop)
    if hasattr(signal, "SIGTERM"): signal.signal(signal.SIGTERM, agent.stop)
    try:
        if args.once: agent.run_once()
        else: agent.run_forever()
    except (ValueError, RelayError, OSError) as error:
        logger.error("agent stopped: %s", redact(str(error), config.agent_key)); return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
