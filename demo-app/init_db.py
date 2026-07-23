import os
import time
from pathlib import Path

import psycopg
from psycopg import sql


DB_HOST = os.getenv("DEMO_DB_HOST", "haproxy")
DB_PORT = int(os.getenv("DEMO_DB_WRITE_PORT", "5000"))
ADMIN_USER = os.getenv("DEMO_DB_ADMIN_USER", "postgres")
ADMIN_PASSWORD = os.getenv("DEMO_DB_ADMIN_PASSWORD", "postgres")
APP_DB = os.getenv("DEMO_DB_NAME", "helpdesk")
APP_USER = os.getenv("DEMO_DB_USER", "helpdesk_app")
APP_PASSWORD = os.getenv("DEMO_DB_PASSWORD", "helpdesk")
RETRY_SECONDS = float(os.getenv("DEMO_DB_INIT_RETRY_SECONDS", "2"))
MAX_ATTEMPTS = int(os.getenv("DEMO_DB_INIT_ATTEMPTS", "60"))
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connection_parameters(database, user, password):
    return {
        "host": DB_HOST,
        "port": DB_PORT,
        "dbname": database,
        "user": user,
        "password": password,
        "connect_timeout": 3,
        "application_name": "helpdesk-init",
    }


def wait_for_primary():
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with psycopg.connect(
                **connection_parameters("postgres", ADMIN_USER, ADMIN_PASSWORD),
                autocommit=True,
            ) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT NOT pg_is_in_recovery()")
                    if cursor.fetchone()[0]:
                        return
        except psycopg.Error as error:
            print(f"Primary is not ready ({attempt}/{MAX_ATTEMPTS}): {error}", flush=True)
        time.sleep(RETRY_SECONDS)
    raise RuntimeError("Primary did not become available in time")


def ensure_role_and_database():
    with psycopg.connect(
        **connection_parameters("postgres", ADMIN_USER, ADMIN_PASSWORD),
        autocommit=True,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_USER,))
            if cursor.fetchone():
                cursor.execute(
                    sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                        sql.Identifier(APP_USER),
                        sql.Literal(APP_PASSWORD),
                    )
                )
            else:
                cursor.execute(
                    sql.SQL("CREATE ROLE {} WITH LOGIN PASSWORD {}").format(
                        sql.Identifier(APP_USER),
                        sql.Literal(APP_PASSWORD),
                    )
                )

            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (APP_DB,))
            if not cursor.fetchone():
                cursor.execute(
                    sql.SQL("CREATE DATABASE {} OWNER {}").format(
                        sql.Identifier(APP_DB),
                        sql.Identifier(APP_USER),
                    )
                )


def apply_schema():
    with psycopg.connect(
        **connection_parameters(APP_DB, APP_USER, APP_PASSWORD),
        autocommit=True,
    ) as connection:
        connection.execute(SCHEMA_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    wait_for_primary()
    ensure_role_and_database()
    apply_schema()
    print(f"Database {APP_DB} is ready for the helpdesk application", flush=True)
