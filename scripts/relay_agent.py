"""Local AI Relay Agent for restricted Codex CLI task execution.

The agent is intentionally pull-based. It never accepts a remote absolute path
or builds a shell command from task text. The Worker remains the authority for
conversation state, approval and task leases.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import shutil
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
    allow_workspace_write: bool = False

    @classmethod
    def from_file(cls, path: Path) -> "AgentConfig":
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
            state_file=str(data.get("state_file", "relay_agent_state.json")),
            retry_file=str(data.get("retry_file", "relay_agent_outbox.json")),
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


def execute_codex(config: AgentConfig, task: dict[str, Any], timeout: int | None = None) -> dict[str, Any]:
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
    process = subprocess.Popen(command, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", shell=False)
    try:
        stdout, stderr = process.communicate(timeout=timeout or config.max_task_seconds)
        timed_out = False
    except subprocess.TimeoutExpired as error:
        process.kill()
        stdout, stderr = process.communicate()
        stdout = (error.stdout or "") + stdout
        stderr = (error.stderr or "") + stderr
        timed_out = True
    duration = round(time.monotonic() - started, 3)
    summary = (stdout or stderr).strip()[-10000:]
    if timed_out:
        return {"status": "timed_out", "result_summary": summary, "error": "Codex CLI timed out", "error_code": "timeout", "duration_seconds": duration}
    if process.returncode != 0:
        return {"status": "failed", "result_summary": summary, "error": f"Codex CLI exited with {process.returncode}", "error_code": "codex_exit", "duration_seconds": duration}
    return {"status": "succeeded", "result_summary": summary, "result": {"stdout": stdout[-20000:], "stderr": stderr[-5000:]}, "duration_seconds": duration}


class RelayAgent:
    def __init__(self, config: AgentConfig, client: WorkerClient | Any | None = None, runner: Callable[[AgentConfig, dict[str, Any], int | None], dict[str, Any]] = execute_codex, logger: logging.Logger | None = None):
        self.config = config
        self.client = client or WorkerClient(config)
        self.runner = runner
        self.logger = logger or logging.getLogger("relay-agent")
        self.stop_event = threading.Event()
        self._heartbeat_stop = threading.Event()
        self._renew_stop = threading.Event()
        self.state_path = Path(config.state_file).expanduser()
        self.retry_path = Path(config.retry_file).expanduser()

    def stop(self, *_args: Any) -> None:
        self.stop_event.set()

    def _load_queue(self) -> list[dict[str, Any]]:
        if not self.retry_path.exists(): return []
        try:
            value = json.loads(self.retry_path.read_text(encoding="utf-8"))
            return value if isinstance(value, list) else []
        except (OSError, ValueError):
            return []

    def _save_queue(self, queue: list[dict[str, Any]]) -> None:
        self.retry_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.retry_path.with_suffix(self.retry_path.suffix + ".tmp")
        temporary.write_text(json.dumps(queue[-20:], ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.retry_path)

    def _retry_results(self) -> None:
        queue = self._load_queue()
        remaining: list[dict[str, Any]] = []
        for item in queue:
            try:
                self.client.result(item["task"], item["result"])
            except RelayError as error:
                if error.status != 409: remaining.append(item)
        if len(remaining) != len(queue): self._save_queue(remaining)

    def _save_active(self, task: dict[str, Any] | None) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        if task is None:
            try: self.state_path.unlink()
            except FileNotFoundError: pass
            return
        # The lease token is local operational state, never logged or committed.
        self.state_path.write_text(json.dumps({"task_id": task.get("task_id"), "saved_at": time.time()}, ensure_ascii=False), encoding="utf-8")

    def _renew_loop(self, task: dict[str, Any]) -> None:
        wait_seconds = max(10, min(self.config.lease_seconds // 3, 120))
        while not self._renew_stop.wait(wait_seconds):
            try: self.client.renew(task)
            except RelayError as error: self.logger.warning("lease renewal failed for %s: %s", task.get("task_id"), redact(str(error), self.config.agent_key))

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
        self._renew_stop.clear(); renew_thread.start()
        try:
            self.client.ack(task)
            result = self.runner(self.config, task, self.config.max_task_seconds)
            self.client.result(task, result)
        except (RelayError, OSError, ValueError) as error:
            self.logger.error("task %s failed: %s", task.get("task_id"), redact(str(error), self.config.agent_key))
            if isinstance(error, RelayError) and error.status == 409:
                pass
            else:
                result = {"status": "failed", "result_summary": "本地 Agent 无法提交任务结果。", "error": str(error), "error_code": "agent_error"}
                queue = self._load_queue(); queue.append({"task": task, "result": result}); self._save_queue(queue)
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
    config = AgentConfig.from_file(Path(args.config).resolve())
    logger = configure_logging(args.log_file, config.agent_key)
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
