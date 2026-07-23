.PHONY: up down restart reset ps logs

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose down
	docker compose up -d --build

reset:
	docker compose down -v
	docker compose up -d --build

ps:
	docker compose ps

logs:
	docker compose logs -f --tail=100
