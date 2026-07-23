# Учебный стенд Patroni + PostgreSQL

Этот проект помогает изучать отказоустойчивый кластер PostgreSQL под управлением Patroni. В стенде есть два узла PostgreSQL, один экземпляр etcd, HAProxy как точка входа, учебное приложение с рабочей базой данных и дашборд с курсом.

Docker здесь используется для удобства: стенд можно быстро поднять на одном компьютере, сломать, пересоздать и снова проверить. В реальной эксплуатации Patroni, PostgreSQL, DCS и точку входа обычно разворачивают на отдельных серверах или виртуальных машинах и отдельно проектируют хранение данных, сеть, безопасность и резервное копирование.

## Что входит в стенд

```text
demo-app -> HAProxy -> PostgreSQL primary
                 \-> PostgreSQL replica

Patroni на db1/db2 хранит состояние и лидерскую блокировку в etcd.
Дашборд читает Patroni REST API и API etcd, чтобы показать состояние кластера.
```

Сервисы:

- `etcd` — DCS для Patroni: хранит состояние участников, динамическую конфигурацию и лидерскую блокировку.
- `db1`, `db2` — узлы PostgreSQL под управлением Patroni.
- `haproxy` — точка входа: порт `5000` для записи на primary, порт `5001` для чтения с replica.
- `demo-init` — одноразовая подготовка базы `helpdesk` и пользователя приложения.
- `demo-app` — учебное приложение, которое создаёт нагрузку через HAProxy.
- `dashboard` — дашборд состояния и учебный курс.

## Требования для запуска

Нужны Docker и Docker Compose v2:

```bash
docker --version
docker compose version
```

Команды в README используют `make` как короткую обёртку над Docker Compose. Если `make` не установлен, можно выполнять команды напрямую:

```bash
docker compose up -d --build
docker compose down
docker compose down -v
```

При первой сборке нужен доступ в интернет: Docker скачивает базовые образы, образ etcd, образ HAProxy, пакеты Debian, PostgreSQL из PGDG-репозитория и Python-зависимости для Patroni и demo-app.

## Быстрый запуск

```bash
make up
```

После запуска откройте:

- дашборд и учебный курс: http://127.0.0.1:8088
- учебное приложение: http://127.0.0.1:8090

Проверить состояние контейнеров:

```bash
make ps
```

Смотреть логи:

```bash
make logs
```

## Управление стендом

```bash
make up       # поднять стенд с пересборкой образов
make down     # остановить стенд, не удаляя данные
make restart  # остановить и снова поднять стенд
make reset    # удалить данные и поднять стенд заново
make ps       # показать состояние контейнеров
make logs     # смотреть логи
```

`make reset` удаляет volumes PostgreSQL и etcd. Используйте эту команду, когда нужно вернуться к чистому состоянию.

## Проверка Patroni

Основной инструмент администратора Patroni — `patronictl`. В учебном стенде его можно запускать внутри любого доступного узла:

```bash
docker compose exec db1 patronictl -c /etc/patroni/config.yml list
docker compose exec db1 patronictl -c /etc/patroni/config.yml topology
docker compose exec db1 patronictl -c /etc/patroni/config.yml history
```

Если `db1` недоступен, используйте `db2`.

## Конфигурация

Основные файлы находятся в каталоге `config/`:

- `config/patroni.yml` — базовая конфигурация Patroni, смонтированная в контейнеры как `/etc/patroni/config.yml`.
- `config/db1.env`, `config/db2.env` — уникальные параметры узлов Patroni.
- `config/etcd.env` — параметры etcd.
- `config/haproxy.cfg` — маршрутизация записи и чтения через HAProxy.
- `config/demo.env` — параметры подключения учебного приложения к базе.
- `config/dashboard.env` — источники данных для дашборда.

Конфигурацию стенда можно использовать как отправную точку для собственного учебного окружения. Перед переносом в другую среду нужно осознанно изменить адреса, каталоги данных, учётные записи, правила доступа, параметры DCS, точку входа и требования безопасности.

## Сети

В Compose используются две сети:

- `cluster` — служебная сеть для Patroni, PostgreSQL, etcd, HAProxy и дашборда.
- `client` — сеть клиентского доступа; учебное приложение видит HAProxy, но не обращается напрямую к `db1`, `db2` и `etcd`.

С хоста опубликованы только учебные веб-интерфейсы:

- `127.0.0.1:8088` — дашборд;
- `127.0.0.1:8090` — учебное приложение.

## Учебные эксперименты

Примеры простых проверок:

```bash
docker compose stop db1
docker compose start db1
docker compose stop db2
docker compose start db2
docker compose stop etcd
docker compose start etcd
```

После каждого эксперимента смотрите дашборд, учебное приложение и вывод `patronictl list`. Это помогает связать теорию курса с реальным состоянием кластера.

## Тесты

Для запуска стенда локальные Node.js и Python-зависимости не нужны: приложение и дашборд запускаются внутри контейнеров. Они нужны только для тестов вне контейнеров.

Проверки дашборда и учебных материалов требуют Node.js. Внешних npm-пакетов нет, используются встроенные модули Node:

```bash
node --test dashboard/tests/course-data.test.js dashboard/tests/dashboard-copy.test.js
```

Python-тесты demo-app требуют `psycopg`. Его можно установить из файла зависимостей приложения:

```bash
python -m pip install -r demo-app/requirements.txt
```

После этого можно запускать Python-тесты серверной части:

```bash
python -m unittest discover dashboard/tests
python -m unittest discover demo-app/tests
```
