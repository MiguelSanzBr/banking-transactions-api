.PHONY: up down test lint

up:
	docker compose up --build

down:
	docker compose down

test:
	npm test

lint:
	npm run lint
