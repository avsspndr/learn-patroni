import concurrent.futures
import json
import os
import random
import re
import threading
import time
import uuid
from collections import deque
from datetime import date, datetime
from decimal import Decimal
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row


STATIC_DIR = Path(__file__).parent / "static"
LISTEN_HOST = os.getenv("DEMO_APP_HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("DEMO_APP_PORT", "8080"))
DB_HOST = os.getenv("DEMO_DB_HOST", "haproxy")
WRITE_PORT = int(os.getenv("DEMO_DB_WRITE_PORT", "5000"))
READ_PORT = int(os.getenv("DEMO_DB_READ_PORT", "5001"))
DB_NAME = os.getenv("DEMO_DB_NAME", "helpdesk")
DB_USER = os.getenv("DEMO_DB_USER", "helpdesk_app")
DB_PASSWORD = os.getenv("DEMO_DB_PASSWORD", "helpdesk")
CONNECT_TIMEOUT = int(os.getenv("DEMO_DB_CONNECT_TIMEOUT", "3"))
SIMULATION_INTERVAL = float(os.getenv("DEMO_SIMULATION_INTERVAL", "6"))

STATUSES = {"new", "in_progress", "done"}
STATUS_NAMES = {"new": "Новая", "in_progress": "В работе", "done": "Выполнена"}
PRIORITIES = {"low", "normal", "high"}
TITLE_LIMIT = 160
TEXT_LIMIT = 2000
ACTOR_LIMIT = 80
TICKET_PATH = re.compile(r"^/api/tickets/(\d+)$")
COMMENT_PATH = re.compile(r"^/api/tickets/(\d+)/comments$")
STATUS_PATH = re.compile(r"^/api/tickets/(\d+)/status$")

OPERATION_LOG = deque(maxlen=80)
OPERATION_LOCK = threading.Lock()
SIMULATION_LOCK = threading.Lock()
SIMULATION_ENABLED = False
SIMULATION_STEP = 0

SIMULATED_TICKETS = [
    ("Проверить резервное копирование", "В ночном отчёте нет отметки об успешной копии.", "high"),
    ("Добавить доступ к репозиторию", "Новому сотруднику требуется доступ только для чтения.", "normal"),
    ("Обновить пакет на тестовом сервере", "Нужно проверить обновление до установки в рабочей среде.", "low"),
    ("Разобрать предупреждение мониторинга", "Время ответа внутреннего сервиса превысило порог.", "normal"),
    ("Проверить срок действия сертификата", "Мониторинг сообщает о скором окончании срока действия.", "high"),
]


class ValidationError(Exception):
    pass


def database_parameters(port, purpose):
    return {
        "host": DB_HOST,
        "port": port,
        "dbname": DB_NAME,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "connect_timeout": CONNECT_TIMEOUT,
        "application_name": f"helpdesk-{purpose}",
    }


def connect_write():
    return psycopg.connect(**database_parameters(WRITE_PORT, "write"), row_factory=dict_row)


def connect_read():
    return psycopg.connect(**database_parameters(READ_PORT, "report"), row_factory=dict_row)


def json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (uuid.UUID, Decimal)):
        return str(value)
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def instance_info(cursor):
    cursor.execute(
        """
        SELECT
            host(inet_server_addr()) AS server_address,
            inet_server_port() AS server_port,
            pg_is_in_recovery() AS in_recovery,
            current_setting('transaction_read_only') = 'on' AS read_only,
            current_setting('server_version') AS server_version,
            clock_timestamp() AS database_time
        """
    )
    return cursor.fetchone()


def validate_text(value, field, *, minimum=1, maximum=TEXT_LIMIT):
    value = str(value or "").strip()
    if len(value) < minimum:
        raise ValidationError(f"Поле «{field}» необходимо заполнить")
    if len(value) > maximum:
        raise ValidationError(f"Поле «{field}» не должно превышать {maximum} символов")
    return value


def normalize_request_key(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValidationError("Некорректный идентификатор запроса") from error


def board_snapshot():
    started = time.monotonic()
    with connect_write() as connection:
        with connection.cursor() as cursor:
            identity = instance_info(cursor)
            cursor.execute(
                """
                SELECT ticket.id, ticket.request_key, ticket.title, ticket.description,
                       ticket.priority, ticket.status, ticket.assignee, ticket.version,
                       ticket.created_at, ticket.updated_at, host(ticket.committed_by) AS committed_by,
                       ticket.transaction_id,
                       count(event.id) AS event_count
                FROM tickets AS ticket
                LEFT JOIN ticket_events AS event ON event.ticket_id = ticket.id
                GROUP BY ticket.id
                ORDER BY ticket.updated_at DESC, ticket.id DESC
                LIMIT 120
                """
            )
            tickets = cursor.fetchall()
    return {
        "tickets": tickets,
        "database": identity,
        "route": {"name": "запись и рабочее чтение", "host": DB_HOST, "port": WRITE_PORT},
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
    }


def report_snapshot():
    started = time.monotonic()
    with connect_read() as connection:
        with connection.cursor() as cursor:
            identity = instance_info(cursor)
            cursor.execute(
                """
                SELECT
                    count(*) AS total,
                    count(*) FILTER (WHERE status = 'new') AS new,
                    count(*) FILTER (WHERE status = 'in_progress') AS in_progress,
                    count(*) FILTER (WHERE status = 'done') AS done,
                    count(*) FILTER (WHERE priority = 'high' AND status <> 'done') AS urgent_open,
                    max(updated_at) AS data_updated_at
                FROM tickets
                """
            )
            summary = cursor.fetchone()
            cursor.execute(
                """
                SELECT coalesce(assignee, 'Не назначен') AS assignee, count(*) AS ticket_count
                FROM tickets
                WHERE status <> 'done'
                GROUP BY coalesce(assignee, 'Не назначен')
                ORDER BY ticket_count DESC, assignee
                LIMIT 6
                """
            )
            assignees = cursor.fetchall()
    return {
        "summary": summary,
        "assignees": assignees,
        "database": identity,
        "route": {"name": "отчёт с реплики", "host": DB_HOST, "port": READ_PORT},
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
    }


def ticket_details(ticket_id):
    with connect_write() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, request_key, title, description, priority, status, assignee,
                       version, created_at, updated_at, host(committed_by) AS committed_by, transaction_id
                FROM tickets WHERE id = %s
                """,
                (ticket_id,),
            )
            ticket = cursor.fetchone()
            if ticket is None:
                return None
            cursor.execute(
                """
                SELECT id, event_type, actor, details, created_at,
                       host(committed_by) AS committed_by, transaction_id
                FROM ticket_events
                WHERE ticket_id = %s
                ORDER BY created_at DESC, id DESC
                """,
                (ticket_id,),
            )
            events = cursor.fetchall()
    return {"ticket": ticket, "events": events}


def create_ticket(payload, *, actor="Пользователь"):
    title = validate_text(payload.get("title"), "Тема", maximum=TITLE_LIMIT)
    description = validate_text(payload.get("description"), "Описание", maximum=TEXT_LIMIT)
    priority = str(payload.get("priority") or "normal")
    if priority not in PRIORITIES:
        raise ValidationError("Неизвестный приоритет заявки")
    request_key = normalize_request_key(payload.get("request_key") or uuid.uuid4())
    actor = validate_text(actor, "Автор", maximum=ACTOR_LIMIT)

    created = False
    with connect_write() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO tickets (request_key, title, description, priority)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (request_key) DO NOTHING
                RETURNING id, request_key, title, description, priority, status, assignee,
                          version, created_at, updated_at, host(committed_by) AS committed_by, transaction_id
                """,
                (request_key, title, description, priority),
            )
            ticket = cursor.fetchone()
            if ticket is not None:
                created = True
                cursor.execute(
                    """
                    INSERT INTO ticket_events (ticket_id, event_type, actor, details)
                    VALUES (%s, 'created', %s, %s)
                    """,
                    (ticket["id"], actor, "Заявка создана"),
                )
            else:
                cursor.execute(
                    """
                    SELECT id, request_key, title, description, priority, status, assignee,
                           version, created_at, updated_at, host(committed_by) AS committed_by, transaction_id
                    FROM tickets WHERE request_key = %s
                    """,
                    (request_key,),
                )
                ticket = cursor.fetchone()
    return {"ticket": ticket, "created": created, "request_key": request_key}


def change_status(ticket_id, payload, *, actor="Пользователь"):
    status = str(payload.get("status") or "")
    if status not in STATUSES:
        raise ValidationError("Неизвестное состояние заявки")
    assignee = str(payload.get("assignee") or "").strip() or None
    if assignee and len(assignee) > ACTOR_LIMIT:
        raise ValidationError(f"Имя исполнителя не должно превышать {ACTOR_LIMIT} символов")
    actor = validate_text(actor, "Автор", maximum=ACTOR_LIMIT)

    with connect_write() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT status, assignee FROM tickets WHERE id = %s FOR UPDATE", (ticket_id,))
            previous = cursor.fetchone()
            if previous is None:
                return None
            cursor.execute(
                """
                UPDATE tickets
                SET status = %s, assignee = %s, version = version + 1,
                    updated_at = clock_timestamp(), committed_by = inet_server_addr(),
                    transaction_id = txid_current()
                WHERE id = %s
                RETURNING id, request_key, title, description, priority, status, assignee,
                          version, created_at, updated_at, host(committed_by) AS committed_by, transaction_id
                """,
                (status, assignee, ticket_id),
            )
            ticket = cursor.fetchone()
            details = (
                f"Состояние: {STATUS_NAMES[previous['status']]} → {STATUS_NAMES[status]}; "
                f"исполнитель: {assignee or 'не назначен'}"
            )
            cursor.execute(
                """
                INSERT INTO ticket_events (ticket_id, event_type, actor, details)
                VALUES (%s, 'status_changed', %s, %s)
                """,
                (ticket_id, actor, details),
            )
    return ticket


def add_comment(ticket_id, payload, *, actor="Пользователь"):
    comment = validate_text(payload.get("comment"), "Комментарий", maximum=TEXT_LIMIT)
    actor = validate_text(payload.get("actor") or actor, "Автор", maximum=ACTOR_LIMIT)
    with connect_write() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE tickets
                SET version = version + 1, updated_at = clock_timestamp(),
                    committed_by = inet_server_addr(), transaction_id = txid_current()
                WHERE id = %s
                RETURNING id
                """,
                (ticket_id,),
            )
            if cursor.fetchone() is None:
                return None
            cursor.execute(
                """
                INSERT INTO ticket_events (ticket_id, event_type, actor, details)
                VALUES (%s, 'comment', %s, %s)
                RETURNING id, event_type, actor, details, created_at,
                          host(committed_by) AS committed_by, transaction_id
                """,
                (ticket_id, actor, comment),
            )
            event = cursor.fetchone()
    return event


def probe_database(connector, route_name, port):
    started = time.monotonic()
    try:
        with connector() as connection:
            with connection.cursor() as cursor:
                identity = instance_info(cursor)
        return {
            "available": True,
            "route": route_name,
            "host": DB_HOST,
            "port": port,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "database": identity,
        }
    except psycopg.Error:
        return {
            "available": False,
            "route": route_name,
            "host": DB_HOST,
            "port": port,
            "latency_ms": None,
            "message": "Маршрут базы данных сейчас не отвечает",
        }


def application_status():
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        write_future = executor.submit(probe_database, connect_write, "Запись", WRITE_PORT)
        read_future = executor.submit(probe_database, connect_read, "Отчёт", READ_PORT)
        write = write_future.result()
        read = read_future.result()
    with SIMULATION_LOCK:
        simulation_enabled = SIMULATION_ENABLED
    return {"write": write, "read": read, "simulation_enabled": simulation_enabled}


def record_operation(kind, ok, message, *, duration_ms=None):
    with OPERATION_LOCK:
        OPERATION_LOG.appendleft({
            "timestamp": datetime.now().astimezone().isoformat(),
            "kind": kind,
            "ok": ok,
            "message": message,
            "duration_ms": duration_ms,
        })


def activity_snapshot():
    with OPERATION_LOCK:
        operations = list(OPERATION_LOG)
    with SIMULATION_LOCK:
        enabled = SIMULATION_ENABLED
    return {
        "enabled": enabled,
        "operations": operations,
        "successes": sum(1 for item in operations if item["ok"]),
        "failures": sum(1 for item in operations if not item["ok"]),
    }


def simulate_once():
    global SIMULATION_STEP
    started = time.monotonic()
    step = SIMULATION_STEP
    SIMULATION_STEP += 1
    try:
        if step % 3 == 0:
            title, description, priority = SIMULATED_TICKETS[(step // 3) % len(SIMULATED_TICKETS)]
            result = create_ticket(
                {
                    "request_key": str(uuid.uuid4()),
                    "title": title,
                    "description": description,
                    "priority": priority,
                },
                actor="Учебный оператор",
            )
            message = f"Создана заявка №{result['ticket']['id']}: {title}"
            kind = "create"
        else:
            with connect_write() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT id, status FROM tickets
                        WHERE status <> 'done'
                        ORDER BY updated_at, id
                        LIMIT 1
                        """
                    )
                    candidate = cursor.fetchone()
            if candidate is None:
                SIMULATION_STEP = 0
                return simulate_once()
            next_status = "in_progress" if candidate["status"] == "new" else "done"
            ticket = change_status(
                candidate["id"],
                {"status": next_status, "assignee": random.choice(["Анна", "Максим", "Олег"])},
                actor="Учебный оператор",
            )
            message = f"Заявка №{ticket['id']} переведена в состояние «{STATUS_NAMES[next_status]}»"
            kind = "transition"
        record_operation(kind, True, message, duration_ms=round((time.monotonic() - started) * 1000, 1))
    except (psycopg.Error, ValidationError) as error:
        record_operation(
            "database_error",
            False,
            "Операция не выполнена: маршрут записи недоступен или соединение было разорвано",
            duration_ms=round((time.monotonic() - started) * 1000, 1),
        )
        print(f"Simulation database error: {error}", flush=True)


def simulation_worker():
    while True:
        with SIMULATION_LOCK:
            enabled = SIMULATION_ENABLED
        if enabled:
            simulate_once()
        time.sleep(SIMULATION_INTERVAL)


def set_simulation(enabled):
    global SIMULATION_ENABLED
    with SIMULATION_LOCK:
        SIMULATION_ENABLED = bool(enabled)
    record_operation(
        "simulation",
        True,
        "Имитация работы операторов включена" if enabled else "Имитация работы операторов остановлена",
    )
    return activity_snapshot()


class HelpdeskHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, message_format, *args):
        print(f"{self.address_string()} - {message_format % args}", flush=True)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=json_value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = min(int(self.headers.get("Content-Length", "0")), 32768)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def handle_api_error(self, error):
        if isinstance(error, ValidationError):
            self.send_json({"ok": False, "message": str(error)}, 400)
        elif isinstance(error, json.JSONDecodeError):
            self.send_json({"ok": False, "message": "Запрос содержит некорректный JSON"}, 400)
        elif isinstance(error, psycopg.Error):
            print(f"Database request failed: {error}", flush=True)
            self.send_json({
                "ok": False,
                "message": "База данных временно недоступна. Результат незавершённой операции следует проверить перед повтором.",
            }, 503)
        else:
            raise error

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/health":
                self.send_json({"status": "ok"})
                return
            if path == "/api/status":
                self.send_json(application_status())
                return
            if path == "/api/board":
                self.send_json(board_snapshot())
                return
            if path == "/api/report":
                self.send_json(report_snapshot())
                return
            if path == "/api/activity":
                self.send_json(activity_snapshot())
                return
            ticket_match = TICKET_PATH.match(path)
            if ticket_match:
                result = ticket_details(int(ticket_match.group(1)))
                if result is None:
                    self.send_json({"ok": False, "message": "Заявка не найдена"}, 404)
                else:
                    self.send_json(result)
                return
        except (psycopg.Error, ValidationError, json.JSONDecodeError) as error:
            self.handle_api_error(error)
            return

        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/tickets":
                result = create_ticket(payload)
                record_operation(
                    "create",
                    True,
                    f"Заявка №{result['ticket']['id']} создана" if result["created"] else f"Повторный запрос: заявка №{result['ticket']['id']} уже существует",
                )
                self.send_json(result, 201 if result["created"] else 200)
                return

            status_match = STATUS_PATH.match(path)
            if status_match:
                result = change_status(int(status_match.group(1)), payload)
                if result is None:
                    self.send_json({"ok": False, "message": "Заявка не найдена"}, 404)
                else:
                    record_operation("transition", True, f"Состояние заявки №{result['id']} изменено")
                    self.send_json({"ticket": result})
                return

            comment_match = COMMENT_PATH.match(path)
            if comment_match:
                result = add_comment(int(comment_match.group(1)), payload)
                if result is None:
                    self.send_json({"ok": False, "message": "Заявка не найдена"}, 404)
                else:
                    record_operation("comment", True, f"К заявке №{comment_match.group(1)} добавлен комментарий")
                    self.send_json({"event": result}, 201)
                return

            if path == "/api/simulation":
                if self.headers.get("X-Demo-App") != "control":
                    self.send_json({"ok": False, "message": "Не указан заголовок управления"}, 403)
                    return
                self.send_json(set_simulation(bool(payload.get("enabled"))))
                return

            self.send_json({"ok": False, "message": "Путь API не найден"}, 404)
        except (psycopg.Error, ValidationError, json.JSONDecodeError) as error:
            record_operation("request_error", False, "Прикладная операция завершилась ошибкой")
            self.handle_api_error(error)


if __name__ == "__main__":
    worker = threading.Thread(target=simulation_worker, name="helpdesk-simulation", daemon=True)
    worker.start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), HelpdeskHandler)
    print(f"Helpdesk demo application listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    server.serve_forever()
