CREATE TABLE IF NOT EXISTS tickets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_key uuid NOT NULL UNIQUE,
    title varchar(160) NOT NULL,
    description text NOT NULL DEFAULT '',
    priority varchar(16) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high')),
    status varchar(24) NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'in_progress', 'done')),
    assignee varchar(80),
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    committed_by inet DEFAULT inet_server_addr(),
    transaction_id bigint NOT NULL DEFAULT txid_current()
);

CREATE TABLE IF NOT EXISTS ticket_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_type varchar(24) NOT NULL
        CHECK (event_type IN ('created', 'status_changed', 'comment')),
    actor varchar(80) NOT NULL,
    details text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    committed_by inet DEFAULT inet_server_addr(),
    transaction_id bigint NOT NULL DEFAULT txid_current()
);

CREATE INDEX IF NOT EXISTS tickets_status_updated_idx
    ON tickets (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS ticket_events_ticket_created_idx
    ON ticket_events (ticket_id, created_at);

INSERT INTO tickets (request_key, title, description, priority, status, assignee)
VALUES
    ('10000000-0000-4000-8000-000000000001', 'Проверить свободное место', 'На сервере отчётов осталось менее 15% свободного места.', 'high', 'new', NULL),
    ('10000000-0000-4000-8000-000000000002', 'Обновить сертификат VPN', 'Срок действия сертификата истекает на следующей неделе.', 'normal', 'in_progress', 'Анна'),
    ('10000000-0000-4000-8000-000000000003', 'Создать учётную запись', 'Подготовить доступ новому сотруднику отдела поддержки.', 'low', 'done', 'Максим')
ON CONFLICT (request_key) DO NOTHING;

INSERT INTO ticket_events (ticket_id, event_type, actor, details)
SELECT id, 'created', 'Система', 'Начальная заявка учебного стенда'
FROM tickets AS ticket
WHERE ticket.request_key IN (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003'
)
AND NOT EXISTS (
    SELECT 1
    FROM ticket_events AS event
    WHERE event.ticket_id = ticket.id AND event.event_type = 'created'
);
